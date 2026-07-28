const mongoose = require("mongoose");

/**
 * Activity timeline for resort enquiries. Two sources:
 *  - "sync":  detected by the sheet sync (new enquiry, status change, updated).
 *  - "user":  performed inside the CRM (follow-up set, note added, starred).
 */
const resortActivitySchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        "enquiry_created",
        "status_changed",
        "enquiry_updated",
        "followup_set",
        "note_added",
        "reminder_done",
      ],
      required: true,
      index: true,
    },
    source: { type: String, enum: ["sync", "user"], default: "sync" },

    leadId: { type: String, trim: true, index: true }, // GCC id
    leadRef: { type: mongoose.Schema.Types.ObjectId, ref: "ResortLead" },
    clientName: { type: String, trim: true, default: "" },
    salesExec: { type: String, trim: true, default: "" },
    query: { type: String, trim: true, default: "" },

    fromStatus: { type: String, trim: true },
    toStatus: { type: String, trim: true },
    detail: { type: String, trim: true, default: "" },

    // who did it, when it is a user action
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    userName: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "resortactivities" }
);

resortActivitySchema.index({ createdAt: -1 });
resortActivitySchema.index({ salesExec: 1, createdAt: -1 });

module.exports = mongoose.model("ResortActivity", resortActivitySchema);
