const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const EmailMessage = require("../models/EmailMessage");
const EmailMailbox = require("../models/EmailMailbox");

/**
 * Gmail integration for the company Google Workspace mailboxes.
 *
 * Auth = a Google Cloud service account with domain-wide delegation: we sign a
 * JWT with its private key, `sub` = the mailbox to impersonate, and swap it for
 * a 1-hour access token. Plain fetch + node crypto, no googleapis SDK.
 *
 * Sync model:
 *  - backfill: walks messages.list across the whole mailbox (resumable via the
 *    saved page token) and stores header metadata only;
 *  - incremental: history.list from the saved historyId every couple of minutes.
 * Bodies/attachments are fetched live when a thread is opened.
 *
 * We never change read/unread state when an admin views mail — that would mark
 * it read in the employee's own Gmail.
 */

const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD_API = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
const DEFAULT_MAILBOXES = [
  "enquiries@goldcoinsresort.in",
  "events@goldcoinsresort.in",
  "reserve@goldcoinsresort.in",
  "bookings@goldcoinsresort.in",
  "sales@goldcoinsresort.in",
  "khingpar@goldcoinsresort.in",
];
const META_HEADERS = ["From", "To", "Cc", "Subject", "Date", "Message-ID"];

function mailboxes() {
  const raw = (process.env.GMAIL_MAILBOXES || "").trim();
  const list = raw ? raw.split(",") : DEFAULT_MAILBOXES;
  return list.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function isKnownMailbox(mb) {
  return mailboxes().includes(String(mb || "").toLowerCase());
}

// ---------- service account key ----------

let keyCache = null;
function loadKey() {
  if (keyCache) return keyCache;
  let json = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
  if (json && !json.startsWith("{")) {
    // allow base64 for hosts where multi-line env values are awkward
    json = Buffer.from(json, "base64").toString("utf8");
  }
  if (!json) {
    const file =
      (process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "").trim() ||
      path.join(__dirname, "../../google-service-account.json");
    if (!fs.existsSync(file)) return null;
    json = fs.readFileSync(file, "utf8");
  }
  const key = JSON.parse(json);
  if (!key.client_email || !key.private_key) {
    throw new Error("Service account JSON is missing client_email/private_key");
  }
  keyCache = key;
  return key;
}

function isConfigured() {
  try {
    return !!loadKey();
  } catch {
    return false;
  }
}

// ---------- access tokens (one per impersonated mailbox) ----------

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

const tokenCache = new Map(); // mailbox -> { token, exp }

async function getAccessToken(mailbox) {
  const hit = tokenCache.get(mailbox);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;

  const key = loadKey();
  if (!key) throw new Error("Gmail is not configured (no service account key)");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      sub: mailbox,
      scope: SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(key.private_key))}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = data.error_description || data.error || res.statusText;
    if (data.error === "unauthorized_client") {
      throw new Error(
        `Domain-wide delegation not authorised for this service account (${why}). ` +
          `Add its Client ID with scope ${SCOPE} in Google Admin → Security → API controls.`
      );
    }
    throw new Error(`Google token error for ${mailbox}: ${why}`);
  }
  tokenCache.set(mailbox, {
    token: data.access_token,
    exp: Date.now() + (data.expires_in || 3600) * 1000,
  });
  return data.access_token;
}

// ---------- Gmail REST ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class GmailError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function gmailFetch(mailbox, urlOrPath, { method = "GET", body, headers = {}, query } = {}) {
  let url = urlOrPath.startsWith("https://") ? urlOrPath : `${API}${urlOrPath}`;
  if (query) {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v === undefined || v === null || v === "") return;
      (Array.isArray(v) ? v : [v]).forEach((x) => qs.append(k, String(x)));
    });
    const s = qs.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  }

  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken(mailbox);
    const res = await fetch(url, {
      method,
      body,
      headers: { Authorization: `Bearer ${token}`, ...headers },
    });
    if (res.ok) {
      return res.status === 204 ? null : res.json();
    }
    if (res.status === 401 && attempt === 0) {
      tokenCache.delete(mailbox);
      continue;
    }
    // rate limit / transient — back off and retry
    if ((res.status === 429 || res.status >= 500 || res.status === 403) && attempt < 5) {
      const text = await res.text();
      const isRate = res.status !== 403 || /rate|quota|limit/i.test(text);
      if (isRate) {
        await sleep(Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500);
        continue;
      }
      throw new GmailError(res.status, gmailErrorMessage(text, res.statusText));
    }
    const text = await res.text();
    throw new GmailError(res.status, gmailErrorMessage(text, res.statusText));
  }
}

