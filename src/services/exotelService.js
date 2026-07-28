const ResortLead = require("../models/ResortLead");
const Agent = require("../models/Agent");
const { agentName, VIRTUAL_NUMBERS } = require("../config/exotelAgents");

/**
 * Exotel v1 CDR integration for the resort's inbound IVR line.
 * Credentials come from backend/.env:
 *   EXOTEL_API_KEY, EXOTEL_API_TOKEN, EXOTEL_ACCOUNT_SID, EXOTEL_API_DOMAIN
 *
 * NOTE: Call recordings on recordings.exotel.com are IP-whitelisted. They only
 * stream from a server IP that is whitelisted in the Exotel dashboard.
 */

function cfg() {
  return {
    key: (process.env.EXOTEL_API_KEY || "").trim(),
    token: (process.env.EXOTEL_API_TOKEN || "").trim(),
    sid: (process.env.EXOTEL_ACCOUNT_SID || "").trim(),
    domain: (process.env.EXOTEL_API_DOMAIN || "api.exotel.com").trim(),
  };
}

function isConfigured() {
  const c = cfg();
  return Boolean(c.key && c.token && c.sid);
}

function authHeader() {
  const c = cfg();
  const b64 = Buffer.from(`${c.key}:${c.token}`).toString("base64");
  return `Basic ${b64}`;
}

function base() {
  const c = cfg();
  return `https://${c.domain}/v1/Accounts/${c.sid}`;
}

const last10 = (v) => String(v || "").replace(/\D/g, "").slice(-10);

