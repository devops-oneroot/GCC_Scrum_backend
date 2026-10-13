const dns = require("dns");
const mongoose = require("mongoose");

// Windows' Internet Connection Sharing (the Hyper-V "Default Switch") points
// Node's c-ares resolver at 127.0.0.1, where its DNS proxy answers on UDP only.
// mongodb+srv:// needs an SRV lookup, which falls back to TCP and gets
// ECONNREFUSED. Ordinary A lookups go through the OS resolver and are fine, so
// only override when we see that specific broken setup.
function ensureResolvableDns() {
  const servers = dns.getServers();
  if (servers.every((s) => s === "127.0.0.1" || s === "::1")) {
    dns.setServers(["8.8.8.8", "1.1.1.1"]);
  }
}

function resolveMongoUri() {
  const raw = (process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/sales-crm").trim();
  const dbName = process.env.MONGODB_DB_NAME?.trim();
  if (!dbName) return raw;

  const [base, query = ""] = raw.split("?");
  const withoutTrailingSlash = base.replace(/\/+$/, "");
  const hasDbPath = /\/[^/]+$/.test(withoutTrailingSlash.replace(/^mongodb(\+srv)?:\/\/[^/]+/, ""));

  if (hasDbPath) return raw;

  const uri = `${withoutTrailingSlash}/${dbName}`;
  return query ? `${uri}?${query}` : uri;
}

async function connectDB() {
  ensureResolvableDns();
  const uri = resolveMongoUri();
  await mongoose.connect(uri);
  console.log(`MongoDB connected (database: ${mongoose.connection.db.databaseName})`);
}

module.exports = connectDB;
