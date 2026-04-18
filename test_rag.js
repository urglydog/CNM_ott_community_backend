const { GoogleGenerativeAI } = require("@google/generative-ai");
const { QdrantClient } = require("@qdrant/js-client-rest");
const dotenv = require("dotenv");

dotenv.config({ path: ".env" });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const client = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

(async () => {
  try {
    // Embed câu hỏi
    const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
    const query = "chính sách zalo là gì";
    const result = await model.embedContent(query);
    const vector = result?.embedding?.values;

    console.log("📝 Câu hỏi:", query);
    console.log("✅ Vector created, size:", vector.length);

    // Search
    const searchResults = await client.search("default-cluster", {
      vector,
      limit: 5,
      with_payload: true,
    });

    console.log("\n🔍 Search Results:");
    searchResults.forEach((r, i) => {
      console.log(
        `${i + 1}. Score: ${r.score.toFixed(3)} - ${r.payload.text.substring(
          0,
          80,
        )}`,
      );
    });

    console.log(
      "\n⚠️  Current RAG_SCORE_THRESHOLD:",
      process.env.RAG_SCORE_THRESHOLD,
    );
  } catch (e) {
    console.error("❌ Error:", e.message);
  }
})();
