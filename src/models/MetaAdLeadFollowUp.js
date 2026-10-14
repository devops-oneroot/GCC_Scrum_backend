const mongoose = require("mongoose");

/**
 * Follow-up tracking for a lead pulled live from Meta (Meta Ads (Live) tab).
 * One doc per Meta lead id; the lead itself stays in Meta — only what the
 * team does with it (stage, owner, next follow-up, notes) lives here.
 */
const STAGES = [
  "new",
  "contacted",
  "not_reachable",
  "interested",
  "quote_sent",
  "site_visit",
  "negotiation",
  "won",
  "lost",
];

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: String, trim: true, default: "" },
    stage: { type: String, enum: STAGES },
    assignedTo: { type: String, trim: true, default: "" },
    nextFollowUpAt: { type: Date, default: null },
    note: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const metaAdLeadFollowUpSchema = new mongoose.Schema(
  {
    metaLeadId: { type: String, required: true, unique: true, index: true },
    // snapshot so the record still reads sensibly without a Meta call
    name: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    campaignName: { type: String, trim: true, default: "" },

    stage: { type: String, enum: STAGES, default: "new", index: true },
    assignedTo: { type: String, trim: true, default: "", index: true },
    nextFollowUpAt: { type: Date, default: null, index: true },
    lastNote: { type: String, trim: true, default: "" },
    updatedBy: { type: String, trim: true, default: "" },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

const MetaAdLeadFollowUp = mongoose.model("MetaAdLeadFollowUp", metaAdLeadFollowUpSchema);
MetaAdLeadFollowUp.STAGES = STAGES;

module.exports = MetaAdLeadFollowUp;
