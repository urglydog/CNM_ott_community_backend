const path = require("path");
const crypto = require("crypto");
const vm = require("vm");
const dotenv = require("dotenv");
const axios = require("axios");
const cheerio = require("cheerio");
const puppeteer = require("puppeteer");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { QdrantClient } = require("@qdrant/js-client-rest");

dotenv.config({
  path:
    process.env.DOTENV_PATH || path.join(__dirname, "..", "..", ".env"),
});

const SOURCE_URL =
  process.env.ZALO_POLICY_SOURCE_URL ||
  "https://help.zalo.me/huong-dan/chuyen-muc/chinh-sach-cong-dong-zalo/";
const COLLECTION_NAME = process.env.ZALO_POLICY_QDRANT_COLLECTION || "policy_collection";
const EMBEDDING_DIMENSION = Number(
  process.env.ZALO_POLICY_EMBEDDING_DIMENSION || 3072,
);
const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GOOGLE_GEMINI_API_KEY;
const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const TARGET_CHUNK_LENGTH = 500;
const MAX_CHUNK_LENGTH = 520;
const RENDER_FALLBACK_URL = `https://r.jina.ai/http://${SOURCE_URL}`;
const DOC_SOURCE_KEY =
  "@site/docs/social-api/tham-khao/chinh-sach-nen-tang-cua-zalo.md";
const DOCUSAURUS_MAIN_JS_URL =
  "https://stc-developers.zdn.vn/docs/assets/js/main.80025e05.js";
const DOCUSAURUS_RUNTIME_JS_URL =
  "https://stc-developers.zdn.vn/docs/assets/js/runtime~main.38c0322a.js";
const CONTENT_SELECTORS = [
  "article p",
  "article li",
  "article h2",
  "article h3",
  ".markdown-body p",
  ".markdown-body li",
  ".markdown-body h2",
  ".markdown-body h3",
  "main p",
  "main li",
  "main h2",
  "main h3",
  "body p",
  "body li",
  "body h2",
  "body h3",
];
const LEGACY_SOURCE_URLS = [
  "https://developers.zalo.me/docs/social-api/tham-khao/chinh-sach-nen-tang-cua-zalo",
  "https://help.zalo.me/huong-dan/chuyen-muc/chinh-sach-cong-dong-zalo/",
];
const IS_DOCUSAURUS_SOURCE = SOURCE_URL.includes("developers.zalo.me/docs");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function shouldKeepSegment(text) {
  const normalized = cleanText(text);
  if (!normalized) return false;
  if (normalized === "Contents") return false;
  if (/^\d+\s+\d+\./.test(normalized)) return false;
  if (/^\d+\s+[A-ZÀ-Ỹ]/u.test(normalized) && normalized.length < 140) return false;
  return true;
}

function formatUuidFromHex(hex) {
  const normalized = String(hex || "").replace(/[^a-f0-9]/gi, "").padEnd(32, "0");
  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20, 32),
  ].join("-");
}

function buildPointId(chunk, index) {
  const hash = crypto
    .createHash("sha1")
    .update(`${SOURCE_URL}:${index + 1}:${chunk}`)
    .digest("hex");
  return formatUuidFromHex(hash);
}

function describeError(error) {
  return {
    message: error?.message || String(error),
    status: error?.status || error?.response?.status || null,
    statusText: error?.statusText || error?.response?.statusText || null,
    data:
      error?.data ||
      error?.response?.data ||
      (typeof error?.getActualType === "function" ? error.getActualType() : null),
  };
}

function normalizeEmbeddingModelName(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "gemini-embedding-001";
  }

  if (normalized === "embedding-001") {
    return "gemini-embedding-001";
  }

  return normalized;
}

const EMBEDDING_MODEL = normalizeEmbeddingModelName(
  process.env.ZALO_POLICY_EMBEDDING_MODEL ||
    process.env.GEMINI_EMBEDDING_MODEL ||
    "gemini-embedding-001",
);

function splitIntoSentences(text) {
  const normalized = cleanText(text);
  if (!normalized) return [];

  const sentences = normalized.match(/[^.!?\n]+(?:[.!?]+|$)/g) || [normalized];
  return sentences.map((item) => cleanText(item)).filter(Boolean);
}

