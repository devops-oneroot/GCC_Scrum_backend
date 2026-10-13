const mongoose = require("mongoose");

const addrSchema = new mongoose.Schema(
  { name: { type: String, default: "" }, email: { type: String, default: "" } },
  { _id: false }
);

/**
 * Header-level mirror of one Gmail message in one company mailbox.
 * Bodies and attachments are NOT stored — the thread view fetches them live
 * from Gmail, which keeps the DB small even with the full mail history.
 */
const emailMessageSchema = new mongoose.Schema(
  {
    mailbox: { type: String, required: true, lowercase: true, trim: true },
    gmailId: { type: String, required: true },
    threadId: { type: String, required: true },
    labelIds: { type: [String], default: [] },
    from: { type: addrSchema, default: () => ({}) },
    to: { type: [addrSchema], default: [] },
    cc: { type: [addrSchema], default: [] },
    subject: { type: String, default: "" },
    snippet: { type: String, default: "" },
    date: { type: Date, index: true },
    messageIdHeader: { type: String, default: "" },
    hasAttachments: { type: Boolean, default: false },
    isUnread: { type: Boolean, default: false },
    isSent: { type: Boolean, default: false },
    // every address on the message, for "all mail with this client" lookups
    participants: { type: [String], default: [], index: true },
  },
  { timestamps: true, collection: "email_messages" }
);

emailMessageSchema.index({ mailbox: 1, gmailId: 1 }, { unique: true });
emailMessageSchema.index({ mailbox: 1, threadId: 1 });
emailMessageSchema.index({ mailbox: 1, date: -1 });

module.exports = mongoose.model("EmailMessage", emailMessageSchema);
