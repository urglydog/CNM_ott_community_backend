const path = require("path");
const dotenv = require("dotenv");
const { QdrantClient } = require("@qdrant/js-client-rest");

dotenv.config({
  path:
    process.env.DOTENV_PATH || path.join(__dirname, "..", "..", ".env"),
});

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION_NAME =
  process.env.ZALO_POLICY_QDRANT_COLLECTION || "policy_collection";

function createQdrantClient() {
  if (!QDRANT_URL) {
    throw new Error("Thiếu QDRANT_URL để kết nối Qdrant");
  }

  return new QdrantClient({
    url: QDRANT_URL,
    apiKey: QDRANT_API_KEY || undefined,
  });
}

async function ensurePayloadIndex(client, fieldName, fieldSchema) {
  console.log(
    `[createPolicyPayloadIndexes] Tạo payload index cho "${fieldName}" (${fieldSchema})...`,
  );

  await client.createPayloadIndex(COLLECTION_NAME, {
    field_name: fieldName,
    field_schema: fieldSchema,
  });
}

async function main() {
  try {
    console.log(
      `[createPolicyPayloadIndexes] Kiểm tra collection "${COLLECTION_NAME}"...`,
    );

    const client = createQdrantClient();
    const exists = await client.collectionExists(COLLECTION_NAME);

    if (!exists?.exists) {
      throw new Error(
        `Collection "${COLLECTION_NAME}" chưa tồn tại. Hãy ingest dữ liệu trước.`,
      );
    }

    await ensurePayloadIndex(client, "source", "keyword");
    await ensurePayloadIndex(client, "chunkIndex", "integer");

    console.log(
      `[createPolicyPayloadIndexes] Đã tạo payload indexes thành công cho "${COLLECTION_NAME}"`,
    );
  } catch (error) {
    console.error(
      "[createPolicyPayloadIndexes] Script thất bại:",
      error?.message || error,
    );
    process.exitCode = 1;
  }
}

main();
