const MetaLead = require("../models/MetaLead");
const { parseCsv } = require("../lib/csv");
const {
  clean,
  parseINR,
  parseSheetDate,
  normQuery,
  normExec,
  hashObject,
} = require("../lib/resortNormalize");

const DEFAULT_SHEET_ID = "14e44atgJYVKmC3nnTnSpRLTqt7gOIcY7kL-rmkJpb7Y";
const DEFAULT_GID = "500636204"; // "Meta-Report" tab

function csvUrl() {
  const explicit = (process.env.META_SHEET_CSV_URL || "").trim();
  if (explicit) return explicit;
  const id = (process.env.META_SHEET_ID || "").trim() || DEFAULT_SHEET_ID;
  const gid = (process.env.META_SHEET_GID || "").trim() || DEFAULT_GID;
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

let lastSync = {
  at: null, ok: null, total: 0, created: 0, updated: 0,
  unchanged: 0, skipped: 0, error: null, durationMs: 0,
};
function getLastSync() {
  return lastSync;
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const last10 = (v) => String(v || "").replace(/\D/g, "").slice(-10);

/** Meta sheet dates are DD-MM-YYYY (hyphen). Also tolerate slashes & YYYY-MM-DD. */
function parseMetaDate(raw) {
  const s = clean(raw);
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    const dt = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1])));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  return parseSheetDate(s); // fallback: YYYY-MM-DD
}

/** header name -> column index (trimmed, case-insensitive) */
function headerIndex(headerRow) {
  const H = {};
  headerRow.forEach((h, i) => {
    const key = clean(h).toLowerCase();
    if (key && !(key in H)) H[key] = i;
  });
  const pick = (...names) => {
    for (const n of names) {
      const i = H[n.toLowerCase()];
      if (i !== undefined) return i;
    }
    return -1;
  };
  return {
    date: pick("date"),
    client: pick("client name"),
    company: pick("company name"),
    contact: pick("contact no.", "contact no", "contact number"),
    email: pick("email-id", "email id", "email"),
    query: pick("query"),
    source: pick("lead source"),
    exec: pick("sales executive", "sales exe.", "sales exe"),
    pax: pick("no of pax", "no. of people", "no of people"),
    worthText: pick("lead worth"), // first "lead Worth" (text/range/status)
    worthNum: -1, // resolved below (the SECOND "Lead Worth" column)
    remarks: pick("remarks"),
  };
}

/** There are two "lead worth" columns; the numeric one is the 2nd occurrence. */
function resolveWorthColumns(headerRow) {
  const idxs = [];
  headerRow.forEach((h, i) => {
    if (clean(h).toLowerCase() === "lead worth" || clean(h).toLowerCase() === "leads worth")
      idxs.push(i);
  });
  return { textCol: idxs[0] ?? -1, numCol: idxs[1] ?? idxs[0] ?? -1 };
}

/**
 * Parse a "Lead Worth" cell into ₹, handling the sheet's shorthand:
 *   "8,00,000" -> 800000   "37500" -> 37500
 *   "10 L" / "8L" / "10 Lakhs" -> ×1,00,000
 *   "₹5–15 Lakhs" (range) -> average, then ×1,00,000   "₹60Lakhs +" -> 60L
 *   "1 Cr" -> ×1,00,00,000     "cancelled" / "no response" -> 0
 */
