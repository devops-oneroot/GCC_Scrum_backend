const ResortLead = require("../models/ResortLead");
const ResortActivity = require("../models/ResortActivity");
const { parseCsv } = require("../lib/csv");
const {
  clean,
  parseINR,
  parsePax,
  parseSheetDate,
  normStatus,
  normQuery,
  normSource,
  parsePriority,
  normLastInteraction,
  normExec,
  parseFollowUps,
  hashObject,
  STATUS_META,
} = require("../lib/resortNormalize");

const DEFAULT_SHEET_ID = "1lSSgLKZsQ8VXnRFLK7u9lN_eSFUzz5cuRG9UOw0xefA";
const DEFAULT_GID = "84625495";

function getCsvUrl() {
  return (
    (process.env.RESORT_SHEET_CSV_URL || "").trim() ||
    `https://docs.google.com/spreadsheets/d/${getSheetId()}/export?format=csv&gid=${DEFAULT_GID}`
  );
}

/** Spreadsheet id — from env, else parsed from the CSV url, else the default. */
function getSheetId() {
  const explicit = (process.env.RESORT_SHEET_ID || "").trim();
  if (explicit) return explicit;
  const url = (process.env.RESORT_SHEET_CSV_URL || "").trim();
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : DEFAULT_SHEET_ID;
}

function tabCsvUrl(gid) {
  return `https://docs.google.com/spreadsheets/d/${getSheetId()}/export?format=csv&gid=${gid}`;
}

/**
 * Discover every tab (worksheet) in the spreadsheet as { gid, name }, by
 * scraping the edit page's bootstrap. No Google credentials needed (the sheet
 * is link-viewable). Falls back to the single configured tab on any failure.
 */
