const express = require("express");
const bcrypt = require("bcryptjs");
const User = require("../models/User");

const router = express.Router();

const normalizePhone = (p) => String(p || "").replace(/\D/g, "").trim();

// All routes here are admin-only.
router.use((req, res, next) => {
  if (!req.isAdmin) return res.status(403).json({ message: "Admin only" });
  next();
});

// GET /api/users — list all users
router.get("/", async (_req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json({ users: users.map((u) => u.toPublicJSON()) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/users — create a new login
router.post("/", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || "").trim();
    const role = req.body.role === "admin" ? "admin" : "sales";

    if (!name) return res.status(400).json({ message: "Name is required" });
    if (!phone || phone.length < 10)
      return res.status(400).json({ message: "Valid phone (min 10 digits) required" });
    if (!password || password.length < 6)
      return res.status(400).json({ message: "Password must be at least 6 characters" });

    const existing = await User.findOne({ phone });
    if (existing)
      return res.status(409).json({ message: "That phone number already has a login" });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, phone, passwordHash, role });
    res.status(201).json({ user: user.toPublicJSON() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/users/:id — update name / role / reset password
router.patch("/:id", async (req, res) => {
  try {
    const update = {};
    if (req.body.name) update.name = String(req.body.name).trim();
    if (req.body.role) update.role = req.body.role === "admin" ? "admin" : "sales";
    if (req.body.password) {
      if (String(req.body.password).length < 6)
        return res.status(400).json({ message: "Password must be at least 6 characters" });
      update.passwordHash = await bcrypt.hash(String(req.body.password), 10);
    }
    // Don't let an admin strip their own admin role (avoid lock-out).
    if (req.params.id === req.userId && update.role === "sales") {
      return res.status(400).json({ message: "You can't remove your own admin access" });
    }
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ user: user.toPublicJSON() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/users/:id — remove a login
router.delete("/:id", async (req, res) => {
  try {
    if (req.params.id === req.userId)
      return res.status(400).json({ message: "You can't delete your own account" });
    const removed = await User.findByIdAndDelete(req.params.id);
    if (!removed) return res.status(404).json({ message: "User not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
