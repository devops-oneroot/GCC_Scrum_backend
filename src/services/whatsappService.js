const crypto = require("crypto");
const WhatsAppMessage = require("../models/WhatsAppMessage");
const ResortLead = require("../models/ResortLead");
const MetaLead = require("../models/MetaLead");
const ResortActivity = require("../models/ResortActivity");

/**
 * WhatsApp Business Platform (Cloud API) integration.
 *
 * Env:
 *   WHATSAPP_TOKEN               permanent System User access token
 *   WHATSAPP_PHONE_NUMBER_ID     the business number's Phone number ID
 *   WHATSAPP_BUSINESS_ACCOUNT_ID WhatsApp Business Account ID (for templates)
 *   WHATSAPP_VERIFY_TOKEN        any string; must match the webhook config in Meta
 *   WHATSAPP_APP_SECRET          optional; verifies webhook signatures
 *   WHATSAPP_GRAPH_VERSION       optional, default v21.0
 *   WHATSAPP_DEFAULT_CC          optional, country code for 10-digit numbers (91)
 *
 * Outside the 24-hour customer-service window WhatsApp only allows approved
 * template messages — free-form text is rejected by Meta.
 */

const env = (k) => (process.env[k] || "").trim();
const graphBase = () =>
  `https://graph.facebook.com/${env("WHATSAPP_GRAPH_VERSION") || "v21.0"}`;

const last10 = (v) => String(v || "").replace(/\D/g, "").slice(-10);

function toWaId(number) {
  const digits = String(number || "").replace(/\D/g, "");
  if (digits.length === 10) return (env("WHATSAPP_DEFAULT_CC") || "91") + digits;
  return digits;
}

function isConfigured() {
  return Boolean(env("WHATSAPP_TOKEN") && env("WHATSAPP_PHONE_NUMBER_ID"));
}

function missingConfig() {
  return ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID"].filter(
    (k) => !env(k)
  );
}