function chunkText(
  text,
  minLength = TARGET_CHUNK_LENGTH,
  maxLength = MAX_CHUNK_LENGTH,
) {
  const sentences = splitIntoSentences(text);
  const chunks = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    if (!sentence) continue;

    if (!currentChunk) {
      currentChunk = sentence;
      continue;
    }

    const candidate = `${currentChunk} ${sentence}`.trim();
    if (candidate.length <= maxLength) {
      currentChunk = candidate;
      continue;
    }

    if (currentChunk.length >= minLength) {
      chunks.push(currentChunk);
      currentChunk = sentence;
      continue;
    }

    const words = sentence.split(/\s+/).filter(Boolean);
    for (const word of words) {
      const padded = `${currentChunk} ${word}`.trim();
      if (padded.length > maxLength && currentChunk) {
        chunks.push(currentChunk);
        currentChunk = word;
      } else {
        currentChunk = padded;
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks.map((item) => cleanText(item)).filter(Boolean);
}

function extractTextNodes($, selectors = CONTENT_SELECTORS) {
  const segments = [];
  const seen = new Set();

  $(selectors.join(", ")).each((_, element) => {
    const text = cleanText($(element).text());
    if (!shouldKeepSegment(text)) return;

    const key = `${element.tagName || element.name || "node"}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    segments.push(text);
  });

  return cleanText(segments.join("\n"));
}

function countContentNodes($, selectors = CONTENT_SELECTORS) {
  return $(selectors.join(", ")).length;
}

function convertMarkdownToHtml(markdownText) {
  const lines = String(markdownText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const htmlParts = ['<div class="markdown-body">'];

  for (const line of lines) {
    if (/^###\s+/.test(line)) {
      htmlParts.push(`<h3>${line.replace(/^###\s+/, "")}</h3>`);
      continue;
    }

    if (/^##\s+/.test(line)) {
      htmlParts.push(`<h2>${line.replace(/^##\s+/, "")}</h2>`);
      continue;
    }

    if (/^[*-]\s+/.test(line)) {
      htmlParts.push(`<li>${line.replace(/^[*-]\s+/, "")}</li>`);
      continue;
    }

    htmlParts.push(`<p>${line}</p>`);
  }

  htmlParts.push("</div>");
  return htmlParts.join("");
}

function flattenTreeText(node, segments = []) {
  if (node == null) {
    return segments;
  }

  if (typeof node === "string") {
    const text = cleanText(node);
    if (text) {
      segments.push(text);
    }
    return segments;
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      flattenTreeText(child, segments);
    }
    return segments;
  }

  if (typeof node === "object") {
    if (typeof node.type === "string") {
      const targetTags = new Set(["h1", "h2", "h3", "p", "li", "td", "th"]);
      if (targetTags.has(node.type)) {
        const textParts = [];
        flattenTreeText(node.children || [], textParts);
        const joined = cleanText(textParts.join(" "));
        if (joined) {
          segments.push(joined);
        }
        return segments;
      }
    }

    flattenTreeText(node.children || [], segments);
  }

  return segments;
}

function createMdxRuntimeStub() {
  const stub = {};

  stub.Zo = ({ children }) => children;
  stub.kt = (type, props, ...children) => {
    if (typeof type === "function") {
      return type({ ...(props || {}), children });
    }

    return {
      type,
      props: props || {},
      children,
    };
  };

  return stub;
}

function buildChunkUrl(chunkId, chunkNameMap, chunkHashMap) {
  const namePart = chunkNameMap[chunkId];
  const hashPart = chunkHashMap[chunkId];
  if (!namePart || !hashPart) {
    throw new Error(`Không tìm thấy mapping asset cho chunk ${chunkId}`);
  }

  return `https://stc-developers.zdn.vn/docs/assets/js/${namePart}.${hashPart}.js`;
}

function parseMainBundleForDoc(mainBundleText) {
  const sourceIndex = mainBundleText.indexOf(DOC_SOURCE_KEY);
  if (sourceIndex < 0) {
    throw new Error("Không tìm thấy module markdown của trang chính sách trong main bundle");
  }

  const beforeSource = mainBundleText.slice(Math.max(0, sourceIndex - 300), sourceIndex);
  const afterSource = mainBundleText.slice(
    sourceIndex,
    Math.min(mainBundleText.length, sourceIndex + DOC_SOURCE_KEY.length + 80),
  );
  const routeMatch = beforeSource.match(/"([a-f0-9]+)":\[[^\[]*$/);
  const chunkMatch = beforeSource.match(/t\.e\((\d+)\)[^\[]*$/);
  const moduleMatch = afterSource.match(/,\s*(\d+)\]/);

  if (!routeMatch || !chunkMatch || !moduleMatch) {
    throw new Error("Không parse được route/chunk/module id từ main bundle");
  }

  return {
    routeKey: routeMatch[1],
    chunkId: chunkMatch[1],
    moduleId: moduleMatch[1],
  };
}

function parseRuntimeChunkMaps(runtimeBundleText) {
  const mapRegex = /(\d+):"([a-f0-9]+)"/g;
  const matches = [...runtimeBundleText.matchAll(mapRegex)];
  const mid = Math.floor(matches.length / 2);
  const chunkNameMap = {};
  const chunkHashMap = {};

  for (const match of matches.slice(0, mid)) {
    chunkNameMap[match[1]] = match[2];
  }

  for (const match of matches.slice(mid)) {
    chunkHashMap[match[1]] = match[2];
  }

  return { chunkNameMap, chunkHashMap };
}

function extractDocusaurusModuleExports(chunkSource, moduleId) {
  const captured = {};
  const sandbox = {
    self: {
      webpackChunkzalo_developer_docs: {
        push(payload) {
          Object.assign(captured, payload[1] || {});
        },
      },
    },
  };

  vm.runInNewContext(chunkSource, sandbox, { timeout: 5000 });

  const moduleFactory = captured[moduleId];
  if (typeof moduleFactory !== "function") {
    throw new Error(`Không tìm thấy module ${moduleId} trong chunk JS`);
  }

  const module = { exports: {} };
  const exportsObject = module.exports;
  const runtime = (requestedId) => {
    if (requestedId === 7462) {
      return {
        Z: (...args) => Object.assign({}, ...args),
      };
    }

    if (requestedId === 7294) {
      return {};
    }

    if (requestedId === 3905) {
      return createMdxRuntimeStub();
    }

    throw new Error(`Unsupported module dependency: ${requestedId}`);
  };

  runtime.r = (target) => {
    Object.defineProperty(target, "__esModule", { value: true });
  };

  runtime.d = (target, definition) => {
    for (const key of Object.keys(definition)) {
      Object.defineProperty(target, key, {
        enumerable: true,
        get: definition[key],
      });
    }
  };

  moduleFactory(module, exportsObject, runtime);
  return module.exports;
}

async function fetchDocusaurusRenderedText() {
  try {
    console.log(
      "[ingestZaloPolicy] Đang đọc trực tiếp bundle markdown của Docusaurus...",
    );

    const [mainResponse, runtimeResponse] = await Promise.all([
      axios.get(DOCUSAURUS_MAIN_JS_URL, {
        timeout: 30000,
        headers: { "User-Agent": "Mozilla/5.0" },
      }),
      axios.get(DOCUSAURUS_RUNTIME_JS_URL, {
        timeout: 30000,
        headers: { "User-Agent": "Mozilla/5.0" },
      }),
    ]);

    const { chunkId, moduleId } = parseMainBundleForDoc(String(mainResponse.data || ""));
    const { chunkNameMap, chunkHashMap } = parseRuntimeChunkMaps(
      String(runtimeResponse.data || ""),
    );
    const chunkUrl = buildChunkUrl(chunkId, chunkNameMap, chunkHashMap);

    console.log(`[ingestZaloPolicy] Tìm thấy chunk markdown: ${chunkUrl}`);

    const chunkResponse = await axios.get(chunkUrl, {
      timeout: 30000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const exportsObject = extractDocusaurusModuleExports(
      String(chunkResponse.data || ""),
      Number(moduleId),
    );

    if (typeof exportsObject.default !== "function") {
      throw new Error("Module markdown không export hàm render hợp lệ");
    }

    const tree = exportsObject.default({});
    const segments = flattenTreeText(tree, []);
    console.log(
      `[ingestZaloPolicy] Docusaurus bundle trích xuất được ${segments.length} đoạn nội dung`,
    );

    return cleanText(segments.join("\n"));
  } catch (error) {
    console.warn(
      "[ingestZaloPolicy] Docusaurus bundle fallback thất bại:",
      error.message,
    );
    return "";
  }
}

async function fetchPolicyText() {
  console.log("[ingestZaloPolicy] Đang cào dữ liệu...");

  const response = await axios.get(SOURCE_URL, {
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  const $ = cheerio.load(response.data);
  $("script, style, nav, footer, header, aside, noscript").remove();
  const htmlNodeCount = countContentNodes($);
  console.log(
    `[ingestZaloPolicy] HTML trực tiếp match ${htmlNodeCount} node nội dung theo selector cheerio`,
  );

  const collectedHtmlText = extractTextNodes($);
  if (collectedHtmlText.length >= TARGET_CHUNK_LENGTH) {
    console.log(
      `[ingestZaloPolicy] Đã cào xong từ HTML trực tiếp, độ dài nội dung: ${collectedHtmlText.length} ký tự`,
    );
    return collectedHtmlText;
  }

  console.warn(
    "[ingestZaloPolicy] HTML trực tiếp không chứa đủ nội dung, đang thử nguồn render fallback...",
  );

  if (IS_DOCUSAURUS_SOURCE) {
    const docusaurusBundleText = await fetchDocusaurusRenderedText();
    if (
      docusaurusBundleText.length >= TARGET_CHUNK_LENGTH &&
      !looksLikeShellContent(docusaurusBundleText)
    ) {
      console.log(
        `[ingestZaloPolicy] Đã lấy nội dung từ Docusaurus bundle, độ dài: ${docusaurusBundleText.length} ký tự`,
      );
      return docusaurusBundleText;
    }
  }

  const browserRenderedText = await fetchBrowserRenderedText();
  if (
    browserRenderedText.length >= TARGET_CHUNK_LENGTH &&
    !looksLikeShellContent(browserRenderedText)
  ) {
    console.log(
      `[ingestZaloPolicy] Đã lấy nội dung từ headless browser, độ dài: ${browserRenderedText.length} ký tự`,
    );
    return browserRenderedText;
  }

  if (browserRenderedText) {
    console.warn(
      "[ingestZaloPolicy] Headless browser chỉ lấy được shell/navigation, tiếp tục fallback...",
    );
  }

  const renderedFallback = await fetchRenderedFallbackText();
  if (
    renderedFallback.length >= TARGET_CHUNK_LENGTH &&
    !looksLikeShellContent(renderedFallback)
  ) {
    console.log(
      `[ingestZaloPolicy] Đã lấy nội dung từ render fallback, độ dài: ${renderedFallback.length} ký tự`,
    );
    return renderedFallback;
  }

  if (renderedFallback) {
    console.warn(
      "[ingestZaloPolicy] Render fallback chỉ chứa shell/navigation, bỏ qua.",
    );
  }

  const metadataFallback = extractMetadataFallback($);
  if (metadataFallback.length >= 50) {
    console.warn(
      `[ingestZaloPolicy] Chỉ lấy được metadata summary, độ dài: ${metadataFallback.length} ký tự`,
    );
    return metadataFallback;
  }

  throw new Error("Không trích xuất được nội dung chính từ trang Zalo");
}

function extractMetadataFallback($) {
  return cleanText(
    [
      $("meta[property='og:title']").attr("content"),
      $("title").text(),
      $("meta[property='og:description']").attr("content"),
      $("meta[name='description']").attr("content"),
      SOURCE_URL,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function looksLikeShellContent(text) {
  const normalized = cleanText(text).toLowerCase();
  if (!normalized) return true;

  const shellSignals = [
    "đăng nhập",
    "xem tất cả",
    "chia sẻ cookie",
    "api explorer",
    "token debugger",
  ];
  const contentSignals = [
    "các điều khoản",
    "thoả thuận",
    "nhà phát triển",
    "công ty cổ phần vng",
  ];

  const shellScore = shellSignals.filter((item) =>
    normalized.includes(item),
  ).length;
  const contentScore = contentSignals.filter((item) =>
    normalized.includes(item),
  ).length;

  return shellScore >= 2 && contentScore === 0;
}

async function fetchBrowserRenderedText() {
  let browser;

  try {
    console.log(
      "[ingestZaloPolicy] Đang render trang bằng headless browser để lấy nội dung SPA...",
    );

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0 Safari/537.36",
    );
    await page.goto(SOURCE_URL, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });
    await page.waitForSelector("body", { timeout: 10000 });
    await sleep(3000);

    const html = await page.content();
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, aside, noscript").remove();

    const browserNodeCount = countContentNodes($);
    console.log(
      `[ingestZaloPolicy] Headless browser match ${browserNodeCount} node nội dung theo selector cheerio`,
    );

    return extractTextNodes($);
  } catch (error) {
    console.warn(
      "[ingestZaloPolicy] Headless browser fallback thất bại:",
      error.message,
    );
    return "";
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function fetchRenderedFallbackText() {
  try {
    const response = await axios.get(RENDER_FALLBACK_URL, {
      timeout: 30000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/plain,text/markdown,text/html",
      },
    });

    const raw = String(response.data || "");
    const markdownIndex = raw.indexOf("Markdown Content:");
    const body = markdownIndex >= 0 ? raw.slice(markdownIndex + "Markdown Content:".length) : raw;
    const cleaned = cleanText(
      body
        .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/^Title:\s.*$/gim, " ")
        .replace(/^URL Source:\s.*$/gim, " ")
        .replace(/^Markdown Content:\s*$/gim, " ")
        .replace(/^Powered by.*$/gim, " ")
        .replace(/^Original text.*$/gim, " ")
        .replace(/^Rate this translation.*$/gim, " ")
        .replace(/^Your feedback will be used.*$/gim, " "),
    );

    const fallbackHtml = convertMarkdownToHtml(cleaned);
    const fallback$ = cheerio.load(fallbackHtml);
    const fallbackNodeCount = countContentNodes(fallback$);
    console.log(
      `[ingestZaloPolicy] Render fallback match ${fallbackNodeCount} node nội dung theo selector cheerio`,
    );
    return extractTextNodes(fallback$);
  } catch (error) {
    console.warn(
      "[ingestZaloPolicy] Render fallback thất bại:",
      error.message,
    );
    return "";
  }
}

function createGeminiClient() {
  if (!GEMINI_API_KEY) {
    throw new Error("Thiếu GEMINI_API_KEY để tạo embeddings");
  }

  return new GoogleGenerativeAI(GEMINI_API_KEY);
}

function createQdrantClient() {
  if (!QDRANT_URL) {
    throw new Error("Thiếu QDRANT_URL để kết nối Qdrant");
  }

  return new QdrantClient({
    url: QDRANT_URL,
    apiKey: QDRANT_API_KEY || undefined,
  });
}

async function ensureCollection(client) {
  console.log(
    `[ingestZaloPolicy] Kiểm tra collection "${COLLECTION_NAME}" trên Qdrant...`,
  );

  const exists = await client.collectionExists(COLLECTION_NAME);
  if (!exists.exists) {
    console.log(
      `[ingestZaloPolicy] Collection chưa tồn tại, đang tạo mới với vector size ${EMBEDDING_DIMENSION}...`,
    );
    await client.createCollection(COLLECTION_NAME, {
      vectors: {
        size: EMBEDDING_DIMENSION,
        distance: "Cosine",
      },
    });
    return;
  }

  const info = await client.getCollection(COLLECTION_NAME);
  const actualSize = info?.config?.params?.vectors?.size;
  if (actualSize && Number(actualSize) !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Collection "${COLLECTION_NAME}" đang có vector size ${actualSize}, không khớp ${EMBEDDING_DIMENSION}`,
    );
  }

  console.log(`[ingestZaloPolicy] Collection "${COLLECTION_NAME}" đã sẵn sàng.`);
}

async function deleteSourcePoints(client) {
  const uniqueSources = [...new Set([SOURCE_URL, ...LEGACY_SOURCE_URLS])];

  for (const source of uniqueSources) {
    console.log(
      `[ingestZaloPolicy] Xóa dữ liệu cũ theo source trước khi ingest: ${source}`,
    );
    const idsToDelete = [];
    let nextPageOffset = null;

    do {
      const page = await client.scroll(COLLECTION_NAME, {
        limit: 100,
        offset: nextPageOffset,
        with_payload: true,
        with_vector: false,
      });

      const points = page?.points || [];
      for (const point of points) {
        if (point?.payload?.source === source) {
          idsToDelete.push(point.id);
        }
      }

      nextPageOffset = page?.next_page_offset || null;
    } while (nextPageOffset);

    if (!idsToDelete.length) {
      continue;
    }

    console.log(
      `[ingestZaloPolicy] Tìm thấy ${idsToDelete.length} point cũ cần xóa cho source này`,
    );

    await client.delete(COLLECTION_NAME, {
      wait: true,
      points: idsToDelete,
    });
  }
}

async function embedChunk(genAI, chunk, index, total) {
  console.log(
    `[ingestZaloPolicy] Đang tạo vector... (${index + 1}/${total})`,
  );

  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  const result = await model.embedContent({
    content: {
      parts: [{ text: chunk }],
    },
    taskType: "RETRIEVAL_DOCUMENT",
    outputDimensionality: EMBEDDING_DIMENSION,
  });

  const vector = result?.embedding?.values || [];
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(`Không tạo được embedding cho chunk ${index + 1}`);
  }

  if (vector.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Chunk ${index + 1} trả về vector ${vector.length} chiều, expected ${EMBEDDING_DIMENSION}`,
    );
  }

  return vector;
}

async function upsertChunks(client, genAI, chunks) {
  const points = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const vector = await embedChunk(genAI, chunk, index, chunks.length);

    points.push({
      id: buildPointId(chunk, index),
      vector,
      payload: {
        content: chunk,
        source: SOURCE_URL,
        chunkIndex: index + 1,
      },
    });
  }

  console.log(
    `[ingestZaloPolicy] Đang upsert ${points.length} vectors vào Qdrant...`,
  );

  await client.upsert(COLLECTION_NAME, {
    wait: true,
    points,
  });
}

async function main() {
  try {
    console.log("[ingestZaloPolicy] Bắt đầu ingest chính sách Zalo...");
    console.log(
      `[ingestZaloPolicy] Embedding model: ${EMBEDDING_MODEL}, dimension: ${EMBEDDING_DIMENSION}`,
    );
    if (EMBEDDING_MODEL === "text-embedding-004" && EMBEDDING_DIMENSION !== 768) {
      console.warn(
        "[ingestZaloPolicy] Cảnh báo: text-embedding-004 thường trả về 768 chiều. Nếu bạn cần 3072 chiều, hãy dùng gemini-embedding-001 hoặc gemini-embedding-2.",
      );
    }

    const policyText = await fetchPolicyText();
    const chunks = chunkText(policyText);

    if (chunks.length === 0) {
      throw new Error("Không tạo được chunk nào từ nội dung chính sách");
    }

    console.log(
      `[ingestZaloPolicy] Đã chia thành ${chunks.length} chunks (~${TARGET_CHUNK_LENGTH} ký tự/chunk)...`,
    );

    const genAI = createGeminiClient();
    const qdrantClient = createQdrantClient();

    await ensureCollection(qdrantClient);
    await deleteSourcePoints(qdrantClient);
    await upsertChunks(qdrantClient, genAI, chunks);

    console.log("[ingestZaloPolicy] Đã lưu vào Qdrant thành công!");
    console.log(
      `[ingestZaloPolicy] Nguồn dữ liệu: ${SOURCE_URL}\n[ingestZaloPolicy] Collection: ${COLLECTION_NAME}`,
    );
  } catch (error) {
    console.error("[ingestZaloPolicy] Script thất bại:", error.message);
    console.error(
      "[ingestZaloPolicy] Chi tiết lỗi:",
      JSON.stringify(describeError(error), null, 2),
    );
    process.exitCode = 1;
  }
}

main();
