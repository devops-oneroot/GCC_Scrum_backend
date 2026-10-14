const express = require("express");
const { config, getOverview, getLeads, getStatus } = require("../services/metaAdsService");

const router = express.Router();

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

module.exports = router;
