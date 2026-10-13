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

/** Attach the matched lead + saved agent name to normalized calls. */
async function enrichCalls(calls) {
  const [leadMap, nameMap] = await Promise.all([
    getLeadMap(),
    getAgentNameMap(),
  ]);
  return calls.map((c) => {
    const call = enrich(c, leadMap);
    if (call.agentNumber) {
      // DB directory name wins over the static config fallback.
      call.agentName = nameMap.get(last10(call.agentNumber)) || call.agentName;
    }
    return call;
  });
}

/** GET one raw page from Exotel (normalized, NOT enriched). */
async function fetchPage({
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
  let res;
  let text;
  // Exotel rate-limits bursts (HTTP 429) — back off and retry.
  for (let attempt = 0; ; attempt += 1) {
    res = await fetch(url, { headers: { Authorization: authHeader() } });
    text = await res.text();
    if (res.status !== 429 || attempt >= 6) break;
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt + Math.random() * 300));
  }
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
  return {
    calls: (data.Calls || []).map(normalizeCall),
    metadata: {
      total: meta.Total ?? null,
      pageSize: meta.PageSize ?? pageSize,
      nextCursor: cursorFromUri(meta.NextPageUri, "After"),
      prevCursor: cursorFromUri(meta.PrevPageUri, "Before"),
    },
  };
}

/** GET a page of calls. Cursor pagination via after/before. */
async function fetchCalls(opts = {}) {
  const { calls, metadata } = await fetchPage(opts);
  return { calls: await enrichCalls(calls), metadata };
}

/* ------------------------------------------------------------------------
 * Whole-window scan, shared by stats / agents / callers / filtered lists.
 *
 * Exotel only offers cursor paging and throttles parallel requests (429), so
 * a cold scan is slow (~1.3s per 100 calls). To keep the UI fast:
 *   - one cached scan per date window, shared by every endpoint, with
 *     concurrent requests joining the same in-flight scan;
 *   - stale-while-revalidate: cached data is returned instantly and refreshed
 *     in the background;
 *   - refreshes are INCREMENTAL: only calls newer than (newest cached - 1h)
 *     are re-fetched, usually a single request;
 *   - recently viewed windows (and the defaults) are kept warm on a timer.
 * ---------------------------------------------------------------------- */
const MAX_CALLS = 4000; // cap per window
const FRESH_MS = 60_000; // window touching today
const PAST_FRESH_MS = 30 * 60_000; // window fully in the past
const OVERLAP_MS = 60 * 60_000; // re-fetch the last hour (status/recording updates)
const FULL_RESCAN_MS = 30 * 60_000; // occasional full rescan for safety
const KEEP_WARM_MS = 60_000;
const ACTIVE_MS = 20 * 60_000; // keep a window warm this long after it was viewed
const MAX_WINDOWS = 40;

const localToday = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
// Exotel timestamps are "YYYY-MM-DD HH:MM:SS"; treat as UTC just for arithmetic.
const tsMinus = (ts, ms) =>
  new Date(new Date(`${ts.replace(" ", "T")}Z`).getTime() - ms)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

const byNewest = (a, b) =>
  String(b.dateCreated || "").localeCompare(String(a.dateCreated || ""));

/**
 * Page through a window newest-first. With `prev`, stop once we're past the
 * overlap cutoff and merge with the older cached calls.
 */
async function scanWindow({ from, to }, prev) {
  const newest = prev?.calls[0]?.dateCreated;
  const cutoff = newest ? tsMinus(newest, OVERLAP_MS) : null;

  const fresh = [];
  let after;
  let total = null;
  do {
    const r = await fetchPage({ pageSize: 100, from, to, after });
    if (total === null) total = r.metadata.total;
    fresh.push(...r.calls);
    after = r.metadata.nextCursor;
    const oldest = r.calls[r.calls.length - 1]?.dateCreated;
    if (cutoff && oldest && oldest < cutoff) break;
  } while (after && fresh.length < MAX_CALLS);

  if (!cutoff) {
    return {
      calls: fresh.slice(0, MAX_CALLS),
      capped: Boolean(after),
      total: after ? Math.max(total || 0, fresh.length) : fresh.length,
      fullAt: Date.now(),
    };
  }

  const seen = new Set();
  const merged = [];
  // Fresh copies win for the overlap; older calls come from the cache.
  for (const c of [
    ...fresh.filter((c) => c.dateCreated >= cutoff),
    ...prev.calls.filter((c) => c.dateCreated < cutoff),
  ]) {
    if (seen.has(c.sid)) continue;
    seen.add(c.sid);
    merged.push(c);
  }
  merged.sort(byNewest);
  const capped = prev.capped || merged.length > MAX_CALLS;
  return {
    calls: merged.slice(0, MAX_CALLS),
    capped,
    total: capped ? Math.max(total || 0, merged.length) : merged.length,
    fullAt: prev.fullAt,
  };
}

