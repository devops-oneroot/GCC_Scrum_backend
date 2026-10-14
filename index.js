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
const metaAdsRouter = require("./src/routes/metaAds");
const usersRouter = require("./src/routes/users");
const tasksRouter = require("./src/routes/tasks");
const emailsRouter = require("./src/routes/emails");
const { router: whatsappRouter, webhook: whatsappWebhook } = require("./src/routes/whatsapp");
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

app.use(
  express.json({
    // the WhatsApp webhook signature is computed over the raw body
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    message: "GCC Resort Sales CRM connected 🏝️",
  });
});

// The public IP this server goes out on — the value to whitelist in the Exotel
// dashboard so recordings.exotel.com stops returning "Invalid IP".
app.get("/my-ip", async (req, res) => {
  try {
    const response = await fetch("https://api.ipify.org");
    const ip = await response.text();
    res.json({ outboundIP: ip });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use("/api/auth", authRouter);
app.use("/api/resort-leads", requireAuth, resortLeadsRouter);
app.use("/api/calls", requireAuth, callsRouter);
app.use("/api/assistant", requireAuth, assistantRouter);
app.use("/api/meta-leads", requireAuth, metaLeadsRouter);
app.use("/api/meta-ads", requireAuth, metaAdsRouter);
app.use("/api/users", requireAuth, usersRouter);
app.use("/api/tasks", requireAuth, tasksRouter);
app.use("/api/emails", requireAuth, emailsRouter);
// Meta calls the webhook without a login, so it is mounted before the auth'd router.
app.use("/api/whatsapp/webhook", whatsappWebhook);
app.use("/api/whatsapp", requireAuth, whatsappRouter);

async function start() {
  try {
    await connectDB();
    await migrateAdmin();

    // Sheet → App mirror: sync once on boot, then on an interval.
    startAutoSync();
    startMetaAutoSync();
    // Company Gmail mailboxes: full-history import + new mail every ~90s.
    require("./src/services/gmailService").startEmailSync();

    // Warm the Exotel call cache so the Calls tab opens instantly.
    require("./src/services/exotelService").prewarm();

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
