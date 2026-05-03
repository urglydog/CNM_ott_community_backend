const { GoogleGenerativeAI } = require("@google/generative-ai");

async function main() {
  try {
    const genAI = new GoogleGenerativeAI("AIzaSyAkNm0Wm9lQjG5TEQFznmdUr-g7qaZ9zIw");
    // Actually getGenerativeModel doesn't have listModels?
    // Let's just fetch from the REST API to see available models
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyAkNm0Wm9lQjG5TEQFznmdUr-g7qaZ9zIw");
    const data = await response.json();
    const embeddingModels = data.models.filter(m => m.name.includes("embed"));
    console.log("Available embedding models:");
    embeddingModels.forEach(m => console.log(m.name));
  } catch (err) {
    console.error(err);
  }
}

main();