const windowCache = new Map(); // key -> { at, data, pending, from, to, seen }

function refreshWindow(key, from, to) {
  const entry = windowCache.get(key) || { from, to };
  if (entry.pending) return entry.pending;
  const prev =
    entry.data && Date.now() - entry.data.fullAt < FULL_RESCAN_MS ? entry.data : null;
  const p = scanWindow({ from, to }, prev)
    .then((data) => {
      const cur = windowCache.get(key) || entry;
      windowCache.set(key, { ...cur, at: Date.now(), data, pending: undefined });
      if (windowCache.size > MAX_WINDOWS) {
        windowCache.delete(windowCache.keys().next().value);
      }
      return data;
    })
    .finally(() => {
      const e = windowCache.get(key);
      if (e && e.pending === p) delete e.pending;
    });
  p.catch(() => {}); // background refreshes must not crash the process
  windowCache.set(key, { ...entry, from, to, pending: p });
  return p;
}

/** Raw (un-enriched) calls for a window, cached + de-duplicated. */
async function getWindow({ from, to } = {}) {
  if (!isConfigured()) throw new Error("Exotel is not configured");
  const key = `${from || ""}|${to || ""}`;
  const entry = windowCache.get(key);
  if (entry) entry.seen = Date.now();
  if (entry?.data) {
    const age = Date.now() - entry.at;
    const freshFor = to && to < localToday() ? PAST_FRESH_MS : FRESH_MS;
    if (age >= freshFor) refreshWindow(key, from, to); // background
    return entry.data;
  }
  const p = refreshWindow(key, from, to);
  windowCache.get(key).seen = Date.now();
  return p;
}

/** All enriched calls in a window (newest first). */
async function fetchAllCalls({ from, to } = {}) {
  const { calls } = await getWindow({ from, to });
  return enrichCalls(calls);
}

/**
 * Warm the default views on boot, then keep recently viewed windows that
 * include today fresh, so the Calls tab never waits on a cold Exotel scan.
 */
let keepWarmTimer = null;
function prewarm() {
  if (!isConfigured() || keepWarmTimer) return;
  const defaults = () => {
    const today = localToday();
    return [{}, { from: `${today.slice(0, 8)}01`, to: today }];
  };
  for (const w of defaults()) getWindow(w).catch(() => {});

  keepWarmTimer = setInterval(() => {
    const today = localToday();
    for (const w of defaults()) {
      const key = `${w.from || ""}|${w.to || ""}`;
      const e = windowCache.get(key);
      if (!e?.pending) refreshWindow(key, w.from, w.to);
    }
    for (const [key, e] of windowCache) {
      const live = !e.to || e.to >= today;
      if (live && !e.pending && Date.now() - (e.seen || 0) < ACTIVE_MS) {
        refreshWindow(key, e.from, e.to);
      }
    }
  }, KEEP_WARM_MS);
  keepWarmTimer.unref?.();
}

/**
 * Aggregate stats over the WHOLE filtered window (not just the first page).
 */
