const ResortLead = require("../models/ResortLead");
const { fetchStats } = require("./exotelService");
const { STATUS_META } = require("../lib/resortNormalize");
const { todayBusinessDate } = require("../lib/businessDate");

/*
 * Provider-agnostic AI assistant using an OpenAI-compatible Chat Completions API.
 * Works with Groq (free), OpenRouter, a local Ollama, etc. — just change the URL.
 *   AI_BASE_URL  e.g. https://api.groq.com/openai/v1
 *   AI_API_KEY   the provider key
 *   AI_MODEL     e.g. llama-3.3-70b-versatile
 */
const BASE_URL = (process.env.AI_BASE_URL || "https://api.groq.com/openai/v1")
  .trim()
  .replace(/\/+$/, "");
const API_KEY = (process.env.AI_API_KEY || "").trim();
const MODEL = (process.env.AI_MODEL || "").trim() || "llama-3.3-70b-versatile";

function isConfigured() {
  return Boolean(API_KEY);
}

/* --------------------------- data tools --------------------------- */

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildFilter(a = {}) {
  const f = {};
  if (a.month) f.sheetMonth = { $in: String(a.month).split(",") };
  if (a.status) f.status = String(a.status);
  if (a.salesExec) f.salesExec = new RegExp(`^${escapeRe(a.salesExec)}$`, "i");
  if (a.query) f.query = new RegExp(escapeRe(a.query), "i");
  if (a.priorityCode) f.priorityCode = String(a.priorityCode).toUpperCase();
  if (a.search) {
    const rx = new RegExp(escapeRe(a.search), "i");
    f.$or = [{ clientName: rx }, { contactNo: rx }, { leadId: rx }, { comment: rx }];
  }
  return f;
}

async function enquiryStats(args = {}) {
  const filter = buildFilter(args);
  const rows = await ResortLead.find(filter, {
    status: 1, salesExec: 1, query: 1, leadSource: 1, quote: 1,
    approxRevenue: 1, priorityCode: 1,
  }).lean();

  const stats = {
    matched: rows.length,
    byStatus: {}, byQuery: {}, bySource: {}, byPriority: {}, byExec: {},
    onboarded: 0, lost: 0, ongoing: 0, new: 0, other: 0,
    wonQuoteValueINR: 0, totalApproxRevenueINR: 0,
  };
  for (const r of rows) {
    const s = r.status || "unknown";
    stats.byStatus[s] = (stats.byStatus[s] || 0) + 1;
    if (stats[s] !== undefined) stats[s] += 1;
    if (r.query) stats.byQuery[r.query] = (stats.byQuery[r.query] || 0) + 1;
    if (r.leadSource) stats.bySource[r.leadSource] = (stats.bySource[r.leadSource] || 0) + 1;
    if (r.priorityCode) stats.byPriority[r.priorityCode] = (stats.byPriority[r.priorityCode] || 0) + 1;
    const ex = r.salesExec || "Unassigned";
    const e = (stats.byExec[ex] = stats.byExec[ex] || { total: 0, won: 0, lost: 0 });
    e.total += 1;
    if (s === "onboarded") { e.won += 1; stats.wonQuoteValueINR += r.quote || 0; }
    if (s === "lost") e.lost += 1;
    stats.totalApproxRevenueINR += r.approxRevenue || 0;
  }
  stats.conversionPct = stats.matched
    ? Math.round((stats.onboarded / stats.matched) * 100)
    : 0;
  for (const ex of Object.keys(stats.byExec)) {
    const e = stats.byExec[ex];
    e.conversionPct = e.total ? Math.round((e.won / e.total) * 100) : 0;
  }
  return stats;
}

async function findEnquiries(args = {}) {
  const filter = buildFilter(args);
  const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
  const rows = await ResortLead.find(filter, {
    leadId: 1, clientName: 1, contactNo: 1, query: 1, status: 1,
    salesExec: 1, pax: 1, quote: 1, bookingDate: 1, sheetMonth: 1,
    comment: 1, reason: 1,
  })
    .sort({ enquiryDate: -1 })
    .limit(limit)
    .lean();
  return {
    returned: rows.length,
    enquiries: rows.map((r) => ({
      leadId: r.leadId, client: r.clientName, phone: r.contactNo,
      type: r.query, status: r.status, salesExec: r.salesExec, pax: r.pax,
      quoteINR: r.quote, bookingDate: r.bookingDate, month: r.sheetMonth,
      comment: r.comment, reason: r.reason,
    })),
  };
}

async function callStats(args = {}) {
  try {
    return await fetchStats({ from: args.from, to: args.to });
  } catch (err) {
    return { error: err.message };
  }
}

