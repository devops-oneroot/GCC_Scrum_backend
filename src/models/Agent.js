const mongoose = require("mongoose");

/**
 * Directory of Exotel answering agents. Exotel's CDR API returns only the
 * agent's phone NUMBER (the `To` leg of an inbound call) — the human name shown
 * in the Exotel dashboard is not exposed by the API. So we let admins name each
 * number once here; the Calls tab then shows the name everywhere.
 *
 * `number` is stored as the last 10 digits for stable matching.
 */
const agentSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true, trim: true },
    name: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "resort_agents" }
);

module.exports = mongoose.model("Agent", agentSchema);