function gmailErrorMessage(text, fallback) {
  try {
    const j = JSON.parse(text);
    return j.error?.message || fallback;
  } catch {
    return text || fallback;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

// ---------- parsing ----------

/** "A B" <a@b.com>, c@d.com → [{name,email}] (commas inside quotes/<> kept). */
function parseAddrList(value) {
  if (!value) return [];
  const parts = [];
  let cur = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of String(value)) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "<") inAngle = true;
    else if (ch === ">") inAngle = false;
    if (ch === "," && !inQuote && !inAngle) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^(.*)<([^>]+)>\s*$/);
      if (m) {
        return {
          name: m[1].trim().replace(/^"|"$/g, "").trim(),
          email: m[2].trim().toLowerCase(),
        };
      }
      return { name: "", email: p.replace(/^"|"$/g, "").trim().toLowerCase() };
    });
}

function headerMap(payload) {
  const h = {};
  (payload?.headers || []).forEach(({ name, value }) => {
    h[name.toLowerCase()] = value;
  });
  return h;
}

/** Gmail message (format=metadata|full) → EmailMessage fields. */
function toDoc(mailbox, msg) {
  const h = headerMap(msg.payload);
  const from = parseAddrList(h.from)[0] || { name: "", email: "" };
  const to = parseAddrList(h.to);
  const cc = parseAddrList(h.cc);
  const labelIds = msg.labelIds || [];
  const participants = [...new Set([from, ...to, ...cc].map((a) => a.email).filter(Boolean))];
  return {
    mailbox,
    gmailId: msg.id,
    threadId: msg.threadId,
    labelIds,
    from,
    to,
    cc,
    subject: h.subject || "",
    snippet: decodeEntities(msg.snippet || ""),
    date: msg.internalDate ? new Date(Number(msg.internalDate)) : h.date ? new Date(h.date) : null,
    messageIdHeader: h["message-id"] || "",
    hasAttachments: /multipart\/mixed/i.test(msg.payload?.mimeType || ""),
    isUnread: labelIds.includes("UNREAD"),
    isSent: labelIds.includes("SENT"),
    participants,
  };
}

