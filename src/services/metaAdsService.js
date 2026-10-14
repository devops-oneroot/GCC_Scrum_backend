/**
 * Direct Meta Marketing API (Graph API) connection — the "Meta Ads (Live)" tab.
 * Leads/spend come from Meta; "who handles it" + follow-up come from the CRM's own
 * enquiry records, matched by phone (see attachHandling).
 *
 * Env:
 *   META_ADS_ACCESS_TOKEN  System User / long-lived token with ads_read
 *                          (+ leads_retrieval & pages_manage_ads to read lead forms)
 *   META_AD_ACCOUNT_ID     Ad account id, with or without the "act_" prefix
 *   META_GRAPH_VERSION     optional, defaults to v21.0
 */

const ResortLead = require("../models/ResortLead");
const MetaLead = require("../models/MetaLead");
const MetaAdLeadFollowUp = require("../models/MetaAdLeadFollowUp");
const User = require("../models/User");

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { at, data }

// Meta reports leads under different action types depending on the objective.
const LEAD_ACTIONS = [
  "lead",
  "onsite_conversion.lead_grouped",
  "leadgen_grouped",
  "offsite_conversion.fb_pixel_lead",
];

function config() {
  const token = (
    process.env.META_ADS_ACCESS_TOKEN ||
    process.env.META_PAGE_ACCESS_TOKEN ||
    ""
  ).trim();
  let account = (process.env.META_AD_ACCOUNT_ID || "").trim();
  if (account && !account.startsWith("act_")) account = `act_${account}`;
  const version = (process.env.META_GRAPH_VERSION || "").trim() || "v21.0";
  return { token, account, version, configured: Boolean(token && account) };
}

class MetaApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function graph(path, params = {}) {
  const { token, version } = config();
  const url = new URL(
    path.startsWith("http") ? path : `https://graph.facebook.com/${version}/${path}`
  );
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  if (!url.searchParams.has("access_token")) url.searchParams.set("access_token", token);
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const e = body.error || {};
    // 4 / 17 / 32 / 613 are Meta's rate-limit codes
    const limited = [4, 17, 32, 613].includes(e.code);
    throw new MetaApiError(
      limited
        ? "Meta request limit reached — data will load again in a few minutes."
        : e.message || `Meta API ${res.status}`,
      res.status,
      e.code
    );
  }
  return body;
}

/** Follows paging.next until done or `max` rows collected. */
async function graphAll(path, params = {}, max = 500) {
  const out = [];
  let page = await graph(path, { limit: 100, ...params });
  for (;;) {
    out.push(...(page.data || []));
    const next = page.paging && page.paging.next;
    if (!next || out.length >= max) break;
    page = await graph(next);
  }
  return out.slice(0, max);
}

/** Promise.all over `items`, but at most `limit` running at once. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function cached(key, fresh, fn) {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  try {
    const data = await fn();
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (err) {
    // Rate-limited (or Meta hiccup): fall back to the last good copy.
    if (hit) return { ...hit.data, stale: true, staleReason: err.message };
    throw err;
  }
}

/**
 * Resolve a range to IST calendar dates (the ad account's timezone). Unlike
 * Meta's own last_Nd presets, these always run up to *today*, so a lead that
 * arrived this morning shows up. Returns {} for lifetime.
 */
const IST_MS = 330 * 60 * 1000;
function resolveDates({ preset, since, until } = {}) {
  if (since && until) return { since, until };
  const today = new Date(Date.now() + IST_MS); // IST wall clock in UTC fields
  const ymd = (d) => d.toISOString().slice(0, 10);
  const shift = (days) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + days);
    return ymd(d);
  };
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const now = ymd(today);
  const days = { last_7d: 7, last_14d: 14, last_30d: 30, last_90d: 90 }[preset];
  if (days) return { since: shift(1 - days), until: now };
  switch (preset) {
    case "today": return { since: now, until: now };
    case "yesterday": return { since: shift(-1), until: shift(-1) };
    case "this_month": return { since: ymd(new Date(Date.UTC(y, m, 1))), until: now };
    case "last_month":
      return { since: ymd(new Date(Date.UTC(y, m - 1, 1))), until: ymd(new Date(Date.UTC(y, m, 0))) };
    case "this_year": return { since: `${y}-01-01`, until: now };
    case "maximum": return {};
    default: return { since: shift(-29), until: now };
  }
}

/** range → insights time params */
function timeParams(range) {
  const { since, until } = resolveDates(range);
  return since ? { time_range: { since, until } } : { date_preset: "maximum" };
}

/** range → lead-form time_created window (unix seconds) */
function leadWindow(range) {
  const { since, until } = resolveDates(range);
  if (!since) return {};
  const at = (d, end) =>
    Math.floor((Date.parse(`${d}T${end ? "23:59:59" : "00:00:00"}Z`) - IST_MS) / 1000);
  return { from: at(since), to: at(until, true) };
}

