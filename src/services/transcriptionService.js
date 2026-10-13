const CallTranscript = require("../models/CallTranscript");
const { fetchRecording } = require("./exotelService");

/**
 * Turns an Exotel call recording into a transcript + a short "how did the call
 * go" summary.
 *
 * Speech-to-text uses an OpenAI-compatible /audio/transcriptions endpoint
 * (default: Groq's free Whisper). Config in backend/.env:
 *   TRANSCRIBE_API_KEY   e.g. a Groq key from https://console.groq.com/keys
 *   TRANSCRIBE_BASE_URL  default https://api.groq.com/openai/v1
 *   TRANSCRIBE_MODEL     default whisper-large-v3
 * The summary reuses the assistant's chat model (AI_BASE_URL / AI_API_KEY / AI_MODEL).
 */

const AI_BASE = (process.env.AI_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
const AI_KEY = (process.env.AI_API_KEY || "").trim();
const AI_MODEL = (process.env.AI_MODEL || "").trim() || "llama-3.3-70b-versatile";

function sttCfg() {
  const baseUrl = (process.env.TRANSCRIBE_BASE_URL || "https://api.groq.com/openai/v1")
    .trim()
    .replace(/\/+$/, "");
  // the assistant's key works too when it is already a Groq key
  const key =
    (process.env.TRANSCRIBE_API_KEY || "").trim() ||
    (AI_BASE.includes("groq.com") && baseUrl.includes("groq.com") ? AI_KEY : "");
  const model = (process.env.TRANSCRIBE_MODEL || "").trim() || "whisper-large-v3";
  return { baseUrl, key, model };
}

function isConfigured() {
  return Boolean(sttCfg().key);
}

const RESULTS = [
  "booked",
  "interested",
  "follow_up",
  "not_interested",
  "no_conversation",
  "unclear",
];

async function speechToText(buffer, contentType) {
  const { baseUrl, key, model } = sttCfg();
  const ext = /wav/i.test(contentType) ? "wav" : "mp3";
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: contentType }), `call.${ext}`);
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");

  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Transcription failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const data = JSON.parse(body);
  return { text: String(data.text || "").trim(), language: data.language || "" };
}

/** Ask the chat model how the call went. Never throws — a summary is a bonus. */
async function summarize(text) {
  if (!AI_KEY || !text) return { summary: "", result: text ? "unclear" : "no_conversation", nextStep: "" };
  try {
    const res = await fetch(`${AI_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AI_KEY}` },
      body: JSON.stringify({
        model: AI_MODEL,
        temperature: 0.1,
        max_tokens: 400,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You review phone calls between a resort sales agent (Gold Coins and Clubs, GCC) and a customer.",
              "The transcript is machine-made and may mix English, Hindi, Kannada or Tamil, without speaker labels.",
              'Reply with JSON only: {"summary": string, "result": string, "nextStep": string}.',
              "summary: 1-3 short English sentences — what the customer wanted (stay, wedding, day outing, dates, guests, budget) and how it ended.",
              `result: exactly one of ${RESULTS.join(", ")}.`,
              'nextStep: the agreed follow-up in a few words, or "" if none.',
            ].join(" "),
          },
          { role: "user", content: text.slice(0, 12000) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || "{}";
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return {
      summary: String(j.summary || "").trim(),
      result: RESULTS.includes(j.result) ? j.result : "unclear",
      nextStep: String(j.nextStep || "").trim(),
    };
  } catch (err) {
    console.warn("[transcribe] summary failed:", err.message);
    return { summary: "", result: "unclear", nextStep: "" };
  }
}

const pending = new Map(); // sid -> promise, so double-clicks share one job

async function transcribeCall(sid, { force = false, by = "" } = {}) {
  if (!force) {
    const existing = await CallTranscript.findOne({ sid }).lean();
    if (existing) return existing;
  }
  if (pending.has(sid)) return pending.get(sid);

  const job = (async () => {
    if (!isConfigured()) {
      const err = new Error(
        "Transcription is not configured. Add TRANSCRIBE_API_KEY (a free Groq key) to backend/.env"
      );
      err.status = 503;
      throw err;
    }
    const rec = await fetchRecording(sid);
    if (!rec.ok) {
      const err = new Error(rec.message);
      err.status = rec.status;
      throw err;
    }
    const { text, language } = await speechToText(rec.buffer, rec.contentType);
    const ai = await summarize(text);
    return CallTranscript.findOneAndUpdate(
      { sid },
      { $set: { text, language, ...ai, createdBy: by } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  })().finally(() => pending.delete(sid));

  pending.set(sid, job);
  return job;
}

/** sid -> short transcript info, for marking rows in the call list. */
async function transcriptMap(sids) {
  if (!sids.length) return new Map();
  const rows = await CallTranscript.find(
    { sid: { $in: sids } },
    { sid: 1, summary: 1, result: 1, nextStep: 1 }
  ).lean();
  return new Map(rows.map((r) => [r.sid, r]));
}

module.exports = { isConfigured, transcribeCall, transcriptMap };
