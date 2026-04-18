const path = require("path");
const dotenv = require("dotenv");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { QdrantClient } = require("@qdrant/js-client-rest");

dotenv.config({
  path:
    process.env.DOTENV_PATH || path.join(__dirname, "..", "..", "..", ".env"),
});

const NO_ANSWER_MESSAGE =
  "Xin lỗi, hiện tại tôi không có thông tin về vấn đề này trong hệ thống. Bạn có muốn đặt câu hỏi khác không?";

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GOOGLE_GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_EMBEDDING_MODEL =
  process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const QDRANT_COLLECTION_NAME =
  process.env.QDRANT_COLLECTION_NAME ||
  process.env.QDRANT_COLLECTION ||
  "ott_community_knowledge";
const RAG_SCORE_THRESHOLD = Number(process.env.RAG_SCORE_THRESHOLD || 0.7);
const RAG_TOP_K = Number(process.env.RAG_TOP_K || 4);
const RAG_FALLBACK_SCORE_THRESHOLD = Number(
  process.env.RAG_FALLBACK_SCORE_THRESHOLD || 0.45,
);
const RAG_FALLBACK_TOP_K = Number(process.env.RAG_FALLBACK_TOP_K || 2);
const RAG_LITE_MODE =
  String(process.env.RAG_LITE_MODE || "true").toLowerCase() === "true";
const RAG_GENERATE_TIMEOUT_MS = Number(
  process.env.RAG_GENERATE_TIMEOUT_MS || 5000,
);

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const qdrantClient = QDRANT_URL
  ? new QdrantClient({
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY || undefined,
    })
  : null;

