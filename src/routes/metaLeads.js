const express = require("express");
const MetaLead = require("../models/MetaLead");
const { syncMeta, getLastSync, csvUrl } = require("../services/metaSyncService");

const router = express.Router();

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildFilter(q = {}) {
  const f = {};
  if (q.salesExec) f.salesExec = q.salesExec;
  if (q.query) f.query = q.query;
  if (q.status) f.status = q.status;
  if (q.month) f.month = { $in: String(q.month).split(",") };
  if (q.from || q.to) {
    f.date = {};
    if (q.from) f.date.$gte = new Date(`${q.from}T00:00:00Z`);
    if (q.to) f.date.$lte = new Date(`${q.to}T23:59:59Z`);
  }
  if (q.search) {
    const rx = new RegExp(escapeRe(String(q.search).trim()), "i");
    f.$or = [
      { clientName: rx },
      { company: rx },
      { contactNo: rx },
      { email: rx },
      { remarks: rx },
    ];
  }
  return f;
}

// GET /api/meta-leads — paginated list
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const filter = buildFilter(req.query);

    const sortBy = String(req.query.sortBy || "date");
    const dir = req.query.sortDir === "asc" ? 1 : -1;
    const sort = { [sortBy]: dir, _id: -1 };

    const [items, total] = await Promise.all([
      MetaLead.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      MetaLead.countDocuments(filter),
    ]);
    res.json({ items, total, page, pages: Math.ceil(total / limit) || 1, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/meta-leads/analytics
router.get("/analytics", async (req, res) => {
  try {
    const filter = buildFilter(req.query);
    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    const [agg, byExec, byQuery, byStatus, monthlyAgg, uniqueClients] =
      await Promise.all([
        MetaLead.aggregate([
          { $match: filter },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              totalWorth: { $sum: { $ifNull: ["$leadWorth", 0] } },
            },
          },
        ]),
        MetaLead.aggregate([
          { $match: filter },
          {
            $group: {
              _id: "$salesExec",
              leads: { $sum: 1 },
              worth: { $sum: { $ifNull: ["$leadWorth", 0] } },
            },
          },
          { $sort: { worth: -1 } },
        ]),
        MetaLead.aggregate([
          { $match: filter },
          {
            $group: {
              _id: "$query",
              value: { $sum: 1 },
              worth: { $sum: { $ifNull: ["$leadWorth", 0] } },
            },
          },
          { $sort: { value: -1 } },
        ]),
        MetaLead.aggregate([
          { $match: filter },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ]),
        MetaLead.aggregate([
          { $match: { ...filter, date: { $ne: null } } },
          {
            $group: {
              _id: { y: { $year: "$date" }, m: { $month: "$date" } },
              leads: { $sum: 1 },
              worth: { $sum: { $ifNull: ["$leadWorth", 0] } },
            },
          },
          { $sort: { "_id.y": 1, "_id.m": 1 } },
        ]),
        MetaLead.distinct("contactNo", filter),
      ]);

    const a = agg[0] || { count: 0, totalWorth: 0 };
    const statusMap = Object.fromEntries(byStatus.map((d) => [d._id, d.count]));

    res.json({
      totals: {
        count: a.count,
        totalWorth: a.totalWorth,
        avgWorth: a.count ? Math.round(a.totalWorth / a.count) : 0,
        uniqueClients: uniqueClients.filter(Boolean).length,
        won: statusMap.won || 0,
        lost: statusMap.lost || 0,
        open: statusMap.open || 0,
      },
      byExec: byExec.map((d) => ({
        name: d._id || "Unassigned",
        leads: d.leads,
        worth: d.worth,
      })),
      byQuery: byQuery.map((d) => ({
        name: d._id || "Not specified",
        value: d.value,
        worth: d.worth,
      })),
      monthly: monthlyAgg.map((d) => ({
        name: `${monthNames[d._id.m - 1]} ${String(d._id.y).slice(2)}`,
        leads: d.leads,
        worth: d.worth,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/meta-leads/options — filter dropdown values
router.get("/options", async (_req, res) => {
  try {
    const [salesExec, query, months] = await Promise.all([
      MetaLead.distinct("salesExec"),
      MetaLead.distinct("query"),
      MetaLead.distinct("month"),
    ]);
    const midx = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const monthKey = (m) => {
      const x = String(m).match(/([A-Za-z]+)\s+(\d{4})/);
      if (!x) return Number.MAX_SAFE_INTEGER;
      return Number(x[2]) * 12 + (midx[x[1]] ?? 99);
    };
    res.json({
      salesExec: salesExec.filter(Boolean).sort(),
      query: query.filter(Boolean).sort(),
      months: months.filter(Boolean).sort((x, y) => monthKey(x) - monthKey(y)),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/meta-leads/sync/status
router.get("/sync/status", (_req, res) => {
  res.json({ ...getLastSync(), source: csvUrl() });
});

// POST /api/meta-leads/sync — manual refresh (admin only)
router.post("/sync", async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ message: "Admin only" });
  const result = await syncMeta({ silent: false });
  res.status(result.ok ? 200 : 502).json(result);
});

module.exports = router;