const num = (v) => (v === undefined || v === null || v === "" ? 0 : Number(v) || 0);

function pickAction(list) {
  if (!Array.isArray(list)) return 0;
  for (const type of LEAD_ACTIONS) {
    const a = list.find((x) => x.action_type === type);
    if (a) return num(a.value);
  }
  return 0;
}

function shapeInsight(row = {}) {
  const spend = num(row.spend);
  const leads = pickAction(row.actions);
  return {
    spend,
    impressions: num(row.impressions),
    reach: num(row.reach),
    clicks: num(row.clicks),
    ctr: num(row.ctr),
    cpc: num(row.cpc),
    cpm: num(row.cpm),
    leads,
    costPerLead: leads ? spend / leads : 0,
  };
}

const INSIGHT_FIELDS = "spend,impressions,reach,clicks,ctr,cpc,cpm,actions";

async function getOverview(range = {}, fresh = false) {
  const { account } = config();
  const key = `overview:${JSON.stringify(range)}`;
  return cached(key, fresh, async () => {
    const t = timeParams(range);
    // The app is on Meta's development access tier (tiny rate limits), so ask
    // only for what's live plus counts — never page through every ad/campaign.
    const ACTIVE = { effective_status: ["ACTIVE"] };
    const [info, totals, daily, campaignRows, activeCampaigns, activeAds, campaignCount, adCount] =
      await Promise.all([
        graph(account, {
          fields: "name,currency,account_status,amount_spent,timezone_name",
        }),
        graph(`${account}/insights`, { fields: INSIGHT_FIELDS, ...t }),
        graphAll(`${account}/insights`, { fields: "spend,actions", time_increment: 1, ...t }, 400),
        graphAll(`${account}/insights`, {
          level: "campaign",
          fields: `campaign_id,campaign_name,${INSIGHT_FIELDS}`,
          ...t,
        }),
        graphAll(`${account}/campaigns`, {
          fields: "id,name,objective,effective_status,daily_budget,lifetime_budget",
          ...ACTIVE,
        }),
        graphAll(`${account}/ads`, { fields: "campaign_id", ...ACTIVE }, 1000),
        graph(`${account}/campaigns`, { limit: 1, fields: "id", summary: "total_count" }),
        graph(`${account}/ads`, { limit: 1, fields: "id", summary: "total_count" }),
      ]);

    // Paused campaigns that still spent in the range: one batched lookup for their details.
    const known = new Set(activeCampaigns.map((c) => c.id));
    const missing = campaignRows.map((r) => r.campaign_id).filter((id) => !known.has(id));
    const extra = missing.length
      ? await graphAll(`${account}/campaigns`, {
          fields: "id,name,objective,effective_status,daily_budget,lifetime_budget",
          filtering: [{ field: "id", operator: "IN", value: missing.slice(0, 50) }],
        })
      : [];
    const campaigns = [...activeCampaigns, ...extra];

    const insightByCampaign = new Map(campaignRows.map((r) => [r.campaign_id, r]));
    const activeAdsByCampaign = {};
    for (const ad of activeAds) {
      activeAdsByCampaign[ad.campaign_id] = (activeAdsByCampaign[ad.campaign_id] || 0) + 1;
    }

    const campaignList = campaigns
      .map((c) => ({
        id: c.id,
        name: c.name,
        objective: c.objective,
        status: c.effective_status,
        dailyBudget: c.daily_budget ? num(c.daily_budget) / 100 : null,
        lifetimeBudget: c.lifetime_budget ? num(c.lifetime_budget) / 100 : null,
        activeAds: activeAdsByCampaign[c.id] || 0,
        ...shapeInsight(insightByCampaign.get(c.id)),
      }))
      .sort((a, b) => b.spend - a.spend);

    const total = (r) => num(r && r.summary && r.summary.total_count);

    return {
      account: {
        id: account,
        name: info.name,
        currency: info.currency,
        timezone: info.timezone_name,
        status: info.account_status, // 1 = active
        lifetimeSpent: num(info.amount_spent) / 100,
      },
      totals: shapeInsight((totals.data || [])[0]),
      ads: {
        total: total(adCount),
        active: activeAds.length,
      },
      campaigns: {
        total: total(campaignCount),
        active: activeCampaigns.length,
        list: campaignList,
      },
      daily: daily.map((d) => ({
        date: d.date_start,
        spend: num(d.spend),
        leads: pickAction(d.actions),
      })),
      fetchedAt: new Date().toISOString(),
    };
  });
}

function fieldValue(fields, ...names) {
  for (const n of names) {
    const f = fields.find((x) => x.name === n);
    if (f && f.values && f.values.length) return f.values.join(", ");
  }
  return "";
}

