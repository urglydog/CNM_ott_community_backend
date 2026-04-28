const botService = require("./botService");

async function chatWithBot(req, res) {
  try {
    const message = req.body?.message;

    if (!message || !String(message).trim()) {
      return res.status(400).json({ message: "message is required" });
    }

    const result = await botService.askAI(message);

    return res.status(200).json({
      sender: "AI Bot",
      content: result,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("chatWithBot error:", error);
    return res.status(500).json({
      message: error.message || "Internal server error",
    });
  }
}

module.exports = {
  chatWithBot,
};
