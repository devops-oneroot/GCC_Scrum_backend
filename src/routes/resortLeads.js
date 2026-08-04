const express = require("express");
const ResortLead = require("../models/ResortLead");
const ResortActivity = require("../models/ResortActivity");
const {
  syncFromSheet,
  getLastSync,
  getCsvUrl,
} = require("../services/resortSyncService");
const { STATUS_META } = require("../lib/resortNormalize");
const { clearLeadCache } = require("../services/exotelService");

const router = express.Router();

const VALID_STATUS = ["new", "ongoing", "onboarded", "lost", "other"];

const MONTH_IDX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
/** "June 2026" -> sortable number (year*12 + month). Unknown names sort last. */
function monthKey(name) {
  const m = String(name || "").match(/([A-Za-z]+)\s+(\d{4})/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const mon = MONTH_IDX[m[1].slice(0, 3).toLowerCase()];
  if (mon === undefined) return Number.MAX_SAFE_INTEGER;
  return Number(m[2]) * 12 + mon;
}

/* --------------------------- helpers --------------------------- */

function buildFilter(q) {
  const filter = {};
  if (q.status) filter.status = { $in: String(q.status).split(",") };
  if (q.salesExec) filter.salesExec = { $in: String(q.salesExec).split(",") };
  if (q.query) filter.query = { $in: String(q.query).split(",") };
  if (q.source) filter.leadSource = { $in: String(q.source).split(",") };
  if (q.priority) filter.priorityCode = { $in: String(q.priority).split(",") };
  if (q.month) filter.sheetMonth = { $in: String(q.month).split(",") };
  if (q.starred === "1") filter.starred = true;

  if (q.from || q.to) {
    filter.enquiryDate = {};
    if (q.from) filter.enquiryDate.$gte = new Date(q.from);
    if (q.to) filter.enquiryDate.$lte = new Date(`${q.to}T23:59:59.999Z`);
  }

  const search = (q.search || "").trim();
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { leadId: rx },
      { clientName: rx },
      { contactNo: rx },
      { companyName: rx },
      { comment: rx },
      { salesExec: rx },
    ];
  }
  return filter;
}

/**
 * Money a single enquiry represents: the quote once one has been given,
 * otherwise the approx-revenue estimate. Same rule everywhere so section
 * values, exec values and the grand total always add up.
 */
const LEAD_VALUE = {
  $cond: [
    { $gt: [{ $ifNull: ["$quote", 0] }, 0] },
    "$quote",
    { $ifNull: ["$approxRevenue", 0] },
  ],
};

/** Sum LEAD_VALUE only for enquiries in one of the given statuses. */
const valueWhereStatus = (statuses) => ({
  $sum: { $cond: [{ $in: ["$status", statuses] }, LEAD_VALUE, 0] },
});

/** Count only enquiries in one of the given statuses. */
const countWhereStatus = (statuses) => ({
  $sum: { $cond: [{ $in: ["$status", statuses] }, 1, 0] },
});

/** Still in play — not yet won or lost. */
const OPEN_STATUSES = ["new", "ongoing"];

const SORT_FIELDS = {
  enquiryDate: "enquiryDate",
  bookingDate: "bookingDate",
  quote: "quote",
  approxRevenue: "approxRevenue",
  priority: "priorityRank",
  followUpCount: "followUpCount",
  clientName: "clientName",
  createdAt: "createdAt",
};

/* --------------------------- routes --------------------------- */