function decodeEntities(s) {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function decodeBody(data, charset) {
  if (!data) return "";
  const buf = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const cs = String(charset || "utf-8").toLowerCase();
  if (cs.includes("8859-1") || cs.includes("latin1") || cs.includes("1252")) {
    return buf.toString("latin1");
  }
  return buf.toString("utf8");
}

function partHeader(part, name) {
  const hit = (part.headers || []).find((x) => x.name.toLowerCase() === name);
  return hit ? hit.value : "";
}

/** Walk a full message payload → { text, html, attachments, inline } */
function extractParts(payload) {
  const out = { text: "", html: "", attachments: [], inline: [] };
  const walk = (part) => {
    if (!part) return;
    const mime = (part.mimeType || "").toLowerCase();
    const ctype = partHeader(part, "content-type");
    const charset = (ctype.match(/charset="?([^";]+)"?/i) || [])[1];
    const cid = partHeader(part, "content-id").replace(/[<>]/g, "");
    const disposition = partHeader(part, "content-disposition").toLowerCase();

    if (part.filename && part.body?.attachmentId) {
      const att = {
        filename: part.filename,
        mimeType: part.mimeType,
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId,
      };
      if (cid && mime.startsWith("image/") && !disposition.startsWith("attachment")) {
        out.inline.push({ ...att, cid });
      } else {
        out.attachments.push(att);
      }
    } else if (mime === "text/html" && part.body?.data) {
      out.html += decodeBody(part.body.data, charset);
    } else if (mime === "text/plain" && part.body?.data && !part.filename) {
      out.text += decodeBody(part.body.data, charset);
    }
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  return out;
}

// ---------- storing ----------

async function upsertMessages(mailbox, msgs) {
  if (!msgs.length) return 0;
  const ops = msgs.map((m) => {
    const doc = toDoc(mailbox, m);
    return {
      updateOne: {
        filter: { mailbox, gmailId: doc.gmailId },
        update: { $set: doc },
        upsert: true,
      },
    };
  });
  await EmailMessage.bulkWrite(ops, { ordered: false });
  return ops.length;
}

async function fetchMetadata(mailbox, ids) {
  const msgs = await mapLimit(ids, 10, async (id) => {
    try {
      return await gmailFetch(mailbox, `/messages/${id}`, {
        query: { format: "metadata", metadataHeaders: META_HEADERS },
      });
    } catch (err) {
      if (err.status === 404) return { __gone: id };
      throw err;
    }
  });
  const gone = msgs.filter((m) => m && m.__gone).map((m) => m.__gone);
  if (gone.length) await EmailMessage.deleteMany({ mailbox, gmailId: { $in: gone } });
  return msgs.filter((m) => m && !m.__gone);
}

async function getMailboxDoc(mailbox) {
  let doc = await EmailMailbox.findOne({ email: mailbox });
  if (!doc) doc = await EmailMailbox.create({ email: mailbox });
  return doc;
}

/** First contact: remember the current historyId BEFORE the backfill starts, so
 *  mail arriving mid-import is picked up by the incremental pass. */
async function ensureInitialised(doc) {
  if (doc.historyId) return doc;
  const profile = await gmailFetch(doc.email, "/profile");
  doc.historyId = String(profile.historyId);
  doc.totalMessages = profile.messagesTotal || 0;
  doc.lastError = "";
  await doc.save();
  return doc;
}

// ---------- backfill (full history import) ----------

const backfillRunning = new Set();

async function backfillMailbox(mailbox) {
  if (backfillRunning.has(mailbox)) return;
  backfillRunning.add(mailbox);
  try {
    let doc = await ensureInitialised(await getMailboxDoc(mailbox));
    while (!doc.backfillDone) {
      const page = await gmailFetch(mailbox, "/messages", {
        query: { maxResults: 500, pageToken: doc.backfillPageToken || undefined },
      });
      const ids = (page.messages || []).map((m) => m.id);
      // resuming after a restart: skip ids we already hold
      const have = new Set(
        (
          await EmailMessage.find({ mailbox, gmailId: { $in: ids } }, { gmailId: 1 }).lean()
        ).map((d) => d.gmailId)
      );
      const todo = ids.filter((id) => !have.has(id));
      // chunk so progress is saved regularly on huge mailboxes
      for (let i = 0; i < todo.length; i += 100) {
        const msgs = await fetchMetadata(mailbox, todo.slice(i, i + 100));
        await upsertMessages(mailbox, msgs);
      }
      doc.backfillCount += ids.length;
      doc.backfillPageToken = page.nextPageToken || "";
      doc.backfillDone = !page.nextPageToken;
      doc.lastSyncAt = new Date();
      doc.lastError = "";
      await doc.save();
    }
    console.log(`📧 Gmail import complete for ${mailbox} (${doc.backfillCount} messages)`);
  } catch (err) {
    console.error(`📧 Gmail import error (${mailbox}):`, err.message);
    await EmailMailbox.updateOne({ email: mailbox }, { lastError: err.message });
  } finally {
    backfillRunning.delete(mailbox);
  }
}

// ---------- incremental ----------

const incRunning = new Set();

async function incrementalSync(mailbox) {
  if (incRunning.has(mailbox)) return { skipped: true };
  incRunning.add(mailbox);
  try {
    const doc = await ensureInitialised(await getMailboxDoc(mailbox));
    const changed = new Set();
    const deleted = new Set();
    let pageToken;
    let latest = doc.historyId;
    try {
      do {
        const page = await gmailFetch(mailbox, "/history", {
          query: {
            startHistoryId: doc.historyId,
            pageToken,
            maxResults: 500,
            historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
          },
        });
        (page.history || []).forEach((h) => {
          (h.messagesAdded || []).forEach((x) => changed.add(x.message.id));
          (h.labelsAdded || []).forEach((x) => changed.add(x.message.id));
          (h.labelsRemoved || []).forEach((x) => changed.add(x.message.id));
          (h.messagesDeleted || []).forEach((x) => deleted.add(x.message.id));
        });
        if (page.historyId) latest = String(page.historyId);
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (err) {
      if (err.status !== 404) throw err;
      // history cursor too old (Gmail keeps ~1 week): re-anchor and rescan recent mail
      const profile = await gmailFetch(mailbox, "/profile");
      latest = String(profile.historyId);
      const recent = await gmailFetch(mailbox, "/messages", {
        query: { maxResults: 500, q: "newer_than:14d" },
      });
      (recent.messages || []).forEach((m) => changed.add(m.id));
    }

    deleted.forEach((id) => changed.delete(id));
    if (deleted.size) {
      await EmailMessage.deleteMany({ mailbox, gmailId: { $in: [...deleted] } });
    }
    const msgs = await fetchMetadata(mailbox, [...changed]);
    await upsertMessages(mailbox, msgs);

    doc.historyId = latest;
    doc.lastSyncAt = new Date();
    doc.lastError = "";
    await doc.save();
    return { changed: msgs.length, deleted: deleted.size };
  } catch (err) {
    await EmailMailbox.updateOne({ email: mailbox }, { lastError: err.message });
    throw err;
  } finally {
    incRunning.delete(mailbox);
  }
}

async function syncAll() {
  const results = {};
  await Promise.all(
    mailboxes().map(async (mb) => {
      try {
        results[mb] = await incrementalSync(mb);
      } catch (err) {
        results[mb] = { error: err.message };
      }
    })
  );
  // pick the import back up if it was interrupted (restart / transient error)
  mailboxes().forEach(async (mb) => {
    const doc = await EmailMailbox.findOne({ email: mb }).lean();
    if (doc && !doc.backfillDone) backfillMailbox(mb);
  });
  return results;
}

let timer = null;
function startEmailSync() {
  if (!isConfigured()) {
    console.log("📧 Gmail not configured (no service account key) — email sync disabled");
    return;
  }
  const sec = Number(process.env.EMAIL_SYNC_INTERVAL_SEC ?? 90);
  syncAll().catch((e) => console.error("📧 Gmail sync error:", e.message));
  mailboxes().forEach((mb) => backfillMailbox(mb));
  if (sec > 0 && !timer) {
    timer = setInterval(() => {
      syncAll().catch((e) => console.error("📧 Gmail sync error:", e.message));
    }, sec * 1000);
  }
  console.log(`📧 Gmail sync on for ${mailboxes().length} mailboxes (every ${sec}s)`);
}

// ---------- live reads ----------

async function getThread(mailbox, threadId) {
  const thread = await gmailFetch(mailbox, `/threads/${threadId}`, {
    query: { format: "full" },
  });
  // keep our mirror fresh with whatever we just saw
  await upsertMessages(mailbox, thread.messages || []);

  const messages = await Promise.all(
    (thread.messages || []).map(async (m) => {
      const meta = toDoc(mailbox, m);
      const parts = extractParts(m.payload);
      let html = parts.html;
      // inline (cid:) images → data: URIs so they render without auth
      if (html && parts.inline.length) {
        const small = parts.inline.filter((x) => x.size < 1_500_000).slice(0, 8);
        await Promise.all(
          small.map(async (img) => {
            try {
              const a = await gmailFetch(
                mailbox,
                `/messages/${m.id}/attachments/${img.attachmentId}`
              );
              const b64 = a.data.replace(/-/g, "+").replace(/_/g, "/");
              html = html.split(`cid:${img.cid}`).join(`data:${img.mimeType};base64,${b64}`);
            } catch {
              /* leave the broken image */
            }
          })
        );
      }
      return {
        id: m.id,
        threadId: m.threadId,
        from: meta.from,
        to: meta.to,
        cc: meta.cc,
        subject: meta.subject,
        date: meta.date,
        isSent: meta.isSent,
        isUnread: meta.isUnread,
        messageIdHeader: meta.messageIdHeader,
        text: parts.text,
        html,
        attachments: parts.attachments,
      };
    })
  );
  return { id: thread.id, mailbox, messages };
}

async function getAttachment(mailbox, messageId, attachmentId) {
  const a = await gmailFetch(mailbox, `/messages/${messageId}/attachments/${attachmentId}`);
  return Buffer.from(a.data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// ---------- sending ----------

const encodeHeader = (s) =>
  /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

const formatAddr = ({ name, email }) =>
  name ? `${encodeHeader(name.includes(",") ? `"${name}"` : name)} <${email}>` : email;

const b64lines = (buf) =>
  Buffer.from(buf).toString("base64").replace(/(.{76})/g, "$1\r\n");

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function buildMime({ from, fromName, to, cc, bcc, subject, text, inReplyTo, references, attachments = [] }) {
  const boundary = (tag) => `----gcc${tag}${crypto.randomBytes(8).toString("hex")}`;
  const altB = boundary("alt");
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px">${escapeHtml(text).replace(/\r?\n/g, "<br>")}</div>`;
  const alternative = [
    `Content-Type: multipart/alternative; boundary="${altB}"`,
    "",
    `--${altB}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64lines(text),
    `--${altB}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64lines(html),
    `--${altB}--`,
  ].join("\r\n");

  const headers = [
    `From: ${formatAddr({ name: fromName, email: from })}`,
    `To: ${to.join(", ")}`,
    cc?.length ? `Cc: ${cc.join(", ")}` : null,
    bcc?.length ? `Bcc: ${bcc.join(", ")}` : null,
    `Subject: ${encodeHeader(subject)}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    "MIME-Version: 1.0",
  ].filter(Boolean);

  if (!attachments.length) return `${headers.join("\r\n")}\r\n${alternative}`;

  const mixB = boundary("mix");
  const parts = [`--${mixB}\r\n${alternative}`];
  attachments.forEach((a) => {
    const name = encodeHeader(a.filename).replace(/"/g, "");
    parts.push(
      [
        `--${mixB}`,
        `Content-Type: ${a.mimeType || "application/octet-stream"}; name="${name}"`,
        `Content-Disposition: attachment; filename="${name}"`,
        "Content-Transfer-Encoding: base64",
        "",
        b64lines(a.buffer),
      ].join("\r\n")
    );
  });
  return `${headers.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="${mixB}"\r\n\r\n${parts.join("\r\n")}\r\n--${mixB}--`;
}

async function sendEmail(mailbox, { to, cc, bcc, subject, text, threadId, replyToGmailId, attachments }) {
  let inReplyTo = "";
  let references = "";
  if (replyToGmailId) {
    const orig = await gmailFetch(mailbox, `/messages/${replyToGmailId}`, {
      query: { format: "metadata", metadataHeaders: ["Message-ID", "References"] },
    });
    const h = headerMap(orig.payload);
    inReplyTo = h["message-id"] || "";
    references = [h.references, inReplyTo].filter(Boolean).join(" ");
    threadId = threadId || orig.threadId;
  }

  const mime = buildMime({
    from: mailbox,
    fromName: (process.env.EMAIL_FROM_NAME || "Gold Coins Resort").trim(),
    to,
    cc,
    bcc,
    subject,
    text,
    inReplyTo,
    references,
    attachments,
  });

  // multipart upload: JSON metadata (threadId) + the raw RFC 822 message.
  // Avoids the size cap on base64-in-JSON sends when PDFs are attached.
  const b = `gccupload${crypto.randomBytes(8).toString("hex")}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
        threadId ? { threadId } : {}
      )}\r\n--${b}\r\nContent-Type: message/rfc822\r\n\r\n`
    ),
    Buffer.from(mime),
    Buffer.from(`\r\n--${b}--`),
  ]);
  const sent = await gmailFetch(mailbox, `${UPLOAD_API}/messages/send`, {
    method: "POST",
    query: { uploadType: "multipart" },
    headers: { "Content-Type": `multipart/related; boundary=${b}` },
    body,
  });

  const [meta] = await fetchMetadata(mailbox, [sent.id]);
  if (meta) await upsertMessages(mailbox, [meta]);
  return { id: sent.id, threadId: sent.threadId };
}

// ---------- status ----------

async function getStatus() {
  const configured = isConfigured();
  let serviceAccount = null;
  try {
    serviceAccount = loadKey()?.client_email || null;
  } catch (err) {
    return { configured: false, error: err.message, mailboxes: [] };
  }
  const docs = await EmailMailbox.find({ email: { $in: mailboxes() } }).lean();
  const counts = await EmailMessage.aggregate([
    { $match: { mailbox: { $in: mailboxes() } } },
    {
      $group: {
        _id: "$mailbox",
        stored: { $sum: 1 },
        unread: {
          $sum: {
            $cond: [{ $and: ["$isUnread", { $in: ["INBOX", "$labelIds"] }] }, 1, 0],
          },
        },
      },
    },
  ]);
  const byMb = Object.fromEntries(counts.map((c) => [c._id, c]));
  return {
    configured,
    serviceAccount,
    mailboxes: mailboxes().map((mb) => {
      const d = docs.find((x) => x.email === mb) || {};
      return {
        email: mb,
        stored: byMb[mb]?.stored || 0,
        unread: byMb[mb]?.unread || 0,
        totalMessages: d.totalMessages || 0,
        backfillDone: !!d.backfillDone,
        importing: backfillRunning.has(mb),
        lastSyncAt: d.lastSyncAt || null,
        lastError: d.lastError || "",
      };
    }),
  };
}

module.exports = {
  mailboxes,
  isKnownMailbox,
  isConfigured,
  startEmailSync,
  syncAll,
  getThread,
  getAttachment,
  sendEmail,
  getStatus,
  // exported for tests / scripts
  parseAddrList,
  buildMime,
};
