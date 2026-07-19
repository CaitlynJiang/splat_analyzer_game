import { Vision } from "./Vision.js";

// Thin client for game_server.py. Every method degrades to something playable
// if the server is down or has no API key — a hackathon demo should never be
// one failed fetch away from a blank screen.

const API = "";  // same origin

async function post(path, body, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function localAnswer(observations) {
  if (!observations.length) return "Nothing in range. Only floor.";
  const o = observations[0];
  let s = `${o.bearing[0].toUpperCase()}${o.bearing.slice(1)}, ${o.distance}. Something ${o.build}, ${o.bulk}.`;
  if (observations.length > 1) s += ` Another shape ${observations[1].bearing}.`;
  return s;
}

export const Llm = {
  online: null, // null = unknown, true/false after first call

  async health() {
    try {
      const r = await fetch(`${API}/api/health`);
      const j = await r.json();
      this.online = !!j.llm;
      if (!j.llm) console.warn("[VIN] LLM unavailable:", j);
      return j;
    } catch (e) {
      this.online = false;
      return { ok: false, llm: false, error: String(e) };
    }
  },

  /**
   * @param {string|null} question - null means "just report"
   * @returns {{text: string, source: string}} source is "llm" when the model
   *   actually answered, anything else means a template stood in for it.
   */
  async ask(observations, question = null, history = []) {
    try {
      const j = await post("/api/ask", {
        observations: Vision.toFacts(observations),
        question,
        history,
      });
      return { text: j.text, source: j.source ?? "unknown" };
    } catch (e) {
      console.warn("ask failed, using local template", e);
      return { text: localAnswer(observations), source: "offline" };
    }
  },

  /** @returns {string|null} the matched candidate label */
  async judge(guess, candidates) {
    try {
      const j = await post("/api/judge", { guess, candidates }, 8000);
      return j.match ?? null;
    } catch (e) {
      console.warn("judge failed, falling back to exact match", e);
      const n = (s) => s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ");
      return candidates.find((c) => n(c) === n(guess)) ?? null;
    }
  },
};