function parseWorth(raw) {
  const s = clean(raw);
  if (!s) return 0;
  const low = s.toLowerCase();
  if (!/\d/.test(low)) return 0; // pure status/text
  const isCr = /\bcr\b|crore/.test(low);
  const isLakh =
    /lakh|lac/.test(low) || /\d\s*l\b/.test(low) || /\dl\b/.test(low);
  // "39,8L" uses a comma as the decimal point; "8,00,000" uses commas as grouping.
  const work =
    (isLakh || isCr) && /\d,\d{1,2}\s*(l\b|lakh|lac|cr\b|crore)/.test(low)
      ? low.replace(",", ".")
      : low.replace(/,/g, "");
  const nums = (work.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return 0;
  const isRange = /[-–—]|\bto\b/.test(low) && nums.length >= 2;
  let v = isRange ? (nums[0] + nums[1]) / 2 : nums[0];
  if (isCr) v *= 1e7;
  else if (isLakh) v *= 1e5;
  return Math.round(v);
}

const LOST_RE = /cancel|lost|no response|not interested|closed lost|dead|junk/i;
const WON_RE = /closed|confirm|onboard|booked|won|done/i;

function deriveStatus(worthText) {
  const t = clean(worthText).toLowerCase();
  if (!t) return "open";
  if (LOST_RE.test(t)) return "lost";
  if (WON_RE.test(t)) return "won";
  return "open";
}

function rowToLead(row, H, worthCols) {
  const cell = (i) => (i >= 0 && i < row.length ? clean(row[i]) : "");
  const rawDate = cell(H.date);
  const rawQuery = cell(H.query);
  const date = parseMetaDate(rawDate);
  const client = cell(H.client);
  const contact = cell(H.contact);
  if (!client && !contact) return null; // empty row

  const worthText = cell(worthCols.textCol); // col K: ranges / status
  const worthRaw = cell(worthCols.numCol); // col L: numeric / shorthand
  // Parse ₹ from the numeric column (handles "10 L", "₹5–15 Lakhs"); fall back to col K.
  const leadWorth = parseWorth(worthRaw) || parseWorth(worthText) || 0;
  const month = date
    ? `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
    : "";

  const fields = {
    date,
    month,
    clientName: client,
    company: cell(H.company),
    contactNo: contact,
    email: cell(H.email),
    query: cell(H.query) ? normQuery(cell(H.query)) : "Not specified",
    leadSource: cell(H.source) || "Meta",
    salesExec: normExec(cell(H.exec)),
    pax: cell(H.pax),
    leadWorth: leadWorth || 0,
    worthText,
    worthRaw,
    status: deriveStatus(worthText || worthRaw),
    remarks: cell(H.remarks),
  };

  // Key on RAW sheet cells so re-normalization never orphans/duplicates rows.
  const rowKey = hashObject({
    d: rawDate,
    c: last10(contact),
    n: client.toLowerCase(),
    q: rawQuery.toLowerCase(),
  });
  const hash = hashObject(fields);
  return { rowKey, hash, fields };
}

async function syncMeta({ silent = false } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(csvUrl(), { redirect: "follow" });
    if (!res.ok) throw new Error(`Sheet HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseCsv(text);
    if (!rows.length) throw new Error("Empty sheet");

    const header = rows[0];
    const H = headerIndex(header);
    const worthCols = resolveWorthColumns(header);
    if (H.client < 0 && H.contact < 0) {
      throw new Error("Meta sheet missing Client/Contact columns");
    }

    const desired = new Map(); // rowKey -> {hash, fields}
    for (let r = 1; r < rows.length; r += 1) {
      const parsed = rowToLead(rows[r], H, worthCols);
      if (parsed) desired.set(parsed.rowKey, parsed); // last wins on dup key
    }

    const keys = [...desired.keys()];
    const existing = await MetaLead.find(
      { rowKey: { $in: keys } },
      { rowKey: 1, hash: 1 }
    ).lean();
    const existingHash = new Map(existing.map((e) => [e.rowKey, e.hash]));

    const ops = [];
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const [rowKey, { hash, fields }] of desired) {
      const prev = existingHash.get(rowKey);
      if (prev === hash) {
        unchanged += 1;
        continue;
      }
      if (prev === undefined) created += 1;
      else updated += 1;
      ops.push({
        updateOne: {
          filter: { rowKey },
          update: { $set: { ...fields, rowKey, hash } },
          upsert: true,
        },
      });
    }
    if (ops.length) await MetaLead.bulkWrite(ops, { ordered: false });

    lastSync = {
      at: new Date().toISOString(),
      ok: true,
      total: desired.size,
      created,
      updated,
      unchanged,
      skipped: rows.length - 1 - desired.size,
      error: null,
      durationMs: Date.now() - started,
    };
    if (!silent) {
      console.log(
        `✅ Meta sync: ${desired.size} leads (created ${created}, updated ${updated}) in ${lastSync.durationMs}ms`
      );
    }
    return lastSync;
  } catch (err) {
    lastSync = {
      ...lastSync,
      at: new Date().toISOString(),
      ok: false,
      error: err.message,
      durationMs: Date.now() - started,
    };
    if (!silent) console.warn("⚠️  Meta sync failed:", err.message);
    return lastSync;
  }
}

function startAutoSync() {
  syncMeta({ silent: false }).catch(() => {});
  const mins = Number(process.env.META_SYNC_INTERVAL_MIN);
  const interval = Number.isFinite(mins) ? mins : 10;
  if (interval > 0) {
    setInterval(() => syncMeta({ silent: true }).catch(() => {}), interval * 60_000);
    console.log(`⏱️  Meta auto-sync every ${interval} min`);
  }
}

module.exports = { syncMeta, startAutoSync, getLastSync, csvUrl };
