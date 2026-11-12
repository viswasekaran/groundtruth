// Minimal Google Gemini client (REST, no SDK) used when GEMINI_API_KEY is set instead of ANTHROPIC_API_KEY.
import { config } from './config.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUSY = new Set([429, 500, 503, 504]);

async function call(model, body) {
  const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/**
 * POST models/{model}:generateContent and return the first candidate.
 * Free-tier models are often overloaded (503) or rate limited (429): retry once, then try the fallback models.
 */
export async function generate(body) {
  const models = [config.gemini.model, ...config.gemini.fallbackModels.filter((m) => m !== config.gemini.model)];
  let last, used;
  for (const model of models) {
    used = model;
    for (let attempt = 0; attempt < 2; attempt++) {
      last = await call(model, body);
      if (last.ok || !BUSY.has(last.status)) break;
      if (attempt === 0) await sleep(1500);
    }
    if (last.ok || !BUSY.has(last.status)) break;
    console.warn(`[gemini] ${model} busy (${last.status}), trying next model`);
  }
  const { ok, status, data } = last;
  if (!ok) {
    const msg = data?.error?.message || `HTTP ${status}`;
    throw new GeminiError(status === 429 ? `Gemini rate limit reached (free tier). Try again in a minute. ${msg}` : `Gemini: ${msg}`);
  }
  const cand = data.candidates?.[0];
  if (!cand) throw new GeminiError(`Gemini returned no answer${data.promptFeedback?.blockReason ? ` (blocked: ${data.promptFeedback.blockReason})` : ''}.`);
  cand.modelUsed = used;
  return cand;
}

/** Convert a JSON Schema (Anthropic tool input_schema) to the subset Gemini function declarations accept. */
export function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' || k === '$schema') continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, toGeminiSchema(s)])) : toGeminiSchema(v);
  }
  return out;
}

/** Anthropic-style tool list → Gemini functionDeclarations. */
export function toGeminiTools(tools) {
  return [
    {
      functionDeclarations: tools.map((t) => {
        const hasProps = t.input_schema?.properties && Object.keys(t.input_schema.properties).length;
        return { name: t.name, description: t.description, ...(hasProps ? { parameters: toGeminiSchema(t.input_schema) } : {}) };
      }),
    },
  ];
}
