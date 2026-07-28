const mongoose = require("mongoose");

/**
 * A lead from the "Meta-Report" tab of the Meta ads Google Sheet.
 * Different shape from ResortLead: no won/lost pipeline, but a ₹ Lead Worth.
 * One-way mirror — keyed by a stable rowKey so re-syncs upsert cleanly.
 */
const metaLeadSchema = new mongoose.Schema(
  {
    rowKey: { type: String, required: true, unique: true, index: true },
    date: { type: Date, index: true },
    month: { type: String, trim: true, index: true }, // "Jun 2026"
    clientName: { type: String, trim: true, default: "" },
    company: { type: String, trim: true, default: "" },
    contactNo: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
    query: { type: String, trim: true, default: "" }, // enquiry type
    leadSource: { type: String, trim: true, default: "Meta" },
    salesExec: { type: String, trim: true, default: "Unassigned", index: true },
    pax: { type: String, trim: true, default: "" }, // ranges e.g. "250–500"
    leadWorth: { type: Number, default: 0 }, // ₹ numeric (parsed from shorthand)
    worthText: { type: String, trim: true, default: "" }, // raw "lead Worth" text col (ranges/status)
    worthRaw: { type: String, trim: true, default: "" }, // raw "Lead Worth" numeric col (e.g. "10 L")
    status: {
      type: String,
      enum: ["open", "won", "lost"],
      default: "open",
      index: true,
    },
    remarks: { type: String, trim: true, default: "" },
    hash: { type: String, default: "" },
  },
  { timestamps: true, collection: "meta_leads" }
);

module.exports = mongoose.model("MetaLead", metaLeadSchema);