class WhatsAppError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function graph(path, { method = "GET", body, form } = {}) {
  if (!isConfigured()) throw new WhatsAppError("WhatsApp is not configured", 503);
  const headers = { Authorization: `Bearer ${env("WHATSAPP_TOKEN")}` };
  let payload;
  if (form) payload = form;
  else if (body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${graphBase()}/${path}`, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    const detail = e.error_data?.details ? ` — ${e.error_data.details}` : "";
    throw new WhatsAppError(
      `${e.message || `WhatsApp API error ${res.status}`}${detail}`,
      res.status >= 400 && res.status < 500 ? 400 : 502
    );
  }
  return data;
}

// --- lead matching -------------------------------------------------------

/** last-10 → lead info, newest enquiry wins; resort enquiries before Meta leads. */
let leadMapCache = { at: 0, map: null };
async function getLeadMap() {
  if (leadMapCache.map && Date.now() - leadMapCache.at < 60_000) return leadMapCache.map;
  const [resort, meta] = await Promise.all([
    ResortLead.find(
      { contactNo: { $ne: "" } },
      { contactNo: 1, clientName: 1, salesExec: 1, leadId: 1, status: 1, query: 1 }
    )
      .sort({ enquiryDate: -1 })
      .lean(),
    MetaLead.find(
      { contactNo: { $ne: "" } },
      { contactNo: 1, clientName: 1, salesExec: 1, query: 1 }
    )
      .sort({ date: -1 })
      .lean(),
  ]);
  const map = new Map();
  for (const l of resort) {
    const k = last10(l.contactNo);
    if (k.length === 10 && !map.has(k)) {
      map.set(k, {
        source: "enquiry",
        id: String(l._id),
        clientName: l.clientName,
        leadId: l.leadId,
        salesExec: l.salesExec,
        status: l.status,
        query: l.query,
      });
    }
  }
  for (const l of meta) {
    const k = last10(l.contactNo);
    if (k.length === 10 && !map.has(k)) {
      map.set(k, { source: "meta", clientName: l.clientName, salesExec: l.salesExec, query: l.query });
    }
  }
  leadMapCache = { at: Date.now(), map };
  return map;
}
const clearLeadCache = () => {
  leadMapCache = { at: 0, map: null };
};

/** The sheet's label for the current month ("Oct 2026"), so month filters include it. */
async function currentSheetMonth() {
  const now = new Date();
  const mon = now.toLocaleString("en-US", { month: "short" }).toLowerCase();
  const year = String(now.getFullYear());
  const labels = await ResortLead.distinct("sheetMonth");
  return (
    labels.find((l) => l && l.toLowerCase().startsWith(mon) && l.endsWith(year)) ||
    `${now.toLocaleString("en-US", { month: "short" })} ${year}`
  );
}

/**
 * Like Bigin: the first WhatsApp message from a number we don't know creates
 * an enquiry (source WhatsApp) so it lands in the pipeline. The Lead ID is
 * derived from the number, so duplicate webhooks can't create two.
 */
async function ensureEnquiry(phone10, name, firstText) {
  const known = await getLeadMap();
  if (known.has(phone10)) return null;
  try {
    const lead = await ResortLead.create({
      leadId: `WA-${phone10}`,
      origin: "app",
      sheetMonth: await currentSheetMonth(),
      clientName: name || "",
      contactNo: phone10,
      query: "General Inquiry",
      leadSource: "WhatsApp",
      salesExec: "Unassigned",
      comment: firstText ? `WhatsApp: ${firstText}`.slice(0, 500) : "",
      status: "new",
      enquiryDate: new Date(),
    });
    await ResortActivity.create({
      type: "enquiry_created",
      source: "sync",
      leadId: lead.leadId,
      leadRef: lead._id,
      clientName: lead.clientName,
      salesExec: lead.salesExec,
      query: lead.query,
      toStatus: lead.status,
      detail: `New WhatsApp enquiry from ${name ? `${name} (${phone10})` : phone10}`,
    });
    clearLeadCache();
    return lead;
  } catch (err) {
    if (err.code === 11000) return null; // already created by a parallel webhook
    throw err;
  }
}

// --- account -------------------------------------------------------------

let statusCache = { at: 0, value: null };

async function getStatus() {
  if (!isConfigured()) {
    return { configured: false, missing: missingConfig() };
  }
  if (statusCache.value && Date.now() - statusCache.at < 5 * 60_000) {
    return statusCache.value;
  }
  try {
    const info = await graph(
      `${env("WHATSAPP_PHONE_NUMBER_ID")}?fields=display_phone_number,verified_name,quality_rating,name_status`
    );
    statusCache = {
      at: Date.now(),
      value: {
        configured: true,
        connected: true,
        displayPhoneNumber: info.display_phone_number || "",
        verifiedName: info.verified_name || "",
        qualityRating: info.quality_rating || "",
        templatesEnabled: Boolean(env("WHATSAPP_BUSINESS_ACCOUNT_ID")),
        webhookVerifyTokenSet: Boolean(env("WHATSAPP_VERIFY_TOKEN")),
      },
    };
    return statusCache.value;
  } catch (err) {
    return { configured: true, connected: false, error: err.message };
  }
}

// --- sending -------------------------------------------------------------

async function sendMessage(to, payload, record, user) {
  const waId = toWaId(to);
  if (waId.length < 11) throw new WhatsAppError("Invalid phone number", 400);
  const data = await graph(`${env("WHATSAPP_PHONE_NUMBER_ID")}/messages`, {
    method: "POST",
    body: { messaging_product: "whatsapp", recipient_type: "individual", to: waId, ...payload },
  });
  return WhatsAppMessage.create({
    waMessageId: data.messages?.[0]?.id,
    waId: data.contacts?.[0]?.wa_id || waId,
    phone10: last10(waId),
    direction: "out",
    status: "sent",
    timestamp: new Date(),
    sentById: user?.id || "",
    sentByName: user?.name || "",
    ...record,
  });
}

function sendText(to, text, user) {
  const body = String(text || "").trim();
  if (!body) throw new WhatsAppError("Message is empty", 400);
  return sendMessage(
    to,
    { type: "text", text: { body, preview_url: true } },
    { type: "text", text: body },
    user
  );
}

/** params: values for the template body's {{1}}, {{2}}, … in order. */
async function sendTemplate(to, { name, language, params = [], preview = "" }, user) {
  if (!name) throw new WhatsAppError("Template name is required", 400);
  const template = { name, language: { code: language || "en" } };
  const clean = params.map((p) => String(p ?? "").trim());
  if (clean.length) {
    if (clean.some((p) => !p)) throw new WhatsAppError("Fill in every template field", 400);
    template.components = [
      { type: "body", parameters: clean.map((text) => ({ type: "text", text })) },
    ];
  }
  return sendMessage(
    to,
    { type: "template", template },
    { type: "template", templateName: name, text: preview || `[template] ${name}` },
    user
  );
}

const MEDIA_KIND = (mime) => {
  if (/^image\/(jpeg|png)$/.test(mime)) return "image";
  if (/^video\/(mp4|3gpp)$/.test(mime)) return "video";
  if (/^audio\//.test(mime)) return "audio";
  return "document";
};

async function sendMedia(to, file, caption, user) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", file.mimetype);
  form.append("file", new Blob([file.buffer], { type: file.mimetype }), file.originalname);
  const uploaded = await graph(`${env("WHATSAPP_PHONE_NUMBER_ID")}/media`, {
    method: "POST",
    form,
  });

  const kind = MEDIA_KIND(file.mimetype);
  const obj = { id: uploaded.id };
  const cap = String(caption || "").trim();
  if (cap && kind !== "audio") obj.caption = cap;
  if (kind === "document") obj.filename = file.originalname;

  return sendMessage(
    to,
    { type: kind, [kind]: obj },
    {
      type: kind,
      text: cap,
      media: { id: uploaded.id, mimeType: file.mimetype, fileName: file.originalname },
    },
    user
  );
}

async function listTemplates() {
  const waba = env("WHATSAPP_BUSINESS_ACCOUNT_ID");
  if (!waba) throw new WhatsAppError("Set WHATSAPP_BUSINESS_ACCOUNT_ID to use templates", 503);
  const data = await graph(
    `${waba}/message_templates?fields=name,language,status,category,components&limit=200`
  );
  return (data.data || [])
    .filter((t) => t.status === "APPROVED")
    .map((t) => {
      const body = (t.components || []).find((c) => c.type === "BODY");
      const header = (t.components || []).find((c) => c.type === "HEADER");
      const text = body?.text || "";
      const vars = new Set(text.match(/\{\{\d+\}\}/g) || []);
      return {
        name: t.name,
        language: t.language,
        category: t.category,
        body: text,
        paramCount: vars.size,
        // templates with media/variable headers need extra inputs we don't collect
        supported: !header || (header.format === "TEXT" && !/\{\{/.test(header.text || "")),
      };
    });
}

/** Mark the customer's latest message read (blue ticks on their side). */
async function markRead(waMessageId) {
  if (!waMessageId || !isConfigured()) return;
  try {
    await graph(`${env("WHATSAPP_PHONE_NUMBER_ID")}/messages`, {
      method: "POST",
      body: { messaging_product: "whatsapp", status: "read", message_id: waMessageId },
    });
  } catch {
    /* best effort */
  }
}

// --- media download (inbound images / documents) ----------------------------

async function fetchMedia(mediaId) {
  const meta = await graph(mediaId);
  const res = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${env("WHATSAPP_TOKEN")}` },
  });
  if (!res.ok) throw new WhatsAppError(`Media download failed (${res.status})`, 502);
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    mimeType: meta.mime_type || res.headers.get("content-type") || "application/octet-stream",
  };
}

