const mongoose = require("mongoose");

/**
 * Speech-to-text of an Exotel call recording plus an AI read of how the call
 * went. Keyed by the Exotel call Sid; generated on demand and kept so a call is
 * only ever transcribed once.
 */
const callTranscriptSchema = new mongoose.Schema(
  {
    sid: { type: String, required: true, unique: true, trim: true },
    // raw English speech-to-text, one line per audio segment
    text: { type: String, default: "" },
    // the same call split into speaker turns
    turns: {
      type: [
        {
          _id: false,
          speaker: { type: String, enum: ["agent", "customer"] },
          text: String,
        },
      ],
      default: [],
    },
    language: { type: String, default: "" },
    summary: { type: String, default: "" },
    // interested | follow_up | booked | not_interested | no_conversation | unclear
    result: { type: String, default: "" },
    nextStep: { type: String, default: "" },
    // key facts pulled from the call: [{ label: "Guests", value: "4 adults, 3 kids" }]
    details: {
      type: [{ _id: false, label: String, value: String }],
      default: [],
    },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true, collection: "resort_call_transcripts" }
);

module.exports = mongoose.model("CallTranscript", callTranscriptSchema);
