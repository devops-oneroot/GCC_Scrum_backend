const mongoose = require("mongoose");

/**
 * Speech-to-text of an Exotel call recording plus an AI read of how the call
 * went. Keyed by the Exotel call Sid; generated on demand and kept so a call is
 * only ever transcribed once.
 */
const callTranscriptSchema = new mongoose.Schema(
  {
    sid: { type: String, required: true, unique: true, trim: true },
    text: { type: String, default: "" },
    language: { type: String, default: "" },
    summary: { type: String, default: "" },
    // interested | follow_up | booked | not_interested | no_conversation | unclear
    result: { type: String, default: "" },
    nextStep: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true, collection: "resort_call_transcripts" }
);

module.exports = mongoose.model("CallTranscript", callTranscriptSchema);