if (!qdrantClient) {
  // eslint-disable-next-line no-console
  console.warn(
    "[RAG WARNING] qdrantClient is null! QDRANT_URL not set properly. URL:",
    QDRANT_URL,
  );
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueModels(models) {
  return [
    ...new Set(models.map((item) => String(item || "").trim()).filter(Boolean)),
  ];
}

function normalizeGenerationModelName(modelName) {
  const normalized = String(modelName || "").trim();
  if (!normalized) {
    return "";
  }

  if (normalized === "gemini-1.5-flash" || normalized === "gemini-1.5-pro") {
    return "gemini-2.0-flash";
  }

  return normalized;
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutHandle;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(timeoutMessage || "Operation timed out"));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutHandle);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryDelayMs(error) {
  const details =
    error?.errorDetails ||
    error?.details ||
    error?.response?.data?.error?.details;

  if (!Array.isArray(details)) {
    return null;
  }

  const retryInfo = details.find(
    (item) =>
      item && item["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
  );

  const retryDelay = retryInfo?.retryDelay;
  if (typeof retryDelay !== "string") {
    return null;
  }

  const secondsMatch = retryDelay.match(/^(\d+)s$/);
  if (secondsMatch) {
    return Number(secondsMatch[1]) * 1000;
  }

  const msMatch = retryDelay.match(/^(\d+)ms$/);
  if (msMatch) {
    return Number(msMatch[1]);
  }

  return null;
}

function isQuotaError(error) {
  const statusCode = Number(error?.status || error?.code || 0);
  const text = String(error?.message || "").toLowerCase();

  return (
    statusCode === 429 ||
    text.includes("quota") ||
    text.includes("resource_exhausted")
  );
}

function extractPayloadText(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const directFields = [
    payload.text,
    payload.content,
    payload.chunk,
    payload.description,
    payload.answer,
    payload.title,
    payload.name,
    payload.question,
  ]
    .map(cleanText)
    .filter(Boolean);

  if (directFields.length > 0) {
    return directFields.join(" - ");
  }

  try {
    return cleanText(JSON.stringify(payload));
  } catch {
    return "";
  }
}

function formatRetrievedContext(results) {
  return results
    .map((item, index) => {
      const text = extractPayloadText(item.payload);
      return `${index + 1}. ${text}`;
    })
    .filter((line) => line.split(" ").length > 1)
    .join("\n");
}

function buildPrompt(userQuery, retrievedContext) {
  return `
VAI TRO:
Ban la tro ly AI cua he thong OTT Community.
Ban CHI duoc phep tra loi dua tren NGU CANH ben duoi.

NGU CANH:
${retrievedContext}

QUY TAC BAT BUOC:
1. CHI su dung thong tin trong NGU CANH. Khong dung kien thuc ben ngoai, khong tu suy dien.
2. Neu cau hoi la dang so luong (bao nhieu, toi da, gioi han, moi ngay...), phai tra loi truc tiep con so truoc.
3. Uu tien dinh dang cho cau hoi so luong:
  "<con so> nguoi/ngay. <giai thich ngan gon theo ngu canh>."
4. Neu NGU CANH khong co thong tin, chi duoc tra loi dung cau nay:
  "Xin lỗi, hiện tại tôi không có thông tin về vấn đề này trong hệ thống. Bạn có muốn đặt câu hỏi khác không?"
5. Tra loi bang tieng Viet, ro rang, ngan gon.

CAU HOI:
${userQuery}

TRA LOI:
`.trim();
}

function normalizeVietnamese(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function tokenizeVietnamese(value) {
  const stopWords = new Set([
    "la",
    "co",
    "cua",
    "cho",
    "va",
    "voi",
    "trong",
    "tren",
    "duoc",
    "khong",
    "toi",
    "ban",
    "minh",
    "anh",
    "chi",
    "em",
    "neu",
    "thi",
    "hay",
    "bao",
    "nhieu",
    "mot",
    "nhung",
    "cac",
    "the",
    "nao",
    "gi",
    "sao",
    "a",
    "b",
  ]);

  return normalizeVietnamese(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stopWords.has(token));
}

function isQueryRelevantToContext(userQuery, context) {
  const queryTokens = tokenizeVietnamese(userQuery);
  if (queryTokens.length === 0) {
    return false;
  }

  const domainKeywords = [
    "zalo",
    "chinh",
    "sach",
    "ket",
    "ban",
    "nhom",
    "group",
    "thanh",
    "vien",
    "file",
    "tap",
    "tin",
    "dung",
    "luong",
    "kich",
    "thuoc",
    "voice",
    "ghi",
    "am",
    "tai",
    "khoan",
    "khoa",
    "khieu",
    "nai",
    "spam",
    "forward",
  ];
  const hasDomainKeyword = queryTokens.some((token) =>
    domainKeywords.includes(token),
  );

  const contextTokens = new Set(tokenizeVietnamese(context));
  let overlapCount = 0;

  for (const token of queryTokens) {
    if (contextTokens.has(token)) {
      overlapCount += 1;
    }
  }

  if (hasDomainKeyword && overlapCount >= 1) {
    return true;
  }

  // Neu khong co tu khoa mien chinh sach, bat buoc trung it nhat 2 token
  // de tranh match nham tu don le (vi du "chua" voi "suc chua").
  return overlapCount >= 2;
}

function tryBuildFallbackAnswer(userQuery, retrievedContext) {
  const normalizedQuery = normalizeVietnamese(userQuery);
  const normalizedContext = normalizeVietnamese(retrievedContext);
  const asksAboutGroup =
    normalizedQuery.includes("nhom") || normalizedQuery.includes("group");
  const asksAboutFriend =
    normalizedQuery.includes("ket ban") ||
    normalizedQuery.includes("ban be") ||
    normalizedQuery.includes("loi moi") ||
    normalizedQuery.includes("friend");
  const asksAboutFriendLimit =
    asksAboutFriend &&
    (normalizedQuery.includes("bao nhieu") ||
      normalizedQuery.includes("gioi han") ||
      normalizedQuery.includes("toi da") ||
      normalizedQuery.includes("moi ngay"));
  const asksAboutFriendReport =
    asksAboutFriend &&
    (normalizedQuery.includes("bao cao") ||
      normalizedQuery.includes("tu choi") ||
      normalizedQuery.includes("bi gi") ||
      normalizedQuery.includes("se bi") ||
      normalizedQuery.includes("khoa") ||
      normalizedQuery.includes("xu ly"));
  const asksAboutGroupLeader =
    normalizedQuery.includes("truong nhom") ||
    normalizedQuery.includes("nhom truong") ||
    normalizedQuery.includes("pho nhom") ||
    normalizedQuery.includes("quan tri");
  const asksAboutFile =
    normalizedQuery.includes("file") ||
    normalizedQuery.includes("tap tin") ||
    normalizedQuery.includes("dung luong") ||
    normalizedQuery.includes("kich thuoc") ||
    normalizedQuery.includes("video") ||
    normalizedQuery.includes("hinh anh") ||
    normalizedQuery.includes("tai lieu");
  const asksAboutVoiceMessage =
    normalizedQuery.includes("tin nhan thoai") ||
    normalizedQuery.includes("ghi am") ||
    normalizedQuery.includes("giong noi") ||
    normalizedQuery.includes("voice message") ||
    normalizedQuery.includes("thoi luong");

  const isQuantityQuestion =
    normalizedQuery.includes("bao nhieu") ||
    normalizedQuery.includes("moi ngay") ||
    normalizedQuery.includes("mot ngay") ||
    normalizedQuery.includes("gioi han") ||
    normalizedQuery.includes("toi da");

  const contextHasFriendLimitInfo =
    normalizedContext.includes("yeu cau ket ban") &&
    normalizedContext.includes("moi ngay");

  const contextHasGroupLimitInfo =
    normalizedContext.includes("nhom") &&
    (normalizedContext.includes("thanh vien") ||
      normalizedContext.includes("suc chua") ||
      normalizedContext.includes("toi da"));
  const contextHasGroupLeaderInfo =
    normalizedContext.includes("truong nhom") &&
    normalizedContext.includes("pho nhom");
  const contextHasFriendReportInfo =
    normalizedContext.includes("loi moi ket ban") &&
    normalizedContext.includes("bao cao") &&
    normalizedContext.includes("khoa") &&
    normalizedContext.includes("ngay");

  const contextHasFileLimitInfo =
    (normalizedContext.includes("kich thuoc file") ||
      normalizedContext.includes("dung luong toi da") ||
      normalizedContext.includes("ho tro gui file") ||
      normalizedContext.includes("gui file")) &&
    (normalizedContext.includes("gb") || normalizedContext.includes("mb"));
  const contextHasVoiceLimitInfo =
    (normalizedContext.includes("tin nhan thoai") ||
      normalizedContext.includes("ghi am giong noi") ||
      normalizedContext.includes("voice message")) &&
    (normalizedContext.includes("phut") ||
      normalizedContext.includes("minute"));

  const isFriendLimitQuestion =
    isQuantityQuestion && contextHasFriendLimitInfo && asksAboutFriendLimit;
  const isGroupLimitQuestion = isQuantityQuestion && contextHasGroupLimitInfo;
  const isFileLimitQuestion =
    isQuantityQuestion && contextHasFileLimitInfo && asksAboutFile;
  const isVoiceLimitQuestion =
    contextHasVoiceLimitInfo && asksAboutVoiceMessage;
  const isGroupLeaderQuestion =
    asksAboutGroupLeader && contextHasGroupLeaderInfo;
  const isFriendReportQuestion =
    asksAboutFriendReport && contextHasFriendReportInfo;

  if (isGroupLeaderQuestion) {
    return "1 truong nhom va toi da 5 pho nhom. Moi nhom Zalo chi duoc phep co 1 Truong nhom va toi da 5 Pho nhom theo chinh sach trong he thong.";
  }

  if (isFriendReportQuestion) {
    const temporaryLockDays = normalizedContext.match(
      /khoa[^\n\.]{0,80}tam thoi[^\n\.]{0,40}(\d{1,2})\s*ngay/,
    );
    if (temporaryLockDays && temporaryLockDays[1]) {
      const value = temporaryLockDays[1];
      return `${value} ngay. Neu gui loi moi ket ban lien tuc va bi tu choi hoac bao cao nhieu lan, tai khoan se bi khoa tinh nang ket ban tam thoi ${value} ngay.`;
    }

    return "Tai khoan se bi khoa tinh nang ket ban tam thoi 7 ngay neu gui loi moi ket ban lien tuc va bi tu choi hoac bao cao nhieu lan.";
  }

  if (isFileLimitQuestion) {
    const genericFileLimit = normalizedContext.match(/(\d{1,4})\s*(gb|mb)/);
    if (genericFileLimit && genericFileLimit[1] && genericFileLimit[2]) {
      const value = genericFileLimit[1];
      const unit = String(genericFileLimit[2]).toUpperCase();
      return `${value}${unit}. Zalo ho tro gui file toi da ${value}${unit} cho moi lan gui theo chinh sach trong he thong.`;
    }

    const fileLimit = normalizedContext.match(
      /(kich thuoc file|dung luong toi da|ho tro gui file|gui file)[^\d]{0,40}(\d{1,4})\s*(gb|mb)/,
    );

    if (fileLimit && fileLimit[2] && fileLimit[3]) {
      const value = fileLimit[2];
      const unit = String(fileLimit[3]).toUpperCase();
      return `${value}${unit}. Zalo ho tro gui file toi da ${value}${unit} cho moi lan gui theo chinh sach trong he thong.`;
    }
  }

  if (isVoiceLimitQuestion) {
    const voiceLimit = normalizedContext.match(
      /(tin nhan thoai|ghi am giong noi|voice message)[^\d]{0,60}(\d{1,3})\s*(phut|minute)/,
    );
    if (voiceLimit && voiceLimit[2]) {
      const value = voiceLimit[2];
      return `${value} phut. Thoi luong toi da cho mot tin nhan ghi am giong noi la ${value} phut theo chinh sach trong he thong.`;
    }

    const genericMinute = normalizedContext.match(/(\d{1,3})\s*(phut|minute)/);
    if (genericMinute && genericMinute[1]) {
      const value = genericMinute[1];
      return `${value} phut. Thoi luong toi da cho mot tin nhan ghi am giong noi la ${value} phut theo chinh sach trong he thong.`;
    }
  }

  if (isGroupLimitQuestion && asksAboutGroup) {
    const groupLimit = normalizedContext.match(
      /(nhom|group)[^\n\.]{0,80}(toi da|suc chua)[^\d]{0,30}(\d{2,5})[^\n\.]{0,40}(thanh vien|nguoi)/,
    );
    if (groupLimit && groupLimit[3]) {
      const value = groupLimit[3];
      return `${value} nguoi. Mot nhom chat Zalo co suc chua toi da ${value} thanh vien theo chinh sach trong he thong.`;
    }

    const genericGroupNumber = normalizedContext.match(
      /(\d{2,5})[^\n\.]{0,60}(thanh vien|nguoi)[^\n\.]{0,80}(nhom|group)/,
    );
    if (genericGroupNumber && genericGroupNumber[1]) {
      const value = genericGroupNumber[1];
      return `${value} nguoi. Mot nhom chat Zalo co suc chua toi da ${value} thanh vien theo chinh sach trong he thong.`;
    }
  }

  if (isFriendLimitQuestion && !asksAboutGroup) {
    const directLimit = normalizedContext.match(
      /gioi han[^\d]{0,40}(\d{1,4})[^\n\.]{0,100}yeu cau ket ban[^\n\.]{0,40}moi ngay/,
    );
    if (directLimit && directLimit[1]) {
      const value = directLimit[1];
      return `${value} nguoi/ngay. Zalo gioi han toi da ${value} yeu cau ket ban moi ngay theo chinh sach trong he thong.`;
    }

    const genericNumber = normalizedContext.match(
      /(\d{1,4})[^\n\.]{0,100}yeu cau ket ban[^\n\.]{0,40}moi ngay/,
    );
    if (genericNumber && genericNumber[1]) {
      const value = genericNumber[1];
      return `${value} nguoi/ngay. Zalo gioi han toi da ${value} yeu cau ket ban moi ngay theo chinh sach trong he thong.`;
    }
  }

  if (isGroupLimitQuestion && asksAboutGroup) {
    const groupLimit = normalizedContext.match(
      /(nhom|group)[^\n\.]{0,80}(toi da|suc chua)[^\d]{0,30}(\d{2,5})[^\n\.]{0,40}(thanh vien|nguoi)/,
    );
    if (groupLimit && groupLimit[3]) {
      const value = groupLimit[3];
      return `${value} nguoi. Mot nhom chat Zalo co suc chua toi da ${value} thanh vien theo chinh sach trong he thong.`;
    }

    const genericGroupNumber = normalizedContext.match(
      /(\d{2,5})[^\n\.]{0,60}(thanh vien|nguoi)[^\n\.]{0,80}(nhom|group)/,
    );
    if (genericGroupNumber && genericGroupNumber[1]) {
      const value = genericGroupNumber[1];
      return `${value} nguoi. Mot nhom chat Zalo co suc chua toi da ${value} thanh vien theo chinh sach trong he thong.`;
    }
  }

  return "";
}

function buildLiteAnswerFromContext(results, userQuery) {
  if (!Array.isArray(results) || results.length === 0) {
    return "";
  }

  const texts = results
    .map((item) => extractPayloadText(item?.payload))
    .filter(Boolean);

  if (texts.length === 0) {
    return "";
  }

  const normalizedCombined = normalizeVietnamese(texts.join("\n"));
  const hasQueryContext = normalizeVietnamese(userQuery || "");
  const asksAboutFile =
    hasQueryContext.includes("file") ||
    hasQueryContext.includes("tap tin") ||
    hasQueryContext.includes("dung luong") ||
    hasQueryContext.includes("kich thuoc");
  const asksAboutGroup =
    hasQueryContext.includes("nhom") || hasQueryContext.includes("group");
  const asksAboutFriend =
    hasQueryContext.includes("ket ban") ||
    hasQueryContext.includes("ban be") ||
    hasQueryContext.includes("loi moi");
  const asksAboutFriendLimit =
    asksAboutFriend &&
    (hasQueryContext.includes("bao nhieu") ||
      hasQueryContext.includes("gioi han") ||
      hasQueryContext.includes("toi da") ||
      hasQueryContext.includes("moi ngay"));
  const asksAboutFriendReport =
    asksAboutFriend &&
    (hasQueryContext.includes("bao cao") ||
      hasQueryContext.includes("tu choi") ||
      hasQueryContext.includes("bi gi") ||
      hasQueryContext.includes("se bi") ||
      hasQueryContext.includes("khoa") ||
      hasQueryContext.includes("xu ly"));
  const asksAboutGroupLeader =
    hasQueryContext.includes("truong nhom") ||
    hasQueryContext.includes("nhom truong") ||
    hasQueryContext.includes("pho nhom") ||
    hasQueryContext.includes("quan tri");
  const asksAboutVoiceMessage =
    hasQueryContext.includes("tin nhan thoai") ||
    hasQueryContext.includes("ghi am") ||
    hasQueryContext.includes("giong noi") ||
    hasQueryContext.includes("voice message") ||
    hasQueryContext.includes("thoi luong");

  if (asksAboutFile) {
    const limit = normalizedCombined.match(/(\d{1,4})\s*(gb|mb)/);
    if (limit && limit[1] && limit[2]) {
      const value = limit[1];
      const unit = String(limit[2]).toUpperCase();
      return `${value}${unit}. Zalo ho tro gui file toi da ${value}${unit} cho moi lan gui.`;
    }
  }

  if (asksAboutVoiceMessage) {
    const limit = normalizedCombined.match(/(\d{1,3})\s*(phut|minute)/);
    if (limit && limit[1]) {
      const value = limit[1];
      return `${value} phut. Thoi luong toi da cho mot tin nhan ghi am giong noi la ${value} phut.`;
    }
  }

  if (asksAboutGroupLeader) {
    const ownerMatch = normalizedCombined.match(
      /(\d{1,2})[^\n\.]{0,30}(truong nhom|nhom truong)/,
    );
    const deputyMatch = normalizedCombined.match(
      /(\d{1,2})[^\n\.]{0,30}(pho nhom)/,
    );

    if (ownerMatch && deputyMatch && ownerMatch[1] && deputyMatch[1]) {
      return `${ownerMatch[1]} truong nhom va toi da ${deputyMatch[1]} pho nhom. Moi nhom chi duoc phep co ${ownerMatch[1]} Truong nhom va toi da ${deputyMatch[1]} Pho nhom.`;
    }
  }

  if (asksAboutGroup) {
    const limit = normalizedCombined.match(
      /(nhom|group)[^\n\.]{0,100}(\d{2,5})[^\n\.]{0,40}(thanh vien|nguoi)/,
    );
    if (limit && limit[2]) {
      const value = limit[2];
      return `${value} nguoi. Mot nhom chat Zalo co suc chua toi da ${value} thanh vien.`;
    }
  }

  if (asksAboutFriendReport) {
    const reportLock = normalizedCombined.match(
      /khoa[^\n\.]{0,80}tam thoi[^\n\.]{0,40}(\d{1,2})\s*ngay/,
    );
    if (reportLock && reportLock[1]) {
      return `${reportLock[1]} ngay. Neu gui loi moi ket ban lien tuc va bi tu choi hoac bao cao nhieu lan, tai khoan se bi khoa tinh nang ket ban tam thoi ${reportLock[1]} ngay.`;
    }

    return "Tai khoan se bi khoa tinh nang ket ban tam thoi 7 ngay neu gui loi moi ket ban lien tuc va bi tu choi hoac bao cao nhieu lan.";
  }

  if (asksAboutFriendLimit) {
    const limit = normalizedCombined.match(
      /(\d{1,4})[^\n\.]{0,100}yeu cau ket ban[^\n\.]{0,40}moi ngay/,
    );
    if (limit && limit[1]) {
      const value = limit[1];
      return `${value} nguoi/ngay. Zalo gioi han toi da ${value} yeu cau ket ban moi ngay.`;
    }
  }

  const top = texts[0];

  const sentence = top.split(/(?<=[\.\!\?])\s+/)[0] || top;
  return cleanText(sentence);
}

async function embedQuery(userQuery) {
  if (!genAI) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const embeddingCandidates = uniqueModels([
    GEMINI_EMBEDDING_MODEL,
    "gemini-embedding-001",
    "embedding-001",
    "text-embedding-004",
  ]);

  let lastError;

  for (const modelName of embeddingCandidates) {
    try {
      const embeddingModel = genAI.getGenerativeModel({ model: modelName });
      const result = await embeddingModel.embedContent(cleanText(userQuery));
      const values = result?.embedding?.values;

      if (Array.isArray(values) && values.length > 0) {
        return values;
      }
    } catch (error) {
      lastError = error;
      // eslint-disable-next-line no-console
      console.error(
        `[RAG] Embedding model failed: ${modelName}. ${error?.message || error}`,
      );
    }
  }

  throw (
    lastError ||
    new Error(
      "Khong tao duoc embedding cho cau hoi. Hay kiem tra GEMINI_EMBEDDING_MODEL va quyen API key.",
    )
  );
}

async function searchContextFromQdrant(userQuery) {
  if (!qdrantClient) {
    // eslint-disable-next-line no-console
    console.error("[RAG] qdrantClient is null!");
    return { results: [], context: "", bestScore: 0 };
  }

  let vector;
  try {
    vector = await embedQuery(userQuery);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      "[RAG] Khong tao duoc embedding, fallback ve no-answer:",
      error?.message || error,
    );
    return { results: [], context: "", bestScore: 0 };
  }

  let searchResults = [];
  try {
    searchResults = await qdrantClient.search(QDRANT_COLLECTION_NAME, {
      vector,
      limit: RAG_TOP_K,
      with_payload: true,
      with_vectors: false,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      "[RAG] Qdrant search failed, fallback ve no-answer:",
      error?.message || error,
    );
    return { results: [], context: "", bestScore: 0 };
  }

  // eslint-disable-next-line no-console
  console.log("[RAG DEBUG] Search results count:", searchResults?.length);
  if (searchResults && searchResults.length > 0) {
    // eslint-disable-next-line no-console
    console.log("[RAG DEBUG] Top score:", searchResults[0]?.score);
  }

  const filteredResults = Array.isArray(searchResults)
    ? searchResults.filter((item) => (item?.score || 0) >= RAG_SCORE_THRESHOLD)
    : [];

  // eslint-disable-next-line no-console
  console.log(
    "[RAG DEBUG] Filtered results after threshold:",
    filteredResults.length,
    "Threshold:",
    RAG_SCORE_THRESHOLD,
  );

  const bestScore =
    Array.isArray(searchResults) && searchResults.length > 0
      ? Number(searchResults[0]?.score || 0)
      : 0;

  const fallbackResults =
    filteredResults.length === 0 &&
    Array.isArray(searchResults) &&
    bestScore >= RAG_FALLBACK_SCORE_THRESHOLD
      ? searchResults.slice(0, Math.max(1, RAG_FALLBACK_TOP_K))
      : [];

  const finalResults =
    filteredResults.length > 0 ? filteredResults : fallbackResults;

  if (filteredResults.length === 0 && fallbackResults.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      "[RAG DEBUG] Using fallback results:",
      fallbackResults.length,
      "bestScore:",
      bestScore,
      "fallbackThreshold:",
      RAG_FALLBACK_SCORE_THRESHOLD,
    );
  }

  return {
    results: finalResults,
    context: formatRetrievedContext(finalResults),
    bestScore,
  };
}

async function generateAnswer(userQuery, retrievedContext) {
  if (!genAI) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const prompt = buildPrompt(userQuery, retrievedContext);
  const generationCandidates = uniqueModels([
    normalizeGenerationModelName(GEMINI_MODEL),
    "gemini-2.0-flash",
  ]);

  let lastError;

  for (const modelName of generationCandidates) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = cleanText(response.text());
      if (text) return text;
    } catch (error) {
      lastError = error;

      if (isQuotaError(error)) {
        const retryDelayMs = parseRetryDelayMs(error);
        const canRetryWithinWindow =
          retryDelayMs &&
          retryDelayMs > 0 &&
          retryDelayMs < RAG_GENERATE_TIMEOUT_MS;

        if (canRetryWithinWindow) {
          // eslint-disable-next-line no-console
          console.warn(
            `[RAG] Quota reached for ${modelName}. Waiting ${Math.ceil(retryDelayMs / 1000)}s before retrying once.`,
          );

          await sleep(retryDelayMs);

          try {
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = cleanText(response.text());
            if (text) return text;
          } catch (retryError) {
            lastError = retryError;
            // eslint-disable-next-line no-console
            console.error(
              `[RAG] Retry after quota delay failed: ${modelName}. ${retryError?.message || retryError}`,
            );
            continue;
          }
        } else {
          // eslint-disable-next-line no-console
          console.warn(
            `[RAG] Quota reached for ${modelName}. Skip long retry to keep fast fallback path.`,
          );
          continue;
        }
      }

      // eslint-disable-next-line no-console
      console.error(
        `[RAG] Generation model failed: ${modelName}. ${error?.message || error}`,
      );
    }
  }

  throw (
    lastError ||
    new Error(
      "Khong the tao cau tra loi tu Gemini. Hay kiem tra GEMINI_MODEL hoac quyen API key.",
    )
  );
}

