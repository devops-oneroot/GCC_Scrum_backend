const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), override: true });

const connectDB = require("../src/config/db");
const { syncFromSheet } = require("../src/services/resortSyncService");
const ResortLead = require("../src/models/ResortLead");
const mongoose = require("mongoose");

(async () => {
  await connectDB();
  const t = Date.now();
  const res = await syncFromSheet();
  console.log("SUMMARY:", JSON.stringify(res, null, 2));
  console.log("Elapsed:", Date.now() - t, "ms");
  const total = await ResortLead.countDocuments();
  const byStatus = await ResortLead.aggregate([
    { $group: { _id: "$status", n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  console.log("DB total:", total, "byStatus:", byStatus);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
