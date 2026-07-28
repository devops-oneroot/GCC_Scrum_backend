const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, ".env"),
  override: true,
});

const express = require("express");
const cors = require("cors");
const connectDB = require("./src/config/db");
const migrateAdmin = require("./src/config/migrateAdmin");
const authRouter = require("./src/routes/auth");
const { requireAuth } = require("./src/middleware/auth");
const resortLeadsRouter = require("./src/routes/resortLeads");
const callsRouter = require("./src/routes/calls");
const assistantRouter = require("./src/routes/assistant");
const metaLeadsRouter = require("./src/routes/metaLeads");
const { startAutoSync } = require("./src/services/resortSyncService");
const { startAutoSync: startMetaAutoSync } = require("./src/services/metaSyncService");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    message: "GCC Resort Sales CRM connected 🏝️",
  });
});

app.use("/api/auth", authRouter);
app.use("/api/resort-leads", requireAuth, resortLeadsRouter);
app.use("/api/calls", requireAuth, callsRouter);
app.use("/api/assistant", requireAuth, assistantRouter);
app.use("/api/meta-leads", requireAuth, metaLeadsRouter);

async function start() {
  try {
    await connectDB();
    await migrateAdmin();

    // Sheet → App mirror: sync once on boot, then on an interval.
    startAutoSync();
    startMetaAutoSync();

    app.listen(PORT, () => {
      console.log(
        `🚀 GCC Resort Sales CRM running on http://localhost:${PORT}`
      );
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);
    process.exit(1);
  }
}

start();
