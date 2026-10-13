const express = require("express");
const multer = require("multer");
const EmailMessage = require("../models/EmailMessage");
const gmail = require("../services/gmailService");

const router = express.Router();

// Company mailboxes are admin-only.
router.use((req, res, next) => {
  if (!req.isAdmin) return res.status(403).json({ message: "Admins only" });
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EMAIL_RE = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

function splitEmails(v) {
  return String(v || "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function requireMailbox(mb, res) {
  if (!gmail.isKnownMailbox(mb)) {
    res.status(400).json({ message: `Unknown mailbox: ${mb}` });
    return false;
  }
  return true;
}

function sendGmailError(res, err) {
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
  res.status(status).json({ message: err.message });
}

// GET /api/emails/status — connection + import progress per mailbox
router.get("/status", async (_req, res) => {
  try {
    res.json(await gmail.getStatus());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/emails/sync — pull new mail now
router.post("/sync", async (_req, res) => {
  if (!gmail.isConfigured()) {
    return res.status(503).json({ message: "Gmail is not configured" });
  }
  try {
    res.json({ results: await gmail.syncAll() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/emails/threads — conversation list (latest message per thread)
router.get("/threads", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const folder = String(req.query.folder || "inbox");

    const match = { mailbox: { $in: gmail.mailboxes() } };
    if (req.query.mailbox) {
      if (!requireMailbox(req.query.mailbox, res)) return;
      match.mailbox = String(req.query.mailbox).toLowerCase();
    }
    if (folder === "inbox") match.labelIds = "INBOX";
    else if (folder === "sent") match.labelIds = "SENT";
    else if (folder === "starred") match.labelIds = "STARRED";
    else match.labelIds = { $nin: ["TRASH", "SPAM"] };
    if (req.query.unread === "1") match.isUnread = true;
    if (req.query.search) {
      const rx = new RegExp(escapeRe(String(req.query.search).trim()), "i");
      match.$or = [
        { subject: rx },
        { snippet: rx },
        { "from.name": rx },
        { participants: rx },
      ];
    }

    // Two passes so no sort ever holds whole messages: Atlas shared tiers cap
    // in-memory sorts at 32 MB and ignore allowDiskUse. Pass 1 pages tiny
    // {thread, lastDate} keys; pass 2 loads details for just this page.
    const [keys] = await EmailMessage.aggregate(
      [
        { $match: match },
        {
          $group: {
            _id: { mailbox: "$mailbox", threadId: "$threadId" },
            date: { $max: "$date" },
          },
        },
        { $sort: { date: -1 } },
        {
          $facet: {
            items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
            total: [{ $count: "n" }],
          },
        },
      ],
      { allowDiskUse: true }
    );

    const total = keys.total[0]?.n || 0;
    const pageKeys = keys.items.map((k) => k._id);
    const details = pageKeys.length
      ? await EmailMessage.aggregate([
          { $match: { ...match, $and: [{ $or: pageKeys }] } },
          { $sort: { date: -1 } },
          {
            $group: {
              _id: { mailbox: "$mailbox", threadId: "$threadId" },
              latest: {
                $first: {
                  gmailId: "$gmailId",
                  subject: "$subject",
                  snippet: "$snippet",
                  date: "$date",
                  from: "$from",
                  to: "$to",
                  isSent: "$isSent",
                },
              },
              count: { $sum: 1 },
              unread: { $max: "$isUnread" },
              hasAttachments: { $max: "$hasAttachments" },
              senders: { $addToSet: "$from" },
            },
          },
        ])
      : [];
    const byKey = new Map(details.map((d) => [`${d._id.mailbox}|${d._id.threadId}`, d]));
    const threads = pageKeys
      .map((k) => byKey.get(`${k.mailbox}|${k.threadId}`))
      .filter(Boolean);

    const items = threads.map((t) => ({
      mailbox: t._id.mailbox,
      threadId: t._id.threadId,
      subject: t.latest.subject,
      snippet: t.latest.snippet,
      date: t.latest.date,
      from: t.latest.from,
      to: t.latest.to,
      isSent: t.latest.isSent,
      count: t.count,
      unread: t.unread,
      hasAttachments: t.hasAttachments,
      senders: t.senders.slice(0, 4),
      lastGmailId: t.latest.gmailId,
    }));
    res.json({ items, total, page, pages: Math.ceil(total / limit) || 1, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/emails/thread/:mailbox/:threadId — full conversation, live from Gmail
router.get("/thread/:mailbox/:threadId", async (req, res) => {
  const { mailbox, threadId } = req.params;
  if (!requireMailbox(mailbox, res)) return;
  try {
    res.json(await gmail.getThread(mailbox.toLowerCase(), threadId));
  } catch (err) {
    sendGmailError(res, err);
  }
});

// GET /api/emails/attachment/:mailbox/:messageId/:attachmentId
router.get("/attachment/:mailbox/:messageId/:attachmentId", async (req, res) => {
  const { mailbox, messageId, attachmentId } = req.params;
  if (!requireMailbox(mailbox, res)) return;
  try {
    const buf = await gmail.getAttachment(mailbox.toLowerCase(), messageId, attachmentId);
    const filename = String(req.query.filename || "attachment").replace(/["\r\n]/g, "");
    res.setHeader("Content-Type", String(req.query.mimeType || "application/octet-stream"));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.send(buf);
  } catch (err) {
    sendGmailError(res, err);
  }
});

// POST /api/emails/send — compose or reply (multipart, optional attachments)
router.post("/send", upload.array("attachments", 10), async (req, res) => {
  try {
    const from = String(req.body.from || "").toLowerCase();
    if (!requireMailbox(from, res)) return;
    const to = splitEmails(req.body.to);
    const cc = splitEmails(req.body.cc);
    const bcc = splitEmails(req.body.bcc);
    const bad = [...to, ...cc, ...bcc].filter((e) => !EMAIL_RE.test(e));
    if (!to.length) return res.status(400).json({ message: "Add at least one recipient" });
    if (bad.length) return res.status(400).json({ message: `Invalid email: ${bad.join(", ")}` });
    const subject = String(req.body.subject || "").trim();
    const text = String(req.body.text || "");
    if (!subject && !text.trim()) {
      return res.status(400).json({ message: "Subject or message is required" });
    }

    const result = await gmail.sendEmail(from, {
      to,
      cc,
      bcc,
      subject,
      text,
      threadId: req.body.threadId || undefined,
      replyToGmailId: req.body.replyToGmailId || undefined,
      attachments: (req.files || []).map((f) => ({
        filename: f.originalname,
        mimeType: f.mimetype,
        buffer: f.buffer,
      })),
    });
    res.json({ success: true, ...result });
  } catch (err) {
    sendGmailError(res, err);
  }
});

module.exports = router;
