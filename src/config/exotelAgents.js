/**
 * Exotel agent directory: map each agent's phone number to a display name.
 * Exotel's v1 CDR API only returns the agent's NUMBER (the `To` leg of an
 * inbound call), not the name shown in the Exotel dashboard — so fill the
 * names here once. Matching is on the last 10 digits, so any format works.
 *
 * Agent numbers seen in this account's recent calls (fill in the names):
 *   9187453430, 7676217275, 9187453373
 * (Check Exotel dashboard → Manage → Users to confirm who each number is.)
 *
 * You can also override this at runtime with an EXOTEL_AGENTS env var, e.g.
 *   EXOTEL_AGENTS=9187453430:Akhil,7676217275:Chetan,9187453373:Abhinav
 */
const AGENTS = {
  "9187453430": "",
  "7676217275": "",
  "9187453373": "",
};

const last10 = (v) => String(v || "").replace(/\D/g, "").slice(-10);

function loadEnvAgents() {
  const raw = (process.env.EXOTEL_AGENTS || "").trim();
  if (!raw) return {};
  const out = {};
  for (const pair of raw.split(",")) {
    const [num, ...name] = pair.split(":");
    const key = last10(num);
    if (key.length === 10 && name.length) out[key] = name.join(":").trim();
  }
  return out;
}

/** Optional: your ExoPhone / virtual numbers. Auto-detected too (see service). */
const VIRTUAL_NUMBERS = ["08045680780"].map(last10);

function agentName(number) {
  const key = last10(number);
  const env = loadEnvAgents();
  const name = env[key] || AGENTS[key] || "";
  return name || "";
}

module.exports = { agentName, VIRTUAL_NUMBERS, last10 };