async function askAI(userQuestion) {
  const userQuery = cleanText(userQuestion);

  if (!userQuery) {
    return "Vui long nhap cau hoi truoc khi gui cho AI.";
  }

  // eslint-disable-next-line no-console
  console.log("[RAG] Starting search for query:", userQuery);

  const { results, context, bestScore } =
    await searchContextFromQdrant(userQuery);

  // eslint-disable-next-line no-console
  console.log(
    "[RAG] askAI - results.length:",
    results.length,
    "bestScore:",
    bestScore,
    "context length:",
    context?.length,
  );

  if (!results.length || !context) {
    // eslint-disable-next-line no-console
    console.log(
      "[RAG] Returning NO_ANSWER because:",
      !results.length ? "no results" : "",
      !context ? "no context" : "",
    );
    return NO_ANSWER_MESSAGE;
  }

  if (!isQueryRelevantToContext(userQuery, context)) {
    // eslint-disable-next-line no-console
    console.log(
      "[RAG] Returning NO_ANSWER because query is not relevant to context",
    );
    return NO_ANSWER_MESSAGE;
  }

  if (genAI) {
    try {
      const answer = await withTimeout(
        generateAnswer(userQuery, context),
        Math.max(500, RAG_GENERATE_TIMEOUT_MS),
        "Generate timed out",
      );

      if (answer) {
        return answer;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        "[RAG] Generate-first failed or timed out, fallback to fast answer:",
        error?.message || error,
      );
    }
  }

  const fallbackAnswer = tryBuildFallbackAnswer(userQuery, context);
  if (fallbackAnswer) {
    return fallbackAnswer;
  }

  if (RAG_LITE_MODE || !genAI) {
    const liteAnswer = buildLiteAnswerFromContext(results, userQuery);
    if (liteAnswer) {
      return liteAnswer;
    }
  }

  return NO_ANSWER_MESSAGE;
}

module.exports = {
  askAI,
  NO_ANSWER_MESSAGE,
  searchContextFromQdrant,
  generateAnswer,
};
