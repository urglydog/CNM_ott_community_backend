const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const dotenv = require("dotenv");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { QdrantClient } = require("@qdrant/js-client-rest");

dotenv.config({
  path: process.env.DOTENV_PATH || path.join(__dirname, "..", ".env"),
});

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GOOGLE_GEMINI_API_KEY;
const GEMINI_EMBEDDING_MODEL =
  process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const QDRANT_COLLECTION_NAME =
  process.env.QDRANT_COLLECTION_NAME || "ott_community_knowledge";
const SOURCE_DIR =
  process.env.KNOWLEDGE_SOURCES_DIR ||
  path.join(__dirname, "..", "knowledge_sources");

const CHUNK_SIZE = Number(process.env.RAG_CHUNK_SIZE || 1200);
const CHUNK_OVERLAP = Number(process.env.RAG_CHUNK_OVERLAP || 200);
const QDRANT_RECREATE_COLLECTION =
  String(process.env.QDRANT_RECREATE_COLLECTION || "false").toLowerCase() ===
  "true";

function cleanText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitIntoChunks(text, chunkSize, overlap) {
  const normalized = cleanText(text);
  if (!normalized) return [];

  const chunks = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const end = Math.min(cursor + chunkSize, normalized.length);
    const chunk = normalized.slice(cursor, end).trim();
    if (chunk) chunks.push(chunk);

    if (end >= normalized.length) break;
    cursor = Math.max(0, end - overlap);
  }

  return chunks;
}

function listSupportedFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /\.(txt|md)$/i.test(name));
}

async function createEmbedding(genAI, text) {
  const modelCandidates = [
    GEMINI_EMBEDDING_MODEL,
    "gemini-embedding-001",
    "embedding-001",
    "text-embedding-004",
  ];

  let lastError;
  for (const modelName of [...new Set(modelCandidates)]) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.embedContent(text);
      const values = result?.embedding?.values;
      if (Array.isArray(values) && values.length > 0) {
        return values;
      }
    } catch (error) {
      lastError = error;
      console.error(`Embedding failed with ${modelName}:`, error.message);
    }
  }

  throw (
    lastError ||
    new Error(
      "Cannot create embedding. Check GEMINI_EMBEDDING_MODEL (recommend gemini-embedding-001) and API key permissions.",
    )
  );
}

async function ensureCollection(client, collectionName, vectorSize) {
  const exists = await client.collectionExists(collectionName);
  if (!exists?.exists) {
    await client.createCollection(collectionName, {
      vectors: {
        size: vectorSize,
        distance: "Cosine",
      },
    });
    return;
  }

  const collectionInfo = await client.getCollection(collectionName);
  const configuredVectors = collectionInfo?.config?.params?.vectors;

  let currentSize;
  if (configuredVectors && typeof configuredVectors === "object") {
    if (typeof configuredVectors.size === "number") {
      currentSize = configuredVectors.size;
    } else {
      const firstNamed = Object.values(configuredVectors)[0];
      currentSize = firstNamed?.size;
    }
  }

  if (!currentSize || Number(currentSize) === Number(vectorSize)) {
    return;
  }

  if (QDRANT_RECREATE_COLLECTION) {
    console.warn(
      `Collection ${collectionName} has vector size ${currentSize}, expected ${vectorSize}. Recreating collection because QDRANT_RECREATE_COLLECTION=true.`,
    );
    await client.recreateCollection(collectionName, {
      vectors: {
        size: vectorSize,
        distance: "Cosine",
      },
    });
    return;
  }

  throw new Error(
    `Qdrant collection ${collectionName} đang có vector size=${currentSize} nhưng embedding mới có size=${vectorSize}. Dat QDRANT_RECREATE_COLLECTION=true de tu dong tao lai collection, hoac doi QDRANT_COLLECTION_NAME moi.`,
  );
}

async function ingestFileToQdrant(filePath) {
  if (!GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY in .env");
  }
  if (!QDRANT_URL) {
    throw new Error("Missing QDRANT_URL in .env");
  }

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const qdrantClient = new QdrantClient({
    url: QDRANT_URL,
    apiKey: QDRANT_API_KEY || undefined,
    checkCompatibility: false,
  });

  const raw = fs.readFileSync(filePath, "utf8");
  const chunks = splitIntoChunks(raw, CHUNK_SIZE, CHUNK_OVERLAP);

  if (chunks.length === 0) {
    throw new Error(`File has no usable text: ${filePath}`);
  }

  const points = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const vector = await createEmbedding(genAI, chunk);

    points.push({
      id: randomUUID(),
      vector,
      payload: {
        text: chunk,
        source: path.basename(filePath),
        chunk_index: i,
        total_chunks: chunks.length,
      },
    });

    if (i === 0) {
      await ensureCollection(
        qdrantClient,
        QDRANT_COLLECTION_NAME,
        vector.length,
      );
    }
  }

  await qdrantClient.upsert(QDRANT_COLLECTION_NAME, {
    wait: true,
    points,
  });

  console.log(
    `Done: ${path.basename(filePath)} -> ${QDRANT_COLLECTION_NAME} (${points.length} chunks)`,
  );
}

async function main() {
  const targetArg = process.argv[2];
  const files = targetArg
    ? [
        path.isAbsolute(targetArg)
          ? targetArg
          : path.join(SOURCE_DIR, targetArg),
      ]
    : listSupportedFiles(SOURCE_DIR).map((name) => path.join(SOURCE_DIR, name));

  if (!files.length) {
    throw new Error(
      `No .txt/.md files found. Put policy files in: ${SOURCE_DIR}`,
    );
  }

  for (const filePath of files) {
    console.log(`Ingesting: ${filePath}`);
    await ingestFileToQdrant(filePath);
  }
}

main().catch((error) => {
  const detail =
    error?.data ||
    error?.response?.data ||
    error?.cause ||
    error?.stack ||
    error;
  console.error("Ingest failed:", error.message || error);
  if (detail && detail !== error?.message) {
    console.error("Detail:", detail);
  }
  process.exit(1);
});
