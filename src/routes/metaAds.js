const express = require("express");
const {
  config,
  getOverview,
  getLeads,
  getAllCampaigns,
  getStatus,
  saveFollowUp,
  getFollowUp,
  getHandlers,
} = require("../services/metaAdsService");

const router = express.Router();

// Meta Ads (Live) is restricted: the main admin, plus whoever the main admin has granted access.
router.use((req, res, next) => {
  if (!req.metaAdsAccess) {
    return res.status(403).json({ message: "You don't have access to Meta Ads. Ask the main admin." });
  }
  next();
});

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function rangeFrom(q = {}) {
  if (ISO.test(q.since || "") && ISO.test(q.until || "")) {
    return { since: q.since, until: q.until };
  }
  return { preset: q.preset || "last_30d" };
}

function notConfigured(res) {
  return res.status(400).json({
    message: "Meta Ads is not connected. Add META_ADS_ACCESS_TOKEN and META_AD_ACCOUNT_ID to backend/.env",
    configured: false,
  });
}

// GET /api/meta-ads/status — is the token set, and does it work?
router.get("/status", async (_req, res) => {
  res.json(await getStatus());
});

// GET /api/meta-ads/overview?preset=last_30d | since=&until= [&refresh=1]
router.get("/overview", async (req, res) => {
  if (!config().configured) return notConfigured(res);
  try {
    res.json(await getOverview(rangeFrom(req.query), req.query.refresh === "1"));
  } catch (err) {
    res.status(502).json({ message: err.message, code: err.code });
  }
});

// GET /api/meta-ads/leads?preset=last_30d | since=&until= [&refresh=1]
router.get("/leads", async (req, res) => {
  if (!config().configured) return notConfigured(res);
  try {
    res.json(await getLeads(rangeFrom(req.query), req.query.refresh === "1"));
  } catch (err) {
    res.status(502).json({ message: err.message, code: err.code });
  }
});

// GET /api/meta-ads/campaigns — every campaign (id, name, status) for the filter
router.get("/campaigns", async (req, res) => {
  if (!config().configured) return notConfigured(res);
  try {
    res.json({ campaigns: await getAllCampaigns(req.query.refresh === "1") });
  } catch (err) {
    res.status(502).json({ message: err.message, code: err.code });
  }
});

// GET /api/meta-ads/handlers — names for the "Handled by" picker
router.get("/handlers", async (_req, res) => {
  try {
    res.json({ handlers: await getHandlers() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/meta-ads/leads/:id/follow-up — current state + full history
router.get("/leads/:id/follow-up", async (req, res) => {
  try {
    res.json({ followUp: await getFollowUp(req.params.id) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/meta-ads/leads/:id/follow-up — { stage, assignedTo, nextFollowUpAt, note, name, phone, campaignName }
router.put("/leads/:id/follow-up", async (req, res) => {
  try {
    const f = await saveFollowUp(req.params.id, req.body || {}, req.userName);
    res.json({ followUp: f });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
