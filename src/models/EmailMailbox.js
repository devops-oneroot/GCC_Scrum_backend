const mongoose = require("mongoose");

/** Sync bookkeeping for one connected Gmail mailbox. */
const emailMailboxSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Gmail history cursor for incremental sync (new mail since last pass)
    historyId: { type: String, default: "" },
    // full-history import is resumable: the next messages.list page to fetch
    backfillPageToken: { type: String, default: "" },
    backfillDone: { type: Boolean, default: false },
    backfillCount: { type: Number, default: 0 },
    totalMessages: { type: Number, default: 0 }, // from Gmail profile
    lastSyncAt: { type: Date },
    lastError: { type: String, default: "" },
  },
  { timestamps: true, collection: "email_mailboxes" }
);

module.exports = mongoose.model("EmailMailbox", emailMailboxSchema);
