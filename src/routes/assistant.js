const express = require("express");
const { chat, isConfigured, MODEL } = require("../services/assistantService");

const router = express.Router();

// GET /api/assistant/status
router.get("/status", (_req, res) => {
  res.json({ configured: isConfigured(), model: MODEL });
});

// POST /api/assistant/chat  { messages: [{role, content}] }
router.post("/chat", async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({
      message:
        "AI assistant not configured. Add a free AI_API_KEY (Groq) to backend/.env and restart.",
    });
  }
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) {
      return res.status(400).json({ message: "No messages provided" });
    }
    const result = await chat(messages);
    res.json(result);
  } catch (err) {
    if (err.code === "NOT_CONFIGURED") {
      return res.status(503).json({ message: "AI assistant not configured" });
    }
    console.error("Assistant error:", err.message);
    res.status(502).json({ message: err.message || "Assistant failed" });
  }
});

module.exports = router;