// OpenAI "tools" format: {type:"function", function:{name, description, parameters}}
const FUNCTIONS = [
  {
    name: "enquiry_stats",
    description:
      "Aggregate resort enquiry statistics (counts, conversion, revenue, breakdowns by status/type/source/priority/sales-exec). Use for 'how many', 'which exec', 'conversion', 'revenue', comparisons.",
    parameters: {
      type: "object",
      properties: {
        month: { type: "string", description: 'Sheet month tab e.g. "June 2026". Comma-separate for several.' },
        status: { type: "string", enum: ["new", "ongoing", "onboarded", "lost", "other"], description: "onboarded = won booking." },
        salesExec: { type: "string", description: "Sales exec name e.g. Chetan." },
        query: { type: "string", description: "Enquiry type e.g. Room Stay, Day Outing, Wedding, Birthday." },
        priorityCode: { type: "string", description: "P0..P5." },
        search: { type: "string", description: "Free text over client name, phone, lead id, comment." },
      },
    },
  },
  {
    name: "find_enquiries",
    description:
      "List individual resort enquiries matching filters (max 25). Use when the user wants specific records, phone numbers, or examples.",
    parameters: {
      type: "object",
      properties: {
        month: { type: "string" },
        status: { type: "string", enum: ["new", "ongoing", "onboarded", "lost", "other"] },
        salesExec: { type: "string" },
        query: { type: "string" },
        priorityCode: { type: "string" },
        search: { type: "string" },
        limit: { type: "integer", description: "Max rows 1-25 (default 10)." },
      },
    },
  },
  {
    name: "call_stats",
    description:
      "Exotel IVR call statistics (answered, hung-up, unique callers, with-recording, matched-to-enquiry). Optional from/to dates YYYY-MM-DD.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD." },
        to: { type: "string", description: "End date YYYY-MM-DD." },
      },
    },
  },
];

const TOOLS = FUNCTIONS.map((fn) => ({ type: "function", function: fn }));

async function executeTool(name, input) {
  if (name === "enquiry_stats") return enquiryStats(input);
  if (name === "find_enquiries") return findEnquiries(input);
  if (name === "call_stats") return callStats(input);
  return { error: `Unknown tool ${name}` };
}

/* --------------------------- chat loop --------------------------- */

const STATUS_HINT = Object.entries(STATUS_META)
  .map(([id, m]) => `${id}=${m.label}`)
  .join(", ");

function systemPrompt() {
  return [
    "You are the assistant for Gold Coins and Clubs (GCC) resort's sales CRM.",
    "Answer questions ONLY from the CRM data by calling the provided tools — never invent numbers.",
    "Call a tool whenever a question needs data; you may call several. After you have the data, reply in plain language.",
    "The data is resort enquiries synced from a Google Sheet (monthly tabs, Jan–Jul 2026) plus enquiries added in the CRM, and Exotel IVR call logs.",
    `Status meanings: ${STATUS_HINT}. "onboarded" means a won/confirmed booking.`,
    "Enquiry types (query) include Room Stay, Day Outing, Wedding, Birthday, Corporate Event, Picnic, General Inquiry.",
    "All money is Indian Rupees (₹). Format large numbers readably (e.g. ₹1,20,000).",
    `Today is ${todayBusinessDate()} (Asia/Kolkata).`,
    "Be concise and specific. If a tool returns nothing, say so plainly.",
  ].join(" ");
}

async function callModel(messages) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 1024,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`AI provider HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text);
  return data.choices?.[0]?.message || {};
}

/** messages: [{role:'user'|'assistant', content:string}] */
async function chat(userMessages) {
  if (!isConfigured()) {
    const err = new Error("Assistant not configured");
    err.code = "NOT_CONFIGURED";
    throw err;
  }

  const history = (userMessages || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
    .slice(-12)
    .map((m) => ({ role: m.role, content: String(m.content) }));

  const messages = [{ role: "system", content: systemPrompt() }, ...history];

  let guard = 0;
  while (guard < 6) {
    guard += 1;
    const msg = await callModel(messages);

    const toolCalls = msg.tool_calls || [];
    if (!toolCalls.length) {
      return { text: (msg.content || "").trim() || "(no answer)", model: MODEL };
    }

    // record the assistant's tool-call turn, then answer each call
    messages.push({
      role: "assistant",
      content: msg.content || "",
      tool_calls: toolCalls,
    });
    for (const tc of toolCalls) {
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        input = {};
      }
      let result;
      try {
        result = await executeTool(tc.function?.name, input);
      } catch (e) {
        result = { error: e.message };
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.function?.name,
        content: JSON.stringify(result).slice(0, 24000),
      });
    }
  }

  return { text: "Sorry — I couldn't complete that in time.", model: MODEL };
}

module.exports = { chat, isConfigured, MODEL };
