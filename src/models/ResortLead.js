const mongoose = require("mongoose");

/**
 * One resort enquiry, mirrored from the GCC Google Sheet.
 *
 * Fields are split in two groups:
 *  - SHEET fields: overwritten on every sync (the sheet is the master).
 *  - APP-ONLY fields: owned by the CRM (follow-up reminders, internal notes,
 *    star). The sync service NEVER touches these, so sales reps can enrich a
 *    row without their work being wiped on the next pull.
 */
const resortLeadSchema = new mongoose.Schema(
  {
    // ---- identity ----
    leadId: { type: String, required: true, unique: true, trim: true, index: true },
    rowNumber: { type: Number }, // row index in the sheet (for reference)
    sheetMonth: { type: String, trim: true, default: "", index: true }, // source tab, e.g. "June 2026"
    origin: { type: String, enum: ["sheet", "app"], default: "sheet", index: true },

    // ---- sheet fields ----
    enquiryDate: { type: Date },
    enquiryDateRaw: { type: String, trim: true },
    clientName: { type: String, trim: true, default: "" },
    companyName: { type: String, trim: true, default: "" },
    contactNo: { type: String, trim: true, default: "" },
    query: { type: String, trim: true, default: "Not specified" }, // enquiry type
    leadSource: { type: String, trim: true, default: "Not specified" },
    bookingDate: { type: Date },
    bookingDateRaw: { type: String, trim: true },
    priorityCode: { type: String, trim: true, default: "" }, // P0..P5
    priorityLabel: { type: String, trim: true, default: "" },
    priorityRank: { type: Number, default: null }, // 0 = most urgent
    pax: { type: Number, default: null },
    paxRaw: { type: String, trim: true, default: "" },
    lastInteraction: { type: String, trim: true, default: "" },
    approxRevenue: { type: Number, default: null },
    quote: { type: Number, default: null },
    salesExec: { type: String, trim: true, default: "Unassigned" },
    comment: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["new", "ongoing", "onboarded", "lost", "other"],
      default: "new",
      index: true,
    },
    statusRaw: { type: String, trim: true, default: "" },
    reason: { type: String, trim: true, default: "" }, // lost reason
    followUpCount: { type: Number, default: 0 },

    // ---- sync bookkeeping ----
    sourceHash: { type: String, default: "" },
    lastSyncedAt: { type: Date },

    // ---- app-only (survive sync) ----
    nextFollowUpAt: { type: Date, default: null },
    internalNote: { type: String, trim: true, default: "" },
    reminderDone: { type: Boolean, default: false },
    starred: { type: Boolean, default: false },
  },
  { timestamps: true, collection: "resortleads" }
);

resortLeadSchema.index({ salesExec: 1, status: 1 });
resortLeadSchema.index({ bookingDate: 1 });
resortLeadSchema.index({ enquiryDate: -1 });

module.exports = mongoose.model("ResortLead", resortLeadSchema);