// --- webhook --------------------------------------------------------------

function verifySignature(rawBody, signature) {
  const secret = env("WHATSAPP_APP_SECRET");
  if (!secret) return true; // not configured → accept (the verify token still gates setup)
  if (!rawBody || !signature) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function inboundText(m) {
  switch (m.type) {
    case "text":
      return m.text?.body || "";
    case "image":
    case "video":
    case "document":
      return m[m.type]?.caption || "";
    case "button":
      return m.button?.text || "";
    case "interactive":
      return (
        m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || ""
      );
    case "location":
      return `📍 ${m.location?.name || ""} ${m.location?.latitude},${m.location?.longitude}`.trim();
    case "reaction":
      return m.reaction?.emoji || "";
    default:
      return "";
  }
}

async function handleWebhook(body) {
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = new Map(
        (v.contacts || []).map((c) => [c.wa_id, c.profile?.name || ""])
      );

      for (const m of v.messages || []) {
        const media = m[m.type] && m[m.type].id ? m[m.type] : null;
        if (m.type !== "reaction") {
          await ensureEnquiry(last10(m.from), names.get(m.from) || "", inboundText(m));
        }
        await WhatsAppMessage.updateOne(
          { waMessageId: m.id },
          {
            $setOnInsert: {
              waMessageId: m.id,
              waId: m.from,
              phone10: last10(m.from),
              direction: "in",
              type: m.type,
              text: inboundText(m),
              media: media
                ? {
                    id: media.id,
                    mimeType: media.mime_type || "",
                    fileName: media.filename || "",
                  }
                : undefined,
              status: "received",
              timestamp: new Date(Number(m.timestamp) * 1000),
              contactName: names.get(m.from) || "",
              isRead: false,
            },
          },
          { upsert: true }
        );
      }

      for (const s of v.statuses || []) {
        const err = s.errors?.[0];
        const update = { status: s.status };
        if (err) update.error = err.error_data?.details || err.title || err.message || "";
        // statuses can arrive out of order — never downgrade read → delivered
        const rank = { sent: 1, delivered: 2, read: 3, failed: 4 };
        const doc = await WhatsAppMessage.findOne({ waMessageId: s.id }).select("status");
        if (!doc) continue;
        if ((rank[doc.status] || 0) >= (rank[s.status] || 0) && s.status !== "failed") continue;
        await WhatsAppMessage.updateOne({ _id: doc._id }, { $set: update });
      }
    }
  }
}

module.exports = {
  WhatsAppError,
  isConfigured,
  getStatus,
  sendText,
  sendTemplate,
  sendMedia,
  listTemplates,
  markRead,
  fetchMedia,
  verifySignature,
  handleWebhook,
  last10,
  toWaId,
  getLeadMap,
  clearLeadCache,
};
