const express = require("express");
const multer = require("multer");
const WhatsAppMessage = require("../models/WhatsAppMessage");
const wa = require("../services/whatsappService");

const { last10 } = wa;
const WINDOW_MS = 24 * 60 * 60 * 1000;

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024, files: 1 }, // WhatsApp's media cap
});

function sendError(res, err) {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({ message: err.message });
}

const currentUser = (req) => ({ id: req.userId, name: req.userName });

const { getLeadMap } = wa;

// GET /api/whatsapp/status — configured / connected + business number
router.get("/status", async (_req, res) => {
  res.json(await wa.getStatus());
});

// GET /api/whatsapp/unread — total unread inbound messages (sidebar badge)
router.get("/unread", async (_req, res) => {
  try {
    const unread = await WhatsAppMessage.countDocuments({ direction: "in", isRead: false });
    res.json({ unread });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/whatsapp/phones — { phone10: { messages, unread, lastAt } } for every
// number with a chat, so enquiry lists can flag customers who have WhatsApped.
router.get("/phones", async (_req, res) => {
  try {
    const rows = await WhatsAppMessage.aggregate([
      {
        $group: {
          _id: "$phone10",
          messages: { $sum: 1 },
          unread: {
            $sum: {
              $cond: [{ $and: [{ $eq: ["$direction", "in"] }, { $eq: ["$isRead", false] }] }, 1, 0],
            },
          },
          lastAt: { $max: "$timestamp" },
        },
      },
    ]);
    const phones = {};
    for (const r of rows) phones[r._id] = { messages: r.messages, unread: r.unread, lastAt: r.lastAt };
    res.json({ phones });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/whatsapp/conversations?search=&unread=1&source=enquiry|meta|unknown — one row per customer
router.get("/conversations", async (req, res) => {
  try {
    const rows = await WhatsAppMessage.aggregate([
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: "$phone10",
          waId: { $first: "$waId" },
          lastText: { $first: "$text" },
          lastType: { $first: "$type" },
          lastDirection: { $first: "$direction" },
          lastStatus: { $first: "$status" },
          lastAt: { $first: "$timestamp" },
          contactName: { $max: "$contactName" },
          unread: {
            $sum: {
              $cond: [{ $and: [{ $eq: ["$direction", "in"] }, { $eq: ["$isRead", false] }] }, 1, 0],
            },
          },
          lastInboundAt: {
            $max: { $cond: [{ $eq: ["$direction", "in"] }, "$timestamp", null] },
          },
        },
      },
      { $sort: { lastAt: -1 } },
      { $limit: 1000 },
    ]);

    const leads = await getLeadMap();
    const now = Date.now();
    let conversations = rows.map((r) => ({
      phone10: r._id,
      waId: r.waId,
      contactName: r.contactName || "",
      lead: leads.get(r._id) || null,
      lastText: r.lastText,
      lastType: r.lastType,
      lastDirection: r.lastDirection,
      lastStatus: r.lastStatus,
      lastAt: r.lastAt,
      unread: r.unread,
      lastInboundAt: r.lastInboundAt,
      windowOpen: Boolean(r.lastInboundAt && now - new Date(r.lastInboundAt) < WINDOW_MS),
    }));

    if (req.query.unread === "1") conversations = conversations.filter((c) => c.unread > 0);
    // like Bigin: show only chats that belong to an enquiry / Meta lead / neither
    const source = String(req.query.source || "");
    if (source === "enquiry" || source === "meta") {
      conversations = conversations.filter((c) => c.lead?.source === source);
    } else if (source === "unknown") {
      conversations = conversations.filter((c) => !c.lead);
    }
    const q = String(req.query.search || "").trim().toLowerCase();
    if (q) {
      const digits = q.replace(/\D/g, "");
      conversations = conversations.filter(
        (c) =>
          (digits && c.waId.includes(digits)) ||
          c.contactName.toLowerCase().includes(q) ||
          (c.lead?.clientName || "").toLowerCase().includes(q) ||
          (c.lead?.leadId || "").toLowerCase().includes(q) ||
          (c.lastText || "").toLowerCase().includes(q)
      );
    }
    res.json({ conversations });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/whatsapp/conversations/:phone — thread (oldest first) + marks it read
router.get("/conversations/:phone", async (req, res) => {
  try {
    const phone10 = last10(req.params.phone);
    if (phone10.length !== 10) return res.status(400).json({ message: "Invalid phone" });

    const messages = await WhatsAppMessage.find({ phone10 })
      .sort({ timestamp: -1 })
      .limit(500)
      .lean();
    messages.reverse();

    const unread = messages.filter((m) => m.direction === "in" && !m.isRead);
    if (unread.length) {
      await WhatsAppMessage.updateMany(
        { _id: { $in: unread.map((m) => m._id) } },
        { $set: { isRead: true } }
      );
      wa.markRead(unread[unread.length - 1].waMessageId);
    }

    const lastIn = [...messages].reverse().find((m) => m.direction === "in");
    const leads = await getLeadMap();
    res.json({
      phone10,
      waId: messages[0]?.waId || wa.toWaId(phone10),
      contactName: lastIn?.contactName || "",
      lead: leads.get(phone10) || null,
      windowOpen: Boolean(lastIn && Date.now() - new Date(lastIn.timestamp) < WINDOW_MS),
      windowClosesAt: lastIn ? new Date(new Date(lastIn.timestamp).getTime() + WINDOW_MS) : null,
      messages,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/whatsapp/send { to, text }
router.post("/send", async (req, res) => {
  try {
    res.json(await wa.sendText(req.body.to, req.body.text, currentUser(req)));
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/whatsapp/send-template { to, name, language, params[], preview }
router.post("/send-template", async (req, res) => {
  try {
    const { to, name, language, params, preview } = req.body || {};
    res.json(
      await wa.sendTemplate(
        to,
        { name, language, params: Array.isArray(params) ? params : [], preview },
        currentUser(req)
      )
    );
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/whatsapp/send-media (multipart: file, to, caption)
router.post("/send-media", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file attached" });
    res.json(await wa.sendMedia(req.body.to, req.file, req.body.caption, currentUser(req)));
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/whatsapp/templates — approved templates on the business account
router.get("/templates", async (_req, res) => {
  try {
    res.json({ templates: await wa.listTemplates() });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/whatsapp/media/:id — proxy media (Meta URLs need the bearer token)
router.get("/media/:id", async (req, res) => {
  try {
    const { buffer, mimeType } = await wa.fetchMedia(req.params.id);
    res.set("Content-Type", mimeType);
    res.set("Cache-Control", "private, max-age=86400");
    res.send(buffer);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * Public webhook — mounted WITHOUT auth at /api/whatsapp/webhook.
 * In Meta App Dashboard → WhatsApp → Configuration set the callback URL to
 * https://<backend>/api/whatsapp/webhook, the verify token to
 * WHATSAPP_VERIFY_TOKEN, and subscribe to the "messages" field.
 */
const webhook = express.Router();

webhook.get("/", (req, res) => {
  const token = (process.env.WHATSAPP_VERIFY_TOKEN || "").trim();
  if (
    req.query["hub.mode"] === "subscribe" &&
    token &&
    req.query["hub.verify_token"] === token
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

webhook.post("/", async (req, res) => {
  if (!wa.verifySignature(req.rawBody, req.headers["x-hub-signature-256"])) {
    return res.sendStatus(401);
  }
  // ack immediately — Meta retries anything slower than a few seconds
  res.sendStatus(200);
  try {
    await wa.handleWebhook(req.body);
  } catch (err) {
    console.error("WhatsApp webhook error:", err.message);
  }
});

module.exports = { router, webhook };
