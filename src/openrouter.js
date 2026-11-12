// Minimal OpenRouter client (OpenAI-compatible chat completions), used when OPENROUTER_API_KEY is set.
import { config } from './config.js';

const URL = 'https://openrouter.ai/api/v1/chat/completions';
const BUSY = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class OpenRouterError extends Error {}

/** POST a chat completion; retries once when the provider is busy. Returns the first choice. */
export async function chat(body) {
  let res, data;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': config.baseUrl,
        'X-Title': 'GroundTruth',
      },
      body: JSON.stringify({ model: config.openrouter.model, ...body }),
    });
    data = await res.json().catch(() => ({}));
    if (res.ok && !data.error) break;
    if (!BUSY.has(res.status) || attempt === 1) break;
    await sleep(1500);
  }
  if (!res.ok || data.error) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new OpenRouterError(res.status === 402 ? `OpenRouter: out of credits. ${msg}` : `OpenRouter: ${msg}`);
  }
  const choice = data.choices?.[0];
  if (!choice) throw new OpenRouterError('OpenRouter returned no answer.');
  return { ...choice, model: data.model || config.openrouter.model };
}

/** Anthropic-style tool list → OpenAI-style function tools. */
export function toOpenAITools(tools) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}