/**
 * Lead-form submissions, read per ad (needs leads_retrieval on the token and
 * the token's user/system-user having access to the Page that owns the forms).
 */
async function fetchMetaLeads(range = {}, fresh = false) {
  const { account } = config();
  const key = `leads:${JSON.stringify(range)}`;
  return cached(key, fresh, async () => {
    const t = timeParams(range);
    // only query ads that actually produced leads in the range
    const adRows = await graphAll(`${account}/insights`, {
      level: "ad",
      fields: "ad_id,ad_name,campaign_name,actions",
      ...t,
    }, 1000);
    const leadAds = adRows.filter((r) => pickAction(r.actions) > 0).slice(0, 60);

    // Leads endpoint ignores date_preset; it filters on time_created (unix seconds)
    const win = leadWindow(range);
    const filtering = [];
    if (win.from) filtering.push({ field: "time_created", operator: "GREATER_THAN", value: win.from });
    if (win.to) filtering.push({ field: "time_created", operator: "LESS_THAN", value: win.to });

    const errors = [];
    // a few ads at a time, so one page load doesn't burst into Meta's rate limit
    const perAd = await mapLimit(leadAds, 4, async (ad) => {
        try {
          const rows = await graphAll(`${ad.ad_id}/leads`, {
            fields: "id,created_time,field_data,form_id,platform",
            filtering: filtering.length ? filtering : undefined,
          }, 500);
          return rows.map((l) => ({ ...l, adName: ad.ad_name, campaignName: ad.campaign_name }));
        } catch (err) {
          errors.push(err.message);
          return [];
        }
      });

    const leads = perAd.flat().map((l) => {
      const f = l.field_data || [];
      const known = new Set(["full_name", "first_name", "last_name", "phone_number", "email"]);
      return {
        id: l.id,
        createdAt: l.created_time,
        name:
          fieldValue(f, "full_name") ||
          [fieldValue(f, "first_name"), fieldValue(f, "last_name")].filter(Boolean).join(" "),
        phone: fieldValue(f, "phone_number"),
        email: fieldValue(f, "email"),
        answers: f
          .filter((x) => !known.has(x.name))
          .map((x) => ({ question: x.name.replace(/_/g, " "), answer: (x.values || []).join(", ") })),
        adName: l.adName,
        campaignName: l.campaignName,
        platform: l.platform || "",
      };
    });
    leads.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    const byCampaign = {};
    for (const l of leads) byCampaign[l.campaignName] = (byCampaign[l.campaignName] || 0) + 1;
    return {
      leads,
      summary: { total: leads.length, byCampaign },
      warnings: [...new Set(errors)].slice(0, 3),
      fetchedAt: new Date().toISOString(),
    };
  });
}

const last10 = (v) => String(v || "").replace(/\D/g, "").slice(-10);

/**
 * Who is handling each Meta lead and where the follow-up stands, from the CRM
 * enquiries (exec, status, next follow-up, count, last interaction) with the
 * Meta leads register as a fallback for the exec/remarks. Read on every request
 * (not cached with the Meta data) so updates by the team show immediately.
 */
async function attachHandling(data) {
  const phones = new Set(data.leads.map((l) => last10(l.phone)).filter((p) => p.length === 10));
  const byPhone = new Map();
  if (phones.size) {
    const [enquiries, registers] = await Promise.all([
      ResortLead.find({ contactNo: { $ne: "" } })
        .select("leadId contactNo salesExec status statusRaw nextFollowUpAt followUpCount lastInteraction comment internalNote")
        .sort({ enquiryDate: 1 })
        .lean(),
      MetaLead.find({ contactNo: { $ne: "" } })
        .select("contactNo salesExec status remarks")
        .lean(),
    ]);
    // registers first, enquiries override (they carry the follow-up details);
    // later enquiries win, so a repeat enquiry shows the latest owner
    for (const r of registers) {
      const p = last10(r.contactNo);
      if (!phones.has(p)) continue;
      byPhone.set(p, {
        salesExec: r.salesExec,
        status: r.status,
        nextFollowUpAt: null,
        followUpCount: 0,
        lastNote: r.remarks || "",
      });
    }
    for (const r of enquiries) {
      const p = last10(r.contactNo);
      if (!phones.has(p)) continue;
      byPhone.set(p, {
        enquiryId: r.leadId,
        salesExec: r.salesExec,
        status: r.statusRaw || r.status,
        nextFollowUpAt: r.nextFollowUpAt,
        followUpCount: r.followUpCount || 0,
        lastNote: r.internalNote || r.lastInteraction || r.comment || "",
      });
    }
  }
  const isAssigned = (h) => h && h.salesExec && !/^unassigned$/i.test(h.salesExec);

  // Follow-ups recorded in this tab — these are the source of truth when present.
  const own = await MetaAdLeadFollowUp.find({ metaLeadId: { $in: data.leads.map((l) => l.id) } })
    .select("-history")
    .lean();
  const ownById = new Map(own.map((f) => [f.metaLeadId, f]));

  const leads = data.leads.map((l) => {
    const h = byPhone.get(last10(l.phone)) || null;
    const f = ownById.get(l.id);
    return {
      ...l,
      handling: isAssigned(h) ? h : h ? { ...h, salesExec: "" } : null,
      followUp: f
        ? {
            stage: f.stage,
            assignedTo: f.assignedTo,
            nextFollowUpAt: f.nextFollowUpAt,
            lastNote: f.lastNote,
            updatedBy: f.updatedBy,
            updatedAt: f.updatedAt,
          }
        : null,
    };
  });
  return { ...data, leads };
}

