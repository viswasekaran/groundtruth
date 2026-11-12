import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
export const DATA_DIR = path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(v));

export const config = {
  port: num(process.env.PORT, 3000),
  baseUrl: process.env.BASE_URL || `http://localhost:${num(process.env.PORT, 3000)}`,
  agentApiKey: process.env.AGENT_API_KEY || 'change-me-demo-key',

  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    env: process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox',
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    // Tried in order when the main model is overloaded or rate limited.
    fallbackModels: (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.7-flash,gemini-3.5-flash,gemini-2.5-flash')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },

  policy: {
    maxBountyUsd: num(process.env.MAX_BOUNTY_USD, 10),
    dailyCapUsd: num(process.env.DAILY_CAP_USD, 50),
    minWalletReserveUsd: num(process.env.MIN_WALLET_RESERVE_USD, 0),
  },

  verify: {
    maxCaptureAgeSeconds: num(process.env.MAX_CAPTURE_AGE_SECONDS, 120),
    duplicateHammingThreshold: num(process.env.DUPLICATE_HAMMING_THRESHOLD, 6),
    allowSimulatedGps: bool(process.env.ALLOW_SIMULATED_GPS, true),
  },
};

export const paypalMock = !(config.paypal.clientId && config.paypal.clientSecret);
// AI provider: Claude if its key is set, else Gemini, else mock. AI_PROVIDER=claude|gemini|mock forces one.
const forced = (process.env.AI_PROVIDER || '').toLowerCase();
export const aiProvider =
  forced === 'mock' ? 'mock'
  : forced === 'gemini' && config.gemini.apiKey ? 'gemini'
  : forced === 'claude' && config.anthropic.apiKey ? 'claude'
  : config.anthropic.apiKey ? 'claude'
  : config.gemini.apiKey ? 'gemini'
  : 'mock';
export const aiMock = aiProvider === 'mock';
export const aiModel = aiProvider === 'gemini' ? config.gemini.model : aiProvider === 'claude' ? config.anthropic.model : 'mock';
export const aiName = aiProvider === 'gemini' ? 'Gemini' : aiProvider === 'claude' ? 'Claude' : 'AI';
