const express = require("express");
const {
  isConfigured,
  fetchCalls,
  fetchAllCalls,
  fetchStats,
  fetchAgents,
  fetchAgentCallCounts,
  saveAgents,
  fetchRecording,
  connectCall,
} = require("../services/exotelService");
const {
  transcribeCall,
  transcriptMap,
  isConfigured: transcriptionConfigured,
} = require("../services/transcriptionService");
const CallTranscript = require("../models/CallTranscript");
const User = require("../models/User");

const last10 = (v) => String(v || "").replace(/\D/g, "").slice(-10);

const router = express.Router();

/** Tag each call with its saved transcript summary, if any. */
async function withTranscripts(calls) {
  const map = await transcriptMap(calls.filter((c) => c.hasRecording).map((c) => c.sid));
  return calls.map((c) => {
    const t = map.get(c.sid);
    return t ? { ...c, transcript: { summary: t.summary, result: t.result, nextStep: t.nextStep } } : c;
  });
}

// GET /api/calls  — paginated, enriched call list
router.get("/", async (req, res) => {
  if (!isConfigured()) {
    return res
      .status(503)
      .json({ message: "Exotel not configured. Add EXOTEL_* keys to backend/.env" });
  }
  try {
    const q = (req.query.search || "").trim().toLowerCase();
    const handledBy = last10(req.query.handledBy);
    const outcome = String(req.query.outcome || "").trim(); // successful | unanswered
    const recording = req.query.recording === "1";
    const matched = String(req.query.matched || ""); // "1" | "0"
    const inPage = q || handledBy || outcome || recording || matched;

    // No filter → fast cursor pagination (one page from Exotel).
    if (!inPage) {
      const result = await fetchCalls({
        pageSize: Number(req.query.pageSize) || 20,
        after: req.query.after,
        before: req.query.before,
        from: req.query.from,
        to: req.query.to,
        direction: req.query.direction,
        status: req.query.status,
      });
      return res.json({ ...result, calls: await withTranscripts(result.calls) });
    }

    // Filter active → scan the WHOLE window so the filter covers every call,
    // not just the first page. Client paginates the returned set.
    let calls = await fetchAllCalls({ from: req.query.from, to: req.query.to });

    if (handledBy) {
      calls = calls.filter((c) => last10(c.agentNumber) === handledBy);
    }
    if (outcome === "successful") {
      calls = calls.filter((c) => c.outcome === "successful");
    } else if (outcome === "unanswered") {
      calls = calls.filter((c) => c.outcome !== "successful");
    }
    if (recording) calls = calls.filter((c) => c.hasRecording);
    if (matched === "1") calls = calls.filter((c) => c.lead);
    else if (matched === "0") calls = calls.filter((c) => !c.lead);
    if (q) {
      const digits = q.replace(/\D/g, "");
      calls = calls.filter((c) => {
        const hay = `${c.from} ${c.to} ${c.customerNumber} ${
          c.agentName || ""
        } ${c.lead?.clientName || ""} ${c.lead?.salesExec || ""}`.toLowerCase();
        return (
          hay.includes(q) ||
          (digits && `${c.from}${c.to}`.replace(/\D/g, "").includes(digits))
        );
      });
    }

    res.json({
      calls: await withTranscripts(calls),
      metadata: {
        total: calls.length,
        pageSize: calls.length,
        nextCursor: null,
        prevCursor: null,
      },
    });
  } catch (err) {
    res.status(502).json({ message: err.message });
  }
});