// GET /api/resort-leads  — filtered, sorted, paginated list
router.get("/", async (req, res) => {
  try {
    const filter = buildFilter(req.query);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    const sortField = SORT_FIELDS[req.query.sortBy] || "enquiryDate";
    const dir = req.query.sortDir === "asc" ? 1 : -1;

    const [items, total] = await Promise.all([
      ResortLead.find(filter)
        .sort({ [sortField]: dir, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ResortLead.countDocuments(filter),
    ]);

    res.json({
      items,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/resort-leads — create an app-origin enquiry (e.g. from a call)
router.post("/", async (req, res) => {
  try {
    const b = req.body || {};
    const contactNo = String(b.contactNo || "").trim();
    if (!contactNo && !String(b.clientName || "").trim()) {
      return res
        .status(400)
        .json({ message: "A contact number or client name is required" });
    }

    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    const leadId = String(b.leadId || "").trim() || `APP-${Date.now().toString(36).toUpperCase()}-${rand}`;

    const status = VALID_STATUS.includes(b.status) ? b.status : "new";

    const lead = await ResortLead.create({
      leadId,
      origin: "app",
      clientName: String(b.clientName || "").trim(),
      contactNo,
      query: String(b.query || "General Inquiry").trim(),
      leadSource: String(b.leadSource || "Call").trim(),
      salesExec: String(b.salesExec || "Unassigned").trim() || "Unassigned",
      bookingDate: b.bookingDate ? new Date(b.bookingDate) : undefined,
      pax: b.pax != null && b.pax !== "" ? Number(b.pax) : null,
      approxRevenue:
        b.approxRevenue != null && b.approxRevenue !== ""
          ? Number(b.approxRevenue)
          : null,
      quote: b.quote != null && b.quote !== "" ? Number(b.quote) : null,
      comment: String(b.comment || "").trim(),
      status,
      enquiryDate: new Date(),
    });

    await ResortActivity.create({
      type: "enquiry_created",
      source: "user",
      leadId: lead.leadId,
      leadRef: lead._id,
      clientName: lead.clientName,
      salesExec: lead.salesExec,
      query: lead.query,
      toStatus: lead.status,
      userId: req.userId,
      userName: req.userName,
      detail: `Enquiry ${lead.leadId} created in CRM${
        contactNo ? ` for ${contactNo}` : ""
      }`,
    });

    // so a linked call shows "matched" right away
    if (typeof clearLeadCache === "function") clearLeadCache();

    res.status(201).json(lead.toObject());
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "That Lead ID already exists" });
    }
    res.status(500).json({ message: err.message });
  }
});

// GET /api/resort-leads/options — distinct values for filter dropdowns
router.get("/options", async (_req, res) => {
  try {
    const [salesExec, query, source, priority, monthsAgg] = await Promise.all([
      ResortLead.distinct("salesExec"),
      ResortLead.distinct("query"),
      ResortLead.distinct("leadSource"),
      ResortLead.distinct("priorityCode"),
      ResortLead.distinct("sheetMonth"),
    ]);
    res.json({
      salesExec: salesExec.filter(Boolean).sort(),
      query: query.filter(Boolean).sort(),
      source: source.filter(Boolean).sort(),
      priority: priority.filter(Boolean).sort(),
      // chronological by the month name itself (e.g. "Jan 2026" -> "July 2026")
      months: monthsAgg.filter(Boolean).sort((a, b) => monthKey(a) - monthKey(b)),
      statuses: Object.entries(STATUS_META).map(([id, m]) => ({
        id,
        label: m.label,
        stage: m.stage,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/resort-leads/analytics — dashboard aggregates
router.get("/analytics", async (req, res) => {
  try {
    const filter = buildFilter(req.query);

    // count + money value for every bucket of `field`
    const groupCount = (field) => [
      { $match: filter },
      {
        $group: {
          _id: `$${field}`,
          count: { $sum: 1 },
          amount: { $sum: LEAD_VALUE },
        },
      },
      { $sort: { count: -1 } },
    ];

    const [
      byStatus,
      bySource,
      byQuery,
      byExec,
      byPriority,
      revenueAgg,
      monthlyAgg,
      execPerf,
    ] = await Promise.all([
      ResortLead.aggregate(groupCount("status")),
      ResortLead.aggregate(groupCount("leadSource")),
      ResortLead.aggregate(groupCount("query")),
      ResortLead.aggregate(groupCount("salesExec")),
      ResortLead.aggregate(groupCount("priorityCode")),
      ResortLead.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalApprox: { $sum: { $ifNull: ["$approxRevenue", 0] } },
            totalQuote: { $sum: { $ifNull: ["$quote", 0] } },
            wonQuote: {
              $sum: {
                $cond: [
                  { $eq: ["$status", "onboarded"] },
                  { $ifNull: ["$quote", 0] },
                  0,
                ],
              },
            },
            wonApprox: {
              $sum: {
                $cond: [
                  { $eq: ["$status", "onboarded"] },
                  { $ifNull: ["$approxRevenue", 0] },
                  0,
                ],
              },
            },
            // Value lost to "lost" enquiries — use the quote if present, else the
            // approx revenue estimate, so a lost lead always contributes its best figure.
            lostValue: valueWhereStatus(["lost"]),
            // Every enquiry's best figure, whatever its status — the denominator
            // for "what share of the money did we actually convert?".
            totalValue: { $sum: LEAD_VALUE },
            // Still winnable: new + ongoing only.
            openValue: valueWhereStatus(OPEN_STATUSES),
            wonValue: valueWhereStatus(["onboarded"]),
          },
        },
      ]),
      ResortLead.aggregate([
        { $match: { ...filter, enquiryDate: { $ne: null } } },
        {
          $group: {
            _id: {
              y: { $year: "$enquiryDate" },
              m: { $month: "$enquiryDate" },
            },
            enquiries: { $sum: 1 },
            won: {
              $sum: { $cond: [{ $eq: ["$status", "onboarded"] }, 1, 0] },
            },
          },
        },
        { $sort: { "_id.y": 1, "_id.m": 1 } },
      ]),
      ResortLead.aggregate([
        { $match: filter },
        {
          $group: {
            _id: "$salesExec",
            total: { $sum: 1 },
            won: countWhereStatus(["onboarded"]),
            lost: countWhereStatus(["lost"]),
            ongoing: countWhereStatus(["ongoing"]),
            fresh: countWhereStatus(["new"]),
            // what this person is still carrying
            open: countWhereStatus(OPEN_STATUSES),
            openValue: valueWhereStatus(OPEN_STATUSES),
            wonValue: valueWhereStatus(["onboarded"]),
            lostValue: valueWhereStatus(["lost"]),
            totalValue: { $sum: LEAD_VALUE },
          },
        },
        { $sort: { won: -1, total: -1 } },
      ]),
    ]);

    const total = byStatus.reduce((s, d) => s + d.count, 0);
    const statusMap = Object.fromEntries(byStatus.map((d) => [d._id, d.count]));
    const won = statusMap.onboarded || 0;
    const lost = statusMap.lost || 0;

    const rev = revenueAgg[0] || {};
    const monthNames = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];

    res.json({
      totals: {
        total,
        new: statusMap.new || 0,
        ongoing: statusMap.ongoing || 0,
        onboarded: won,
        lost,
        other: statusMap.other || 0,
        // Conversion = Onboarded ÷ Total Enquiries
        conversionRate: total ? Math.round((won / total) * 100) : 0,
        // Value conversion = won money ÷ all money that passed through
        valueConversionRate: rev.totalValue
          ? Math.round(((rev.wonValue || 0) / rev.totalValue) * 100)
          : 0,
        wonQuoteValue: rev.wonQuote || 0,
        wonApproxValue: rev.wonApprox || 0,
        pipelineApproxValue: rev.totalApprox || 0,
        totalQuoteValue: rev.totalQuote || 0,
        lostValue: rev.lostValue || 0,
        wonValue: rev.wonValue || 0,
        totalValue: rev.totalValue || 0,
        // only new + ongoing — money still winnable
        openValue: rev.openValue || 0,
      },
      byStatus: byStatus.map((d) => ({
        id: d._id,
        name: STATUS_META[d._id]?.label || d._id,
        value: d.count,
        amount: d.amount || 0,
        avg: d.count ? Math.round((d.amount || 0) / d.count) : 0,
        share: rev.totalValue
          ? Math.round(((d.amount || 0) / rev.totalValue) * 100)
          : 0,
      })),
      bySource: bySource.map((d) => ({
        name: d._id || "Unknown",
        value: d.count,
        amount: d.amount || 0,
      })),
      byQuery: byQuery.map((d) => ({
        name: d._id || "Unknown",
        value: d.count,
        amount: d.amount || 0,
      })),
      byExec: byExec.map((d) => ({
        name: d._id || "Unassigned",
        value: d.count,
        amount: d.amount || 0,
      })),
      byPriority: byPriority
        .filter((d) => d._id)
        .map((d) => ({ name: d._id, value: d.count }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      monthly: monthlyAgg.map((d) => ({
        name: `${monthNames[d._id.m - 1]} ${String(d._id.y).slice(2)}`,
        enquiries: d.enquiries,
        won: d.won,
      })),
      execPerformance: execPerf.map((d) => ({
        name: d._id || "Unassigned",
        total: d.total,
        won: d.won,
        lost: d.lost,
        ongoing: d.ongoing,
        new: d.fresh || 0,
        // still on this person's plate (new + ongoing)
        open: d.open || 0,
        openValue: d.openValue || 0,
        wonValue: d.wonValue || 0,
        lostValue: d.lostValue || 0,
        totalValue: d.totalValue || 0,
        // Conv. = Won ÷ Total enquiries handled by this exec
        conversion: d.total ? Math.round((d.won / d.total) * 100) : 0,
        // Same idea in money terms
        valueConversion: d.totalValue
          ? Math.round(((d.wonValue || 0) / d.totalValue) * 100)
          : 0,
        // this exec's share of every enquiry in the current filter
        loadShare: total ? Math.round((d.total / total) * 100) : 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/resort-leads/follow-ups — open enquiries bucketed by urgency.
// Accepts the same filters as the enquiries list (search, exec, type, priority,
// source, month), except status — this view is the open pipeline by definition,
// so status may only narrow to "new" or "ongoing".
router.get("/follow-ups", async (req, res) => {
  try {
    const filter = buildFilter(req.query);

    const asked = String(req.query.status || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => OPEN_STATUSES.includes(s));
    filter.status = { $in: asked.length ? asked : OPEN_STATUSES };

    const leads = await ResortLead.find(filter)
      .sort({ priorityRank: 1, bookingDate: 1 })
      .lean();

    // day boundaries in IST
    const now = new Date();
    const startOfToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    const in3 = new Date(startOfToday.getTime() + 3 * 86400000);

    const buckets = { overdue: [], today: [], soon: [], upcoming: [], noDate: [] };
    for (const l of leads) {
      const ref = l.nextFollowUpAt || l.bookingDate;
      if (!ref) {
        buckets.noDate.push(l);
        continue;
      }
      const d = new Date(ref);
      if (d < startOfToday) buckets.overdue.push(l);
      else if (d < new Date(startOfToday.getTime() + 86400000))
        buckets.today.push(l);
      else if (d < in3) buckets.soon.push(l);
      else buckets.upcoming.push(l);
    }

    // same value rule as the analytics tab: quote, else the approx estimate
    const leadValue = (l) =>
      Number(l.quote) > 0 ? Number(l.quote) : Number(l.approxRevenue) || 0;
    const sumValue = (arr) => arr.reduce((s, l) => s + leadValue(l), 0);

    res.json({
      counts: Object.fromEntries(
        Object.entries(buckets).map(([k, v]) => [k, v.length])
      ),
      // money sitting in each urgency bucket
      values: Object.fromEntries(
        Object.entries(buckets).map(([k, v]) => [k, sumValue(v)])
      ),
      totals: { count: leads.length, value: sumValue(leads) },
      buckets,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/resort-leads/activity — recent activity feed
router.get("/activity", async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
    const filter = {};
    if (req.query.salesExec) filter.salesExec = req.query.salesExec;
    if (req.query.leadId) filter.leadId = req.query.leadId;

    // Month filter: activities don't store the month, so join to the lead.
    if (req.query.month) {
      const months = String(req.query.month).split(",");
      const items = await ResortActivity.aggregate([
        { $match: filter },
        {
          $lookup: {
            from: "resortleads",
            localField: "leadId",
            foreignField: "leadId",
            as: "lead",
          },
        },
        { $match: { "lead.sheetMonth": { $in: months } } },
        { $sort: { createdAt: -1 } },
        { $limit: limit },
        { $project: { lead: 0 } },
      ]);
      return res.json({ items });
    }

    const items = await ResortActivity.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/resort-leads/sync/status
router.get("/sync/status", (_req, res) => {
  res.json({ ...getLastSync(), csvUrl: getCsvUrl() });
});

// POST /api/resort-leads/sync — manual refresh (admin only)
router.post("/sync", async (req, res) => {
  if (!req.isAdmin) {
    return res.status(403).json({ message: "Admin only" });
  }
  const result = await syncFromSheet();
  if (!result.ok) return res.status(502).json(result);
  res.json(result);
});

// GET /api/resort-leads/:id — single enquiry
router.get("/:id", async (req, res) => {
  try {
    const lead = await ResortLead.findById(req.params.id).lean();
    if (!lead) return res.status(404).json({ message: "Not found" });
    res.json(lead);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/resort-leads/:id — update APP-ONLY fields (never sheet fields)
router.patch("/:id", async (req, res) => {
  try {
    const lead = await ResortLead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: "Not found" });

    const { nextFollowUpAt, internalNote, reminderDone, starred } = req.body;
    const changes = [];

    if (nextFollowUpAt !== undefined) {
      lead.nextFollowUpAt = nextFollowUpAt ? new Date(nextFollowUpAt) : null;
      lead.reminderDone = false;
      changes.push("followup_set");
    }
    if (internalNote !== undefined) {
      lead.internalNote = String(internalNote);
      changes.push("note_added");
    }
    if (reminderDone !== undefined) {
      lead.reminderDone = Boolean(reminderDone);
      if (lead.reminderDone) changes.push("reminder_done");
    }
    if (starred !== undefined) lead.starred = Boolean(starred);

    await lead.save();

    for (const type of changes) {
      await ResortActivity.create({
        type,
        source: "user",
        leadId: lead.leadId,
        leadRef: lead._id,
        clientName: lead.clientName,
        salesExec: lead.salesExec,
        query: lead.query,
        userId: req.userId,
        userName: req.userName,
        detail:
          type === "followup_set"
            ? `Follow-up set for ${lead.leadId}${
                lead.nextFollowUpAt
                  ? " → " + lead.nextFollowUpAt.toISOString().slice(0, 10)
                  : ""
              }`
            : type === "note_added"
            ? `Note updated on ${lead.leadId}`
            : `Reminder cleared on ${lead.leadId}`,
      });
    }

    res.json(lead.toObject());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
