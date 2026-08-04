const express = require("express");
const Task = require("../models/Task");
const { todayBusinessDate } = require("../lib/businessDate");

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITIES = ["low", "normal", "high"];

/** "2026-08-04" or "" if the value is not a valid calendar date string. */
function cleanDate(v) {
  const s = String(v || "").trim();
  return DATE_RE.test(s) ? s : "";
}

/** "9:5" -> "09:05"; anything unparseable -> "". */
function cleanTime(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  const m = s.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return "";
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * Whose tasks this request may see. Everyone sees their own; an admin asking
 * for scope=all sees the whole team, and may also target one person.
 */
function ownerFilter(req) {
  if (req.isAdmin && req.query.scope === "all") {
    return req.query.userId ? { userId: req.query.userId } : {};
  }
  return { userId: req.userId };
}

// untimed tasks sort last within a day, then high priority first
const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };
function sortTasks(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (!!a.time !== !!b.time) return a.time ? -1 : 1;
  if (a.time && b.time && a.time !== b.time) return a.time < b.time ? -1 : 1;
  const pa = PRIORITY_ORDER[a.priority] ?? 1;
  const pb = PRIORITY_ORDER[b.priority] ?? 1;
  if (pa !== pb) return pa - pb;
  return new Date(a.createdAt) - new Date(b.createdAt);
}

/* --------------------------------- routes -------------------------------- */

// GET /api/tasks?from=&to=&scope=&userId=  — tasks in a date range (a month grid,
// or a single day when from === to)
router.get("/", async (req, res) => {
  try {
    const today = todayBusinessDate();
    const from = cleanDate(req.query.from) || today;
    const to = cleanDate(req.query.to) || from;

    const filter = { ...ownerFilter(req), date: { $gte: from, $lte: to } };
    if (req.query.done === "1") filter.done = true;
    if (req.query.done === "0") filter.done = false;

    const items = (await Task.find(filter).limit(2000).lean()).sort(sortTasks);

    // per-day tallies so the month grid can show dots without a second request
    const byDate = {};
    for (const t of items) {
      const d = (byDate[t.date] ||= { date: t.date, total: 0, done: 0 });
      d.total += 1;
      if (t.done) d.done += 1;
    }

    res.json({
      from,
      to,
      today,
      scope: req.isAdmin && req.query.scope === "all" ? "all" : "mine",
      items,
      byDate: Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1)),
      total: items.length,
      openTotal: items.filter((t) => !t.done).length,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/tasks/summary — counts for the badge / "my day" strip
router.get("/summary", async (req, res) => {
  try {
    const today = todayBusinessDate();
    const owner = ownerFilter(req);

    const [todayOpen, todayDone, overdue] = await Promise.all([
      Task.countDocuments({ ...owner, date: today, done: false }),
      Task.countDocuments({ ...owner, date: today, done: true }),
      // anything still open on a day that has already passed
      Task.countDocuments({ ...owner, date: { $lt: today }, done: false }),
    ]);

    res.json({ today, todayOpen, todayDone, overdue });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/tasks — add a task to a day (defaults to today)
router.post("/", async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || "").trim();
    if (!title) {
      return res.status(400).json({ message: "Task title is required" });
    }

    const date = cleanDate(b.date) || todayBusinessDate();

    const task = await Task.create({
      userId: req.userId,
      userName: req.userName || "",
      date,
      time: cleanTime(b.time),
      title: title.slice(0, 200),
      note: String(b.note || "").trim().slice(0, 2000),
      priority: PRIORITIES.includes(b.priority) ? b.priority : "normal",
      leadId: String(b.leadId || "").trim(),
      done: false,
    });

    res.status(201).json(task.toObject());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/tasks/:id — edit, reschedule, or tick off
router.patch("/:id", async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: "Task not found" });

    // a task belongs to the person who wrote it
    if (String(task.userId) !== String(req.userId)) {
      return res.status(403).json({ message: "That task belongs to someone else" });
    }

    const b = req.body || {};

    if (b.title !== undefined) {
      const title = String(b.title).trim();
      if (!title) return res.status(400).json({ message: "Title cannot be empty" });
      task.title = title.slice(0, 200);
    }
    if (b.note !== undefined) task.note = String(b.note).trim().slice(0, 2000);
    if (b.date !== undefined) {
      const date = cleanDate(b.date);
      if (!date) return res.status(400).json({ message: "Invalid date" });
      task.date = date;
    }
    if (b.time !== undefined) task.time = cleanTime(b.time);
    if (b.priority !== undefined && PRIORITIES.includes(b.priority)) {
      task.priority = b.priority;
    }
    if (b.done !== undefined) {
      task.done = Boolean(b.done);
      task.doneAt = task.done ? new Date() : null;
    }

    await task.save();
    res.json(task.toObject());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/tasks/:id
router.delete("/:id", async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: "Task not found" });
    if (String(task.userId) !== String(req.userId)) {
      return res.status(403).json({ message: "That task belongs to someone else" });
    }
    await task.deleteOne();
    res.json({ message: "Task deleted", _id: req.params.id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