async function getLeads(range = {}, fresh = false) {
  return attachHandling(await fetchMetaLeads(range, fresh));
}

/** Every campaign's id/name/status for the filter — names rarely change, so cache 30 min. */
async function getAllCampaigns(fresh = false) {
  const { account } = config();
  const hit = cache.get("campaign-names");
  if (!fresh && hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  try {
    const rows = await graphAll(`${account}/campaigns`, { fields: "id,name,effective_status" }, 2000);
    const data = rows.map((c) => ({ id: c.id, name: c.name, status: c.effective_status }));
    cache.set("campaign-names", { at: Date.now(), data });
    return data;
  } catch (err) {
    if (hit) return hit.data;
    throw err;
  }
}

/** Save a follow-up update for one Meta lead and append it to the history. */
async function saveFollowUp(metaLeadId, input, byName) {
  const STAGES = MetaAdLeadFollowUp.STAGES;
  const set = { updatedBy: byName || "" };
  const entry = { at: new Date(), by: byName || "" };
  if (input.stage !== undefined) {
    if (!STAGES.includes(input.stage)) throw new Error(`Unknown stage "${input.stage}"`);
    set.stage = entry.stage = input.stage;
  }
  if (input.assignedTo !== undefined) set.assignedTo = entry.assignedTo = String(input.assignedTo).trim();
  if (input.nextFollowUpAt !== undefined) {
    const d = input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null;
    if (d && Number.isNaN(d.getTime())) throw new Error("Invalid follow-up date");
    set.nextFollowUpAt = entry.nextFollowUpAt = d;
  }
  if (input.note) set.lastNote = entry.note = String(input.note).trim();
  // closed leads need no further follow-up
  if (set.stage === "won" || set.stage === "lost") set.nextFollowUpAt = entry.nextFollowUpAt = null;

  for (const k of ["name", "phone", "campaignName"]) {
    if (input[k]) set[k] = String(input[k]).trim();
  }
  return MetaAdLeadFollowUp.findOneAndUpdate(
    { metaLeadId },
    { $set: set, $push: { history: { $each: [entry], $position: 0 } } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();
}

async function getFollowUp(metaLeadId) {
  return MetaAdLeadFollowUp.findOne({ metaLeadId }).lean();
}

/** Names to offer in the "Handled by" picker: CRM logins + execs already used on leads. */
async function getHandlers() {
  const [users, a, b, c] = await Promise.all([
    User.find().select("name").lean(),
    MetaLead.distinct("salesExec"),
    ResortLead.distinct("salesExec"),
    MetaAdLeadFollowUp.distinct("assignedTo"),
  ]);
  const names = [...users.map((u) => u.name), ...a, ...b, ...c]
    .map((n) => String(n || "").trim())
    .filter((n) => n && !n.includes(",") && !/^(unassigned|na|n\/a|-)$/i.test(n));
  // one entry per person regardless of case ("kiran" / "Kiran"), preferring a capitalised spelling
  const byKey = new Map();
  for (const n of names) {
    const k = n.toLowerCase();
    const cur = byKey.get(k);
    if (!cur || (cur[0] !== cur[0].toUpperCase() && n[0] === n[0].toUpperCase())) byKey.set(k, n);
  }
  return [...byKey.values()].sort((x, y) => x.localeCompare(y));
}

async function getStatus() {
  const c = config();
  if (!c.configured) {
    return {
      configured: false,
      missing: [
        !c.token && "META_ADS_ACCESS_TOKEN",
        !c.account && "META_AD_ACCOUNT_ID",
      ].filter(Boolean),
    };
  }
  try {
    const me = await graph("me", { fields: "id,name" });
    const acc = await graph(c.account, { fields: "name,currency,account_status" });
    return { configured: true, ok: true, user: me.name, account: { id: c.account, ...acc } };
  } catch (err) {
    return { configured: true, ok: false, error: err.message };
  }
}

module.exports = {
  config,
  getOverview,
  getLeads,
  getAllCampaigns,
  getStatus,
  saveFollowUp,
  getFollowUp,
  getHandlers,
  MetaApiError,
};