async function discoverTabs() {
  try {
    const res = await fetch(
      `https://docs.google.com/spreadsheets/d/${getSheetId()}/edit`,
      { redirect: "follow" }
    );
    if (!res.ok) throw new Error(`edit page HTTP ${res.status}`);
    const html = await res.text();
    const re = /\[\d+,0,\\"(\d+)\\",\[\{\\"1\\":\[\[0,0,\\"([^\\"]+)\\"\]/g;
    const tabs = [];
    const seen = new Set();
    let m;
    while ((m = re.exec(html))) {
      const gid = m[1];
      const name = m[2];
      if (seen.has(gid)) continue;
      seen.add(gid);
      // skip the default non-data tabs
      if (/^sheet\d+$/i.test(name.trim())) continue;
      tabs.push({ gid, name });
    }
    if (!tabs.length) throw new Error("no tabs parsed");
    return tabs;
  } catch (err) {
    console.warn("Tab discovery failed, using single tab:", err.message);
    return [{ gid: DEFAULT_GID, name: "Sheet" }];
  }
}

/** last sync summary, exposed via GET /api/resort-leads/sync/status */
let lastSync = {
  at: null,
  ok: null,
  total: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  error: null,
  durationMs: 0,
};

function getLastSync() {
  return lastSync;
}

/** Map fuzzy header names -> our canonical keys. */
function buildHeaderIndex(headerRow) {
  const norm = (h) => clean(h).toLowerCase().replace(/[^a-z0-9]/g, "");
  const keys = headerRow.map(norm);

  // In this workbook the Lead ID is ALWAYS column 0 — but a few month tabs have
  // a garbage value in that header cell (" ", a stray phone number, "sales exe",
  // "F"). If we can't find a real "Lead ID" header, treat column 0 as Lead ID
  // and exclude it from all other matches (so e.g. May's "sales exe" in col 0
  // doesn't hijack the real Sales Exe. column).
  let leadIdIdx = keys.indexOf("leadid");
  const col0IsLeadId = leadIdIdx < 0;
  if (col0IsLeadId) leadIdIdx = 0;

  const idx = {};
  keys.forEach((key, i) => {
    if (col0IsLeadId && i === 0) return; // reserve col 0 for Lead ID
    if (!(key in idx)) idx[key] = i;
  });
  const find = (...cands) => {
    for (const c of cands) {
      const key = c.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (key in idx) return idx[key];
    }
    return -1;
  };
  return {
    leadId: leadIdIdx,
    date: find("date"),
    clientName: find("clientname", "client"),
    companyName: find("companyname", "company"),
    contactNo: find("contactno", "contact", "contactnumber", "phone"),
    query: find("query", "enquiry", "enquirytype"),
    source: find("leadsource", "source"),
    bookingDate: find("bookingdate", "booking"),
    priority: find("priority"),
    pax: find("noofpeople", "nofpeople", "people", "pax"),
    lastInteraction: find("lastinteraction", "interaction"),
    approxRev: find("approxrev", "approxrevenue", "revenue"),
    quote: find("quoteinr", "quote"),
    salesExec: find("salesexe", "salesexec", "salesexecutive", "executive"),
    comment: find("commentoverallupdate", "comment", "overallupdate"),
    status: find("status"),
    reason: find("reason"),
    followUps: find("totalnumberoffollowups", "followups", "totalfollowups"),
  };
}

function cell(row, i) {
  return i >= 0 && i < row.length ? row[i] : "";
}

/** Turn one CSV row into the sheet-derived fields, or null when unusable. */
function rowToFields(row, H, rowNumber, sheetMonth) {
  const leadId = clean(cell(row, H.leadId));
  if (!leadId) return null;

  // rows can be pre-seeded with just a Lead ID and nothing else — skip those
  const hasData = [
    H.clientName,
    H.contactNo,
    H.query,
    H.status,
    H.bookingDate,
    H.date,
  ].some((i) => clean(cell(row, i)));
  if (!hasData) return { leadId, empty: true };

  const priority = parsePriority(cell(row, H.priority));
  const status = normStatus(cell(row, H.status));

  return {
    leadId,
    rowNumber,
    sheetMonth: sheetMonth || "",
    enquiryDate: parseSheetDate(cell(row, H.date)),
    enquiryDateRaw: clean(cell(row, H.date)),
    clientName: clean(cell(row, H.clientName)),
    companyName: clean(cell(row, H.companyName)),
    contactNo: clean(cell(row, H.contactNo)),
    query: normQuery(cell(row, H.query)),
    leadSource: normSource(cell(row, H.source)),
    bookingDate: parseSheetDate(cell(row, H.bookingDate)),
    bookingDateRaw: clean(cell(row, H.bookingDate)),
    priorityCode: priority.code,
    priorityLabel: priority.label,
    priorityRank: priority.rank,
    pax: parsePax(cell(row, H.pax)),
    paxRaw: clean(cell(row, H.pax)),
    lastInteraction: normLastInteraction(cell(row, H.lastInteraction)),
    approxRevenue: parseINR(cell(row, H.approxRev)),
    quote: parseINR(cell(row, H.quote)),
    salesExec: normExec(cell(row, H.salesExec)),
    comment: clean(cell(row, H.comment)),
    status,
    statusRaw: clean(cell(row, H.status)),
    reason: clean(cell(row, H.reason)),
    followUpCount: parseFollowUps(cell(row, H.followUps)),
  };
}

/**
 * Pull the sheet and upsert every enquiry. Sheet fields overwrite the DB;
 * app-only fields are left untouched. Uses bulkWrite so a full sync of ~600
 * rows is a handful of round-trips instead of one per row. Returns a summary.
 */
async function syncFromSheet({ silent = false } = {}) {
  const startedAt = Date.now();
  const summary = {
    at: new Date(),
    ok: false,
    total: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    tabs: [],
    error: null,
    durationMs: 0,
  };

  try {
    // Every monthly tab in the workbook.
    const tabs = await discoverTabs();

    // Fetch all tabs in parallel (one retry each — Google can be flaky).
    const fetchTab = async (tab, attempt = 0) => {
      try {
        const res = await fetch(tabCsvUrl(tab.gid), { redirect: "follow" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { tab, rows: parseCsv(await res.text()) };
      } catch (err) {
        if (attempt < 1) return fetchTab(tab, attempt + 1);
        console.warn(`Tab "${tab.name}" fetch failed:`, err.message);
        return { tab, rows: null };
      }
    };
    const fetched = await Promise.all(tabs.map((tab) => fetchTab(tab)));

    // Dedupe by leadId across ALL tabs — last occurrence wins.
    // Since Lead IDs encode the month (GCC26-07-###), tabs don't collide.
    const desired = new Map();
    for (const { tab, rows } of fetched) {
      if (!rows || rows.length < 2) continue;
      const H = buildHeaderIndex(rows[0]);
      if (H.leadId < 0) continue; // not an enquiry tab — skip silently
      let rowsInTab = 0;
      for (let r = 1; r < rows.length; r += 1) {
        const fields = rowToFields(rows[r], H, r + 1, tab.name);
        if (!fields || fields.empty) {
          summary.skipped += 1;
          continue;
        }
        desired.set(fields.leadId, fields);
        rowsInTab += 1;
      }
      summary.tabs.push({ name: tab.name, gid: tab.gid, rows: rowsInTab });
    }
    if (!desired.size) throw new Error("No enquiry rows found in any tab");
    summary.total = desired.size;

    // Load existing docs once.
    const existingArr = await ResortLead.find(
      { leadId: { $in: [...desired.keys()] } },
      { leadId: 1, sourceHash: 1, status: 1 }
    ).lean();
    const existing = new Map(existingArr.map((d) => [d.leadId, d]));

    const ops = [];
    const activities = [];

    for (const [leadId, fields] of desired) {
      const sheetHash = hashObject(fields);
      const prev = existing.get(leadId);

      if (!prev) {
        summary.created += 1;
        ops.push({
          insertOne: {
            document: { ...fields, sourceHash: sheetHash, lastSyncedAt: summary.at },
          },
        });
        activities.push({
          source: "sync",
          type: "enquiry_created",
          leadId,
          clientName: fields.clientName,
          salesExec: fields.salesExec,
          query: fields.query,
          toStatus: fields.status,
          detail: `New enquiry ${leadId} — ${fields.query}`,
        });
        continue;
      }

      if (prev.sourceHash === sheetHash) {
        summary.unchanged += 1;
        continue; // nothing changed — don't even stamp, saves a write
      }

      summary.updated += 1;
      ops.push({
        updateOne: {
          filter: { leadId },
          // only sheet fields — app-only fields (notes, reminders) untouched
          update: { $set: { ...fields, sourceHash: sheetHash, lastSyncedAt: summary.at } },
        },
      });

      if (prev.status !== fields.status) {
        activities.push({
          source: "sync",
          type: "status_changed",
          leadId,
          clientName: fields.clientName,
          salesExec: fields.salesExec,
          query: fields.query,
          fromStatus: prev.status,
          toStatus: fields.status,
          detail: `${leadId} moved ${STATUS_META[prev.status]?.label || prev.status} → ${STATUS_META[fields.status]?.label || fields.status}`,
        });
      } else {
        activities.push({
          source: "sync",
          type: "enquiry_updated",
          leadId,
          clientName: fields.clientName,
          salesExec: fields.salesExec,
          query: fields.query,
          detail: `${leadId} updated`,
        });
      }
    }

    if (ops.length) await ResortLead.bulkWrite(ops, { ordered: false });
    if (activities.length) {
      try {
        await ResortActivity.insertMany(activities, { ordered: false });
      } catch (err) {
        console.warn("Resort activity log failed:", err.message);
      }
    }

    summary.ok = true;
  } catch (err) {
    summary.error = err.message;
    if (!silent) console.error("❌ Resort sheet sync failed:", err.message);
  }

  summary.durationMs = Date.now() - startedAt;
  lastSync = summary;
  if (!silent && summary.ok) {
    console.log(
      `✅ Resort sync: ${summary.total} enquiries from ${summary.tabs.length} tab(s) ` +
        `(created ${summary.created}, updated ${summary.updated}, unchanged ${summary.unchanged}) in ${summary.durationMs}ms`
    );
  }
  return summary;
}

let intervalHandle = null;

/** Sync once on boot, then on an interval (default 10 min). */
function startAutoSync() {
  const minutes = Number(process.env.RESORT_SYNC_INTERVAL_MIN || 10);
  syncFromSheet().catch(() => {});
  if (intervalHandle) clearInterval(intervalHandle);
  if (minutes > 0) {
    intervalHandle = setInterval(
      () => syncFromSheet({ silent: false }).catch(() => {}),
      minutes * 60 * 1000
    );
    console.log(`⏱️  Resort auto-sync every ${minutes} min`);
  }
}

module.exports = { syncFromSheet, startAutoSync, getLastSync, getCsvUrl };