// GET /api/calls/callers — one row per UNIQUE caller (deduped by phone), with counts
router.get("/callers", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ message: "Exotel not configured" });
  try {
    let calls = await fetchAllCalls({ from: req.query.from, to: req.query.to });
    const hb = last10(req.query.handledBy);
    if (hb) calls = calls.filter((c) => last10(c.agentNumber) === hb);
    const q = (req.query.search || "").trim().toLowerCase();

    const map = new Map(); // last10(customer) -> caller row
    for (const c of calls) {
      const k = last10(c.customerNumber);
      if (!k) continue;
      const cur =
        map.get(k) || {
          customerNumber: c.customerNumber,
          calls: 0,
          answered: 0,
          withRecording: 0,
          lastAt: c.startTime || c.dateCreated,
          lastOutcome: c.outcome,
          agentName: c.agentName || "",
          lead: c.lead || null,
        };
      cur.calls += 1;
      if (c.answered) cur.answered += 1;
      if (c.hasRecording) cur.withRecording += 1;
      // calls are newest-first, so the first seen is the latest
      if (c.lead && !cur.lead) cur.lead = c.lead;
      if (c.agentName && !cur.agentName) cur.agentName = c.agentName;
      map.set(k, cur);
    }
    let callers = [...map.values()];
    if (q) {
      callers = callers.filter((r) => {
        const hay = `${r.customerNumber} ${r.agentName} ${
          r.lead?.clientName || ""
        }`.toLowerCase();
        return hay.includes(q);
      });
    }
    callers.sort((a, b) => b.calls - a.calls);
    res.json({ callers, total: callers.length, totalCalls: calls.length });
  } catch (err) {
    res.status(502).json({ message: err.message });
  }
});

// GET /api/calls/stats  — aggregate stats (default today)
router.get("/stats", async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ configured: false });
  }
  try {
    const stats = await fetchStats({
      from: req.query.from,
      to: req.query.to,
      handledBy: req.query.handledBy,
      search: req.query.search,
    });
    res.json({ configured: true, ...stats });
  } catch (err) {
    res.status(502).json({ message: err.message });
  }
});

// GET /api/calls/agents  — distinct answering agents + their saved names
router.get("/agents", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ configured: false });
  try {
    const agents = await fetchAgents({ from: req.query.from, to: req.query.to });
    res.json({ configured: true, agents });
  } catch (err) {
    res.status(502).json({ message: err.message });
  }
});

// GET /api/calls/agent-stats  — answered/total calls per agent over a window
router.get("/agent-stats", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ configured: false, agents: [] });
  try {
    const agents = await fetchAgentCallCounts({
      from: req.query.from,
      to: req.query.to,
    });
    res.json({ configured: true, agents });
  } catch (err) {
    res.status(502).json({ message: err.message });
  }
});

// PUT /api/calls/agents  — save agent names (admin only)
router.put("/agents", async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ message: "Admin only" });
  try {
    const agents = Array.isArray(req.body?.agents) ? req.body.agents : [];
    res.json({ configured: true, agents: await saveAgents(agents) });
  } catch (err) {
    res.status(502).json({ message: err.message });
  }
});

// POST /api/calls/connect { to }  — ring the logged-in user's phone, then the customer
router.post("/connect", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ message: "Exotel not configured" });
  const to = String(req.body?.to || "").replace(/[^\d+]/g, "");
  if (last10(to).length !== 10) {
    return res.status(400).json({ message: "Enter a valid 10-digit phone number" });
  }
  try {
    const me = await User.findById(req.userId).select("phone").lean();
    const from = last10(me?.phone);
    if (from.length !== 10) {
      return res.status(400).json({ message: "Your login has no valid phone number to ring" });
    }
    const call = await connectCall({ agentNumber: `0${from}`, customerNumber: `0${last10(to)}` });
    res.json({ ...call, ringing: from });
  } catch (err) {
    res.status(502).json({ message: err.message });
  }
});

// GET /api/calls/:sid/transcript  — the saved transcript (404 if not made yet)
router.get("/:sid/transcript", async (req, res) => {
  const t = await CallTranscript.findOne({ sid: req.params.sid }).lean();
  if (!t) {
    return res.status(404).json({ message: "Not transcribed yet", configured: transcriptionConfigured() });
  }
  res.json(t);
});

// POST /api/calls/:sid/transcript  — transcribe the recording (?force=1 to redo)
router.post("/:sid/transcript", async (req, res) => {
  try {
    const t = await transcribeCall(req.params.sid, {
      force: req.query.force === "1",
      by: req.userName,
    });
    res.json(t);
  } catch (err) {
    res.status(err.status || 502).json({ message: err.message });
  }
});

// GET /api/calls/:sid/recording  — proxy the recording audio
router.get("/:sid/recording", async (req, res) => {
  if (!isConfigured()) return res.status(503).end();
  try {
    const r = await fetchRecording(req.params.sid);
    if (!r.ok) return res.status(r.status).json({ message: r.message });
    res.setHeader("Content-Type", r.contentType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(r.buffer);
  } catch (err) {
    res.status(502).json({ message: err.message });
  }
});

module.exports = router;
