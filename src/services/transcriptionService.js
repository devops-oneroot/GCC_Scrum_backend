const CallTranscript = require("../models/CallTranscript");
const { fetchRecording } = require("./exotelService");

/**
 * Turns an Exotel call recording into an English, speaker-split conversation
 * plus a short "how did the call go" summary.
 *
 *   1. Speech-to-text with Whisper's /audio/translations endpoint, which always
 *      outputs English — calls switch between English, Telugu, Kannada, Hindi.
 *   2. A chat model splits the text into Agent / Customer turns, tidies the
 *      wording and writes the summary + result, all in one JSON reply.
 *
 * Both steps use an OpenAI-compatible API (default: Groq, free). backend/.env:
 *   TRANSCRIBE_API_KEY     a Groq key from https://console.groq.com/keys
 *   TRANSCRIBE_BASE_URL    default https://api.groq.com/openai/v1
 *   TRANSCRIBE_MODEL       speech model, default whisper-large-v3
 *   TRANSCRIPT_CHAT_MODEL  chat model, default openai/gpt-oss-120b
 */

function cfg() {
  const baseUrl = (process.env.TRANSCRIBE_BASE_URL || "https://api.groq.com/openai/v1")
    .trim()
    .replace(/\/+$/, "");
  const key = (process.env.TRANSCRIBE_API_KEY || "").trim();
  const sttModel = (process.env.TRANSCRIBE_MODEL || "").trim() || "whisper-large-v3";
  const chatModel = (process.env.TRANSCRIPT_CHAT_MODEL || "").trim() || "openai/gpt-oss-120b";
  return { baseUrl, key, sttModel, chatModel };
}

function isConfigured() {
  return Boolean(cfg().key);
}

const RESULTS = [
  "booked",
  "interested",
  "follow_up",
  "not_interested",
  "no_conversation",
  "unclear",
];

/** Whisper, translated to English. Returns the timed segments' text. */
async function speechToEnglish(buffer, contentType) {
  const { baseUrl, key, sttModel } = cfg();
  const ext = /wav/i.test(contentType) ? "wav" : "mp3";
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: contentType }), `call.${ext}`);
  form.append("model", sttModel);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");

  const res = await fetch(`${baseUrl}/audio/translations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Transcription failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const data = JSON.parse(body);
  const segments = (data.segments || [])
    .map((s) => String(s.text || "").trim())
    .filter(Boolean)
    // Whisper repeats filler ("hello hello…") on silence — drop exact repeats
    .filter((t, i, arr) => t !== arr[i - 1]);
  return {
    text: segments.length ? segments.join("\n") : String(data.text || "").trim(),
    language: data.language || "",
  };
}

const SYSTEM_PROMPT = [
  "You turn a machine transcript of a phone call into a clean conversation.",
  "The call is between a sales AGENT of Gold Coins and Clubs (GCC) resort and a CUSTOMER enquiring about stays, weddings, day outings or events.",
  "The transcript has no speaker labels, one line per audio segment; a line may hold both speakers.",
  "Split it into turns and decide who is speaking from context: the agent greets with the resort name, quotes prices, describes rooms/meals/packages and offers to send details; the customer asks questions, gives dates, guest counts and negotiates.",
  "This is a transcript, NOT a summary: keep every meaningful sentence, in the original order, as close to the speaker's own words as possible. Do not merge separate exchanges or shorten them; a question and its answer are separate turns.",
  "Write every turn in plain English. Translate any non-English words. Fix only obvious mis-hearings, keep all numbers, prices, dates and names exactly as heard, and drop meaningless filler and repeated 'hello's. Never add words nobody said; skip garbled parts you cannot understand.",
  'Reply with JSON only: {"turns":[{"speaker":"agent"|"customer","text":string}],"summary":string,"result":string,"nextStep":string}.',
  "summary: 1-3 short sentences — what the customer wanted (dates, guests, room type, budget, prices quoted) and how the call ended.",
  `result: exactly one of ${RESULTS.join(", ")} — booked if the customer confirmed/paid; follow_up if a quote, details or a callback was promised; interested if they engaged positively with no next step; not_interested if they declined; no_conversation if nobody really spoke; unclear only when you truly cannot tell.`,
  'nextStep: the agreed follow-up in a few words, or "".',
].join(" ");

async function chatJson(model, text) {
  const { baseUrl, key } = cfg();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 8000,
      ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text.slice(0, 20000) },
      ],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  const raw = JSON.parse(body).choices?.[0]?.message?.content || "{}";
  return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
}

/** Speaker turns + summary. Never throws — falls back to the raw lines. */
async function toConversation(text) {
  if (!text) return { turns: [], summary: "", result: "no_conversation", nextStep: "" };
  const { chatModel } = cfg();
  // the smaller model is a fallback for rate limits on the free tier
  for (const model of [...new Set([chatModel, "openai/gpt-oss-20b"])]) {
    try {
      const j = await chatJson(model, text);
      const turns = (Array.isArray(j.turns) ? j.turns : [])
        .map((t) => ({
          speaker: t?.speaker === "customer" ? "customer" : "agent",
          text: String(t?.text || "").trim(),
        }))
        .filter((t) => t.text);
      return {
        turns,
        summary: String(j.summary || "").trim(),
        result: RESULTS.includes(j.result) ? j.result : "unclear",
        nextStep: String(j.nextStep || "").trim(),
      };
    } catch (err) {
      console.warn(`[transcribe] ${model} failed:`, err.message);
    }
  }
  return { turns: [], summary: "", result: "unclear", nextStep: "" };
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
    const { text, language } = await speechToEnglish(rec.buffer, rec.contentType);
    const convo = await toConversation(text);
    return CallTranscript.findOneAndUpdate(
      { sid },
      { $set: { text, language, ...convo, createdBy: by } },
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
