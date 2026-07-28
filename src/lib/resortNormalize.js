/**
 * Normalizers that turn the messy Google-Sheet cells (₹ currency, DD/MM/YYYY
 * dates, "8 Pax ", "P0 (Less than 3 days)", casing variants of Status /
 * Last Interaction) into clean, queryable values for the resort CRM.
 */

const crypto = require("crypto");

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

/** "₹12,000.00" | "  ₹1,06,312.00 " | "₹14990.00" | "" -> Number | null */
function parseINR(v) {
  const raw = clean(v);
  if (!raw) return null;
  const digits = raw.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const n = Number.parseFloat(digits);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** "8 Pax" | "2pax" | "200 pax " -> Number | null */
function parsePax(v) {
  const raw = clean(v);
  if (!raw) return null;
  const m = raw.match(/\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

/** "01/07/2026" (DD/MM/YYYY) -> Date | null. Also tolerates YYYY-MM-DD. */
function parseSheetDate(v) {
  const raw = clean(v);
  if (!raw) return null;

  let m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    let year = Number(y);
    if (year < 100) year += 2000;
    const date = new Date(Date.UTC(year, Number(mo) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

/**
 * Canonical enquiry status.
 * Sheet values: Ongoing | Onboarded | Lost | Other Queries | (blank)
 */
const STATUS_META = {
  new: { label: "New", stage: "open" },
  ongoing: { label: "Ongoing", stage: "open" },
  onboarded: { label: "Onboarded", stage: "won" },
  lost: { label: "Lost", stage: "lost" },
  other: { label: "Other Queries", stage: "other" },
};

function normStatus(v) {
  const raw = clean(v).toLowerCase();
  if (!raw) return "new";
  if (raw.includes("onboard")) return "onboarded";
  if (raw.includes("ongoing")) return "ongoing";
  if (raw.includes("lost")) return "lost";
  if (raw.includes("other")) return "other";
  return "new";
}

/**
 * Enquiry type ("Query" column). Collapses casing / spelling variants.
 * Room Stay | Day Outing | General Inquiry | Birthday | Wedding |
 * Corporate Event | Picnic | Get Together | ...
 */
function normQuery(v) {
  const raw = clean(v);
  if (!raw) return "Not specified";
  const low = raw.toLowerCase();
  if (low === "na" || low === "n/a") return "General Inquiry";
  if (low.includes("room")) return "Room Stay";
  if (low.includes("day out") || low.includes("outing")) return "Day Outing";
  if (low.includes("general") || low.includes("inquiry") || low.includes("enquiry"))
    return "General Inquiry";
  if (low.includes("wedding")) return "Wedding";
  if (low.includes("birthday")) return "Birthday";
  if (low.includes("corporate")) return "Corporate Event";
  if (low.includes("picnic")) return "Picnic";
  if (low.includes("get together") || low.includes("get-together"))
    return "Get Together";
  if (low.includes("naming")) return "Naming Ceremony";
  if (low.includes("event")) return "Events";
  // Title-case fallback
  return raw
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Lead source: IVR | Walk in | Reference | Promotion | Mail | CRM */
function normSource(v) {
  const raw = clean(v);
  if (!raw) return "Not specified";
  const low = raw.toLowerCase();
  if (low === "ivr") return "IVR";
  if (low.includes("walk")) return "Walk-in";
  if (low.includes("refer")) return "Reference";
  if (low.includes("promo")) return "Promotion";
  if (low.includes("mail")) return "Mail";
  if (low === "crm") return "CRM";
  return raw.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Priority tier "P0 (Less than 3 days)" -> { code, label, rank }.
 * rank: lower = more urgent (P0 rank 0 ... P5 rank 5). null when absent.
 */
const PRIORITY_LABELS = {
  P0: "Less than 3 days",
  P1: "3-4 days",
  P2: "4-5 days",
  P3: "5-7 days",
  P4: "7-10 days",
  P5: "More than 10 days",
};

function parsePriority(v) {
  const raw = clean(v);
  if (!raw) return { code: "", label: "", rank: null };
  const m = raw.match(/P\s*([0-5])/i);
  if (!m) return { code: "", label: raw, rank: null };
  const code = `P${m[1]}`;
  const rank = Number(m[1]);
  return { code, label: PRIORITY_LABELS[code] || raw, rank };
}

/** Collapse "details sent" / "Details Sent" / "details  sent" etc. */
function normLastInteraction(v) {
  const raw = clean(v);
  if (!raw) return "";
  const low = raw.toLowerCase();
  if (low.replace(/\s+/g, " ").startsWith("detail")) return "Details Sent";
  return raw.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Sales executive name, trimmed & title-cased. */
function normExec(v) {
  const raw = clean(v);
  if (!raw) return "Unassigned";
  return raw.replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseFollowUps(v) {
  const raw = clean(v);
  if (!raw) return 0;
  const m = raw.match(/\d+/);
  return m ? Number.parseInt(m[0], 10) : 0;
}

/** Stable hash of the sheet-sourced fields, to detect real changes. */
function hashObject(obj) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(obj))
    .digest("hex");
}

module.exports = {
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
  PRIORITY_LABELS,
};