async function fetchStats({ from, to, handledBy, search } = {}) {
  if (!isConfigured()) throw new Error("Exotel is not configured");

  const hb = handledBy ? last10(handledBy) : "";
  const q = String(search || "").trim().toLowerCase();
  const filtered = Boolean(hb || q);

  const win = await getWindow({ from, to });
  const calls = await enrichCalls(win.calls);

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
    capped: win.capped,
  };
  const callers = new Set();
  const matchedLeads = new Set(); // distinct enquiries reached (not # of calls)

  for (const c of calls) {
    // apply the same "scope" filters as the list (agent, search)
    if (hb && last10(c.agentNumber) !== hb) continue;
    if (q) {
      const hay = `${c.from} ${c.to} ${c.customerNumber} ${
        c.agentName || ""
      } ${c.lead?.clientName || ""} ${c.lead?.salesExec || ""}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
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

  // When filtered, or when we scanned the whole window, the tallied count IS the total.
  stats.total = filtered || !stats.capped ? stats.windowTotal : win.total;
  stats.uniqueCallers = callers.size;
  stats.matchedToLead = matchedLeads.size; // distinct enquiries, not calls
  stats.avgDuration = stats.answered
    ? Math.round(stats.totalDuration / stats.answered)
    : 0;
  return stats;
}

// Per-agent answered/total call counts over a window.
async function fetchAgentCallCounts({ from, to } = {}) {
  const calls = await fetchAllCalls({ from, to });
  const map = new Map(); // last10(agentNumber) -> { number, name, total, answered }
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
  return [...map.values()].sort((a, b) => b.answered - a.answered);
}


/**
 * All answering agents for the filter dropdown: every saved agent from the DB
 * directory (so named agents always appear) merged with agents seen in the
 * selected window (with call counts).
 */
async function fetchAgents({ from, to } = {}) {
  const map = new Map(); // last10 -> { number, name, calls }

  // 1) Seed with the saved directory so all named agents are always listed.
  const [saved, nameMap, calls] = await Promise.all([
    Agent.find({}, { number: 1, name: 1 }).lean(),
    getAgentNameMap(),
    fetchAllCalls({ from, to }),
  ]);
  for (const a of saved) {
    const k = last10(a.number);
    if (k.length >= 6) map.set(k, { number: a.number, name: a.name || "", calls: 0 });
  }

  // 2) Count calls in the window and pull in any agent not in the directory.
  for (const c of calls) {
    if (!c.agentNumber) continue;
    const k = last10(c.agentNumber);
    const cur = map.get(k) || {
      number: c.agentNumber,
      name: nameMap.get(k) || c.agentName || "",
      calls: 0,
    };
    cur.calls += 1;
    if (!cur.name && (nameMap.get(k) || c.agentName)) cur.name = nameMap.get(k) || c.agentName;
    map.set(k, cur);
  }

  return [...map.values()].sort(
    (a, b) => b.calls - a.calls || (a.name || a.number).localeCompare(b.name || b.number)
  );
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

/** This server's public IP (what Exotel sees), cached — for the whitelist hint. */
let ipCache = { at: 0, ip: "" };
async function publicIp() {
  if (ipCache.ip && Date.now() - ipCache.at < 10 * 60_000) return ipCache.ip;
  try {
    const res = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(3000) });
    const ip = (await res.text()).trim();
    if (/^[\d.:a-f]+$/i.test(ip)) ipCache = { at: Date.now(), ip };
  } catch {
    /* hint only */
  }
  return ipCache.ip;
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
    const ip = ipIssue ? await publicIp() : "";
    return {
      ok: false,
      status: 502,
      message: ipIssue
        ? `Exotel blocked this download: the server's IP${ip ? ` (${ip})` : ""} is not whitelisted for recordings. Add it to the recordings IP whitelist in the Exotel dashboard (or ask Exotel support).`
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

/**
 * Click-to-call: Exotel rings the agent first and, once they pick up, dials
 * the customer and bridges the two. The customer sees the ExoPhone as caller
 * ID (EXOTEL_CALLER_ID, or the first configured virtual number). The call is
 * recorded so it can be transcribed afterwards.
 */
async function connectCall({ agentNumber, customerNumber }) {
  if (!isConfigured()) throw new Error("Exotel is not configured");
  const callerId =
    (process.env.EXOTEL_CALLER_ID || "").trim() || (VIRTUAL_NUMBERS[0] ? `0${VIRTUAL_NUMBERS[0]}` : "");
  if (!callerId) throw new Error("No ExoPhone set. Add EXOTEL_CALLER_ID to backend/.env");

  const body = new URLSearchParams({
    From: agentNumber,
    To: customerNumber,
    CallerId: callerId,
    Record: "true",
  });
  const res = await fetch(`${base()}/Calls/connect.json`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      msg = j.RestException?.Message || msg;
    } catch {
      /* not JSON */
    }
    throw new Error(`Exotel could not place the call: ${msg}`);
  }
  const call = JSON.parse(text).Call || {};
  return { sid: call.Sid || "", status: call.Status || "queued" };
}

module.exports = {
  isConfigured,
  connectCall,
  fetchCalls,
  fetchStats,
  fetchAllCalls,
  fetchAgents,
  fetchAgentCallCounts,
  saveAgents,
  clearLeadCache,
  getCall,
  fetchRecording,
  cfg,
  prewarm,
};
