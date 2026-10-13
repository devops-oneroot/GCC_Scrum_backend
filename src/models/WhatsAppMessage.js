const mongoose = require("mongoose");

/**
 * One WhatsApp message on the company's WhatsApp Business number (Cloud API).
 * Inbound messages arrive through the webhook; outbound ones are written when
 * the CRM sends them, then their status (sent → delivered → read / failed) is
 * updated by later webhook "statuses" events.
 *
 * Conversations are grouped by `phone10` (last 10 digits) — the same key the
 * Calls tab uses to match a number to a ResortLead / MetaLead.
 */
const whatsAppMessageSchema = new mongoose.Schema(
  {
    waMessageId: { type: String, index: { unique: true, sparse: true } },
    waId: { type: String, default: "" }, // full international number, e.g. 919876543210
    phone10: { type: String, required: true, index: true },
    direction: { type: String, enum: ["in", "out"], required: true },
    type: { type: String, default: "text" }, // text | image | document | audio | video | template | …
    text: { type: String, default: "" },
    media: {
      id: { type: String, default: "" },
      mimeType: { type: String, default: "" },
      fileName: { type: String, default: "" },
    },
    templateName: { type: String, default: "" },
    status: { type: String, default: "" }, // received | sent | delivered | read | failed
    error: { type: String, default: "" },
    timestamp: { type: Date, default: Date.now, index: true },
    contactName: { type: String, default: "" }, // WhatsApp profile name (inbound)
    sentById: { type: String, default: "" },
    sentByName: { type: String, default: "" },
    isRead: { type: Boolean, default: true }, // false for inbound until opened in the CRM
  },
  { timestamps: true, collection: "whatsapp_messages" }
);

whatsAppMessageSchema.index({ phone10: 1, timestamp: -1 });

module.exports = mongoose.model("WhatsAppMessage", whatsAppMessageSchema);
