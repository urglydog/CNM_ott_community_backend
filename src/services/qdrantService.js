const { GoogleGenerativeAI } = require("@google/generative-ai");
const { QdrantClient } = require("@qdrant/js-client-rest");

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

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GOOGLE_GEMINI_API_KEY;
const GEMINI_EMBEDDING_MODEL = normalizeEmbeddingModelName(
  process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001",
);
const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const DEFAULT_COLLECTION_CANDIDATES = [
  process.env.ZALO_POLICY_QDRANT_COLLECTION,
  process.env.QDRANT_COLLECTION_NAME,
  process.env.QDRANT_COLLECTION,
  "policy_collection",
  "ott_community_knowledge",
].filter(Boolean);

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const qdrantClient = QDRANT_URL
  ? new QdrantClient({
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY || undefined,
    })
  : null;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractPayloadText(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  return cleanText(
    [
      payload.text,
      payload.content,
      payload.description,
      payload.answer,
      payload.title,
      payload.name,
    ]
      .filter(Boolean)
      .join(" - "),
  );
}

async function embedQuery(query) {
  if (!genAI) {
    throw new Error("Gemini embedding is not configured");
  }

  const embeddingModel = genAI.getGenerativeModel({
    model: GEMINI_EMBEDDING_MODEL,
  });
  const result = await embeddingModel.embedContent(cleanText(query));
  return result?.embedding?.values || [];
}

async function resolveSearchCollection() {
  const tried = new Set();

  for (const collectionName of DEFAULT_COLLECTION_CANDIDATES) {
    if (!collectionName || tried.has(collectionName)) {
      continue;
    }

    tried.add(collectionName);

    try {
      const exists = await qdrantClient.collectionExists(collectionName);
      if (exists?.exists) {
        return collectionName;
      }
    } catch (error) {
      // Keep checking the next configured collection if one probe fails.
    }
  }

  return DEFAULT_COLLECTION_CANDIDATES[0] || "policy_collection";
}

async function search({ query, limit = 4 }) {
  const normalizedQuery = cleanText(query);

  if (!normalizedQuery) {
    return {
      query: normalizedQuery,
      count: 0,
      results: [],
      context: "",
      placeholder: true,
      message: "Empty query",
    };
  }

  if (!genAI || !qdrantClient) {
    return {
      query: normalizedQuery,
      count: 0,
      results: [],
      context: "",
      placeholder: true,
      message: "Qdrant/Gemini is not fully configured",
    };
  }

  const vector = await embedQuery(normalizedQuery);
  const collectionName = await resolveSearchCollection();
  const searchResults = await qdrantClient.search(collectionName, {
    vector,
    limit: Math.max(1, Math.min(Number(limit) || 4, 10)),
    with_payload: true,
    with_vectors: false,
  });

  const results = (searchResults || []).map((item) => ({
    id: item.id,
    score: Number(item.score || 0),
    text: extractPayloadText(item.payload),
    payload: item.payload || {},
  }));

  return {
    query: normalizedQuery,
    collection: collectionName,
    count: results.length,
    results,
    context: results
      .map((item, index) => `${index + 1}. ${item.text}`)
      .filter((line) => line.split(" ").length > 1)
      .join("\n"),
  };
}

module.exports = {
  search,
};
