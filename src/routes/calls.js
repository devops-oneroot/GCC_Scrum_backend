const express = require("express");
const {
  isConfigured,
  fetchCalls,
  fetchStats,
  fetchAgents,
  fetchAgentCallCounts,
  saveAgents,
  fetchRecording,
} = require("../services/exotelService");

const router = express.Router();

// GET /api/calls  — paginated, enriched call list
router.get("/", async (req, res) => {
  if (!isConfigured()) {
    return res
      .status(503)
      .json({ message: "Exotel not configured. Add EXOTEL_* keys to backend/.env" });
  }
  try {
    const q = (req.query.search || "").trim().toLowerCase();
    const handledBy = String(req.query.handledBy || "")
      .replace(/\D/g, "")
      .slice(-10);
    const outcome = String(req.query.outcome || "").trim(); // successful | unanswered
    const recording = req.query.recording === "1";
    const matched = String(req.query.matched || ""); // "1" | "0"
    const inPage = q || handledBy || outcome || recording || matched;
    // When filtering in-page, pull a bigger page so the filter has more to work with.
    const requested = Number(req.query.pageSize) || 20;
    const pageSize = inPage ? Math.max(requested, 100) : requested;

    const result = await fetchCalls({
      pageSize,
      after: req.query.after,
      before: req.query.before,
      from: req.query.from,
      to: req.query.to,
      direction: req.query.direction,
      status: req.query.status,
    });

    // optional in-page "handled by" (answering agent) filter
    if (handledBy) {
      result.calls = result.calls.filter(
        (c) => c.agentNumber.replace(/\D/g, "").slice(-10) === handledBy
      );
    }

    // stat-tile filters
    if (outcome === "successful") {
      result.calls = result.calls.filter((c) => c.outcome === "successful");
    } else if (outcome === "unanswered") {
      result.calls = result.calls.filter((c) => c.outcome !== "successful");
    }
    if (recording) {
      result.calls = result.calls.filter((c) => c.hasRecording);
    }
    if (matched === "1") {
      result.calls = result.calls.filter((c) => c.lead);
    } else if (matched === "0") {
      result.calls = result.calls.filter((c) => !c.lead);
    }

    // optional in-page phone/name search
    if (q) {
      const digits = q.replace(/\D/g, "");
      result.calls = result.calls.filter((c) => {
        const hay = `${c.from} ${c.to} ${c.customerNumber} ${
          c.agentName || ""
        } ${c.lead?.clientName || ""} ${c.lead?.salesExec || ""}`.toLowerCase();
        return (
          hay.includes(q) ||
          (digits && `${c.from}${c.to}`.replace(/\D/g, "").includes(digits))
        );
      });
    }

    res.json(result);
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
    const stats = await fetchStats({ from: req.query.from, to: req.query.to });
    res.json({ configured: true, ...stats });
  } catch (err) {
    res.status(502).json({ message: err.message });
  }
});

// GET /api/calls/agents  — distinct answering agents + their saved names
router.get("/agents", async (_req, res) => {
  if (!isConfigured()) return res.status(503).json({ configured: false });
  try {
    res.json({ configured: true, agents: await fetchAgents() });
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