/** Pull the cursor value (After=/Before=) out of a paging URI. */
function cursorFromUri(uri, param) {
  if (!uri) return null;
  const m = uri.match(new RegExp(`[?&]${param}=([^&]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Normalize one Exotel call and derive the real business OUTCOME.
 *
 * On this inbound IVR line the raw `Status` is almost always "completed", so it
 * tells us nothing. Instead we look at the `To` leg:
 *   - To == an agent number            -> connected  -> "successful"
 *   - To == the ExoPhone/virtual number -> reached the flow but no agent
 *                                          -> "hung_up" (client hung up)
 * Non-completed statuses (no-answer/busy/failed) are surfaced as-is.
 */
function normalizeCall(c) {
  const direction = (c.Direction || "").toLowerCase();
  const inbound = direction.includes("inbound");
  const duration = Number(c.Duration) || 0;
  const status = (c.Status || "").toLowerCase();

  // Exotel v1 puts the ExoPhone number on PhoneNumber / PhoneNumberSid.
  const virtualNumber = c.PhoneNumber || c.PhoneNumberSid || "";
  const toIsVirtual =
    !c.To || (virtualNumber && last10(c.To) === last10(virtualNumber)) ||
    VIRTUAL_NUMBERS.includes(last10(c.To));

  // For inbound: customer = From; the answering agent = To (unless it's the
  // virtual number, meaning no agent picked up). For outbound: reversed.
  const customerNumber = inbound ? c.From : c.To;
  const agentNumber = toIsVirtual ? "" : inbound ? c.To : c.From;
  const connected = Boolean(agentNumber) && duration > 0;

  let outcome; // successful | hung_up | no_answer | busy | failed
  if (["no-answer", "busy", "failed", "canceled"].includes(status)) {
    outcome = status === "no-answer" ? "no_answer" : status;
  } else if (connected) {
    outcome = "successful";
  } else {
    outcome = "hung_up";
  }

  return {
    sid: c.Sid,
    dateCreated: c.DateCreated,
    startTime: c.StartTime,
    endTime: c.EndTime,
    duration,
    price: Number(c.Price) || 0,
    direction: c.Direction || "",
    status: c.Status || "",
    outcome,
    connected,
    answered: outcome === "successful",
    answeredBy: c.AnsweredBy || "",
    from: c.From,
    to: c.To,
    virtualNumber,
    customerNumber,
    agentNumber,
    agentName: agentName(agentNumber) || "",
    hasRecording: Boolean(c.RecordingUrl),
    recordingUrl: c.RecordingUrl || "",
  };
}

/** last-10-digits map of contactNo -> lead, cached briefly. */
let leadMapCache = { at: 0, map: null };
async function getLeadMap() {
  if (leadMapCache.map && Date.now() - leadMapCache.at < 60_000) {
    return leadMapCache.map;
  }
  const leads = await ResortLead.find(
    { contactNo: { $ne: "" } },
    { contactNo: 1, clientName: 1, salesExec: 1, leadId: 1, status: 1 }
  ).lean();
  const map = new Map();
  for (const l of leads) {
    const k = last10(l.contactNo);
    if (k.length === 10 && !map.has(k)) map.set(k, l);
  }
  leadMapCache = { at: Date.now(), map };
  return map;
}
function clearLeadCache() {
  leadMapCache = { at: 0, map: null };
}

/** last-10 -> saved agent name, from the DB directory (cached briefly). */
let agentCache = { at: 0, map: null };
async function getAgentNameMap() {
  if (agentCache.map && Date.now() - agentCache.at < 30_000) {
    return agentCache.map;
  }
  const rows = await Agent.find({}, { number: 1, name: 1 }).lean();
  const map = new Map();
  for (const r of rows) {
    if (r.name) map.set(last10(r.number), r.name);
  }
  agentCache = { at: Date.now(), map };
  return map;
}
function clearAgentCache() {
  agentCache = { at: 0, map: null };
}

function enrich(call, leadMap) {
  const lead = leadMap.get(last10(call.customerNumber));
  return {
    ...call,
    lead: lead
      ? {
          _id: lead._id,
          leadId: lead.leadId,
          clientName: lead.clientName,
          salesExec: lead.salesExec,
          status: lead.status,
        }
      : null,
  };
}

/** GET a page of calls. Cursor pagination via after/before. */
async function fetchCalls({
  pageSize = 20,
  after,
  before,
  from,
  to,
  direction,
  status,
} = {}) {
  if (!isConfigured()) throw new Error("Exotel is not configured");

  const params = new URLSearchParams();
  params.set("PageSize", String(Math.min(100, Math.max(1, pageSize))));
  params.set("SortBy", "DateCreated:desc");
  if (after) params.set("After", after);
  if (before) params.set("Before", before);
  if (direction) params.set("Direction", direction);
  if (status) params.set("Status", status);
  if (from || to) {
    const gte = `${from || "1970-01-01"} 00:00:00`;
    const lte = `${to || from || "2100-01-01"} 23:59:59`;
    params.set("DateCreated", `gte:${gte};lte:${lte}`);
  }

  const url = `${base()}/Calls.json?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Exotel error HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Exotel returned non-JSON: ${text.slice(0, 200)}`);
  }

  const meta = data.Metadata || {};
  const [leadMap, nameMap] = await Promise.all([
    getLeadMap(),
    getAgentNameMap(),
  ]);
  const calls = (data.Calls || []).map((c) => {
    const call = enrich(normalizeCall(c), leadMap);
    if (call.agentNumber) {
      // DB directory name wins over the static config fallback.
      call.agentName = nameMap.get(last10(call.agentNumber)) || call.agentName;
    }
    return call;
  });

  return {
    calls,
    metadata: {
      total: meta.Total ?? null,
      pageSize: meta.PageSize ?? pageSize,
      nextCursor: cursorFromUri(meta.NextPageUri, "After"),
      prevCursor: cursorFromUri(meta.PrevPageUri, "Before"),
    },
  };
}

// Cache aggregate stats per date-window so the 2-min UI poll doesn't re-scan.
const STATS_MAX_PAGES = 40; // up to 4000 calls per window
let statsCache = new Map(); // key -> { at, stats }

/**
 * Aggregate stats over the WHOLE filtered window (not just the first page).
 * Pages through every call in the from..to range and tallies each metric.
 */
async function fetchStats({ from, to } = {}) {
  if (!isConfigured()) throw new Error("Exotel is not configured");

  const key = `${from || ""}|${to || ""}`;
  const cached = statsCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.stats;

  const stats = {
    windowTotal: 0, // calls actually scanned
    total: null, // Exotel's authoritative total for the window
    answered: 0,
    hungUp: 0,
    missed: 0,
    withRecording: 0,
    inbound: 0,
    outbound: 0,
    totalDuration: 0,
    uniqueCallers: 0,
    matchedToLead: 0,
    capped: false,
  };
  const callers = new Set();
  const matchedLeads = new Set(); // distinct enquiries reached (not # of calls)

  let after;
  let pages = 0;
  do {
    const { calls, metadata } = await fetchCalls({
      pageSize: 100,
      from,
      to,
      after,
    });
    if (stats.total === null) stats.total = metadata.total;
    for (const c of calls) {
      stats.windowTotal += 1;
      if (c.outcome === "successful") stats.answered += 1;
      else if (c.outcome === "hung_up") stats.hungUp += 1;
      else stats.missed += 1;
      if (c.hasRecording) stats.withRecording += 1;
      if (c.direction.toLowerCase().includes("inbound")) stats.inbound += 1;
      else stats.outbound += 1;
      stats.totalDuration += c.duration;
      if (c.customerNumber) callers.add(last10(c.customerNumber));
      if (c.lead) matchedLeads.add(String(c.lead._id || c.lead.leadId));
    }
    after = metadata.nextCursor;
    pages += 1;
  } while (after && pages < STATS_MAX_PAGES);

  stats.capped = Boolean(after); // more calls existed than we scanned
  // When we scanned the whole window, the scanned count IS the true total.
  if (!stats.capped) stats.total = stats.windowTotal;
  else if (stats.total == null) stats.total = stats.windowTotal;
  stats.uniqueCallers = callers.size;
  stats.matchedToLead = matchedLeads.size; // distinct enquiries, not calls
  stats.avgDuration = stats.answered
    ? Math.round(stats.totalDuration / stats.answered)
    : 0;

  statsCache.set(key, { at: Date.now(), stats });
  return stats;
}

// Per-agent answered/total call counts over a window (cached).
let agentCallCache = new Map();
async function fetchAgentCallCounts({ from, to } = {}) {
  if (!isConfigured()) throw new Error("Exotel is not configured");
  const key = `${from || ""}|${to || ""}`;
  const cached = agentCallCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.data;

  const map = new Map(); // last10(agentNumber) -> { number, name, total, answered }
  let after;
  let pages = 0;
  do {
    const { calls, metadata } = await fetchCalls({
      pageSize: 100,
      from,
      to,
      after,
    });
    for (const c of calls) {
      if (!c.agentNumber) continue; // hung-up / no agent
      const k = last10(c.agentNumber);
      const cur =
        map.get(k) || { number: c.agentNumber, name: "", total: 0, answered: 0 };
      cur.total += 1;
      if (c.outcome === "successful") cur.answered += 1;
      if (c.agentName) cur.name = c.agentName;
      map.set(k, cur);
    }
    after = metadata.nextCursor;
    pages += 1;
  } while (after && pages < STATS_MAX_PAGES);

  const data = [...map.values()].sort((a, b) => b.answered - a.answered);
  agentCallCache.set(key, { at: Date.now(), data });
  return data;
}

/** Distinct answering-agent numbers seen recently, with names + counts. */
async function fetchAgents() {
  const { calls } = await fetchCalls({ pageSize: 100 });
  const map = new Map();
  for (const c of calls) {
    if (!c.agentNumber) continue;
    const k = last10(c.agentNumber);
    const cur = map.get(k) || {
      number: c.agentNumber,
      name: c.agentName || "",
      calls: 0,
    };
    cur.calls += 1;
    map.set(k, cur);
  }
  return [...map.values()].sort((a, b) => b.calls - a.calls);
}

/** Upsert agent names. list = [{ number, name }]. */
async function saveAgents(list = []) {
  const ops = [];
  for (const a of list) {
    const num = last10(a.number);
    if (num.length < 6) continue;
    ops.push({
      updateOne: {
        filter: { number: num },
        update: { $set: { name: String(a.name || "").trim() } },
        upsert: true,
      },
    });
  }
  if (ops.length) await Agent.bulkWrite(ops, { ordered: false });
  clearAgentCache();
  return fetchAgents();
}

/** Fetch a single call's fresh details (for the recording URL). */
async function getCall(sid) {
  if (!isConfigured()) throw new Error("Exotel is not configured");
  const url = `${base()}/Calls/${encodeURIComponent(sid)}.json`;
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Exotel error HTTP ${res.status}`);
  const data = JSON.parse(text);
  return data.Call || null;
}

/**
 * Stream a call recording through the backend (Exotel recordings need auth and
 * are IP-whitelisted). Returns { ok, status, contentType, buffer, message }.
 */
async function fetchRecording(sid) {
  const call = await getCall(sid);
  const recUrl = call?.RecordingUrl;
  if (!recUrl) return { ok: false, status: 404, message: "No recording for this call" };

  const res = await fetch(recUrl, { headers: { Authorization: authHeader() } });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    const body = buf.toString("utf8").slice(0, 120);
    const ipIssue = /invalid ip/i.test(body);
    return {
      ok: false,
      status: 502,
      message: ipIssue
        ? "Exotel blocked this download: the server's IP is not whitelisted for recordings. Add this server's public IP in the Exotel dashboard."
        : `Recording fetch failed (HTTP ${res.status})`,
    };
  }
  return {
    ok: true,
    status: 200,
    contentType: res.headers.get("content-type") || "audio/mpeg",
    buffer: buf,
  };
}

module.exports = {
  isConfigured,
  fetchCalls,
  fetchStats,
  fetchAgents,
  fetchAgentCallCounts,
  saveAgents,
  clearLeadCache,
  getCall,
  fetchRecording,
  cfg,
};
