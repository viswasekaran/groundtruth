// Layered verification: live capture, location, freshness, duplicate photo, Claude vision.
import jpeg from 'jpeg-js';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config, aiMock, aiProvider, aiModel } from './config.js';
import { generate as geminiGenerate } from './gemini.js';
import { db } from './store.js';
import { haversineMeters } from './geo.js';

const client = aiProvider === 'claude' ? new Anthropic({ apiKey: config.anthropic.apiKey }) : null;

// ---------------------------------------------------------------- perceptual hash (dHash)

/** 64-bit difference hash of a JPEG buffer, as 16 hex chars. Robust to resizing/re-encoding. */
export function dHash(jpegBuffer) {
  const img = jpeg.decode(jpegBuffer, { useTArray: true, maxMemoryUsageInMB: 256 });
  const W = 9;
  const H = 8;
  const gray = new Float64Array(W * H);
  // Box-average each cell of a 9x8 grid.
  for (let gy = 0; gy < H; gy++) {
    const y0 = Math.floor((gy * img.height) / H);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * img.height) / H));
    for (let gx = 0; gx < W; gx++) {
      const x0 = Math.floor((gx * img.width) / W);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * img.width) / W));
      let sum = 0;
      let n = 0;
      const step = Math.max(1, Math.floor((x1 - x0) / 16)); // subsample big cells
      for (let y = y0; y < y1; y += step)
        for (let x = x0; x < x1; x += step) {
          const i = (y * img.width + x) * 4;
          sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
          n++;
        }
      gray[gy * W + gx] = sum / n;
    }
  }
  let bits = 0n;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W - 1; x++) bits = (bits << 1n) | (gray[y * W + x] > gray[y * W + x + 1] ? 1n : 0n);
  return { hash: bits.toString(16).padStart(16, '0'), width: img.width, height: img.height };
}

export function hamming(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

// ---------------------------------------------------------------- Claude vision verdict

const Verdict = z.object({
  answers_question: z.boolean().describe('Does the photo actually contain the evidence needed to answer the task?'),
  answer: z.string().describe('The concise factual answer to the task, as observed in the photo. Empty if unanswerable.'),
  confidence: z.number().describe('0.0 to 1.0 confidence in the answer'),
  scene_description: z.string().describe('One sentence: what the photo shows.'),
  suspected_screen_photo: z.boolean().describe('Photo appears to be of a monitor/phone screen or a printed photo (moire, bezels, pixel grid, glare).'),
  suspected_ai_generated: z.boolean().describe('Photo shows signs of AI generation or heavy manipulation.'),
  suspicious_reasons: z.array(z.string()).describe('Specific observations that reduce trust. Empty if none.'),
  reasoning: z.string().describe('Two or three sentences explaining the verdict, for the human reviewer.'),
});

const VERIFIER_SYSTEM = `You are the referee for GroundTruth, a marketplace where AI agents pay humans to capture live, real-world evidence.
A human was paid to take a photo at a specific place to answer an agent's task. Judge ONLY what is visible in the photo.
- Be strict: if the photo does not show the evidence the task asks for, answers_question is false.
- Extract a concise, factual answer an agent can act on (e.g. "Open; ~8 of 20 tables occupied; short queue").
- Flag photos of screens or prints, and images that look AI-generated or edited. Explain concrete visual cues.
- The human's note is a claim, not evidence. Use it only if the photo supports it.`;

async function visionVerdict(bounty, imageBuffer, note) {
  if (aiMock) {
    return {
      mock: true,
      answers_question: true,
      answer: note?.trim() || 'Photo received (AI check skipped: no AI key set).',
      confidence: 0.75,
      scene_description: 'AI vision check skipped in mock mode.',
      suspected_screen_photo: false,
      suspected_ai_generated: false,
      suspicious_reasons: [],
      reasoning: 'Mock mode: add GEMINI_API_KEY or ANTHROPIC_API_KEY to enable AI vision verification.',
    };
  }
  const taskText =
    `TASK: ${bounty.question}\n` +
    (bounty.answerHint ? `EXPECTED ANSWER FORMAT: ${bounty.answerHint}\n` : '') +
    `PLACE: ${bounty.placeName || `${bounty.lat}, ${bounty.lng}`}\n` +
    `HUMAN'S NOTE (unverified claim): ${note?.trim() || '(none)'}`;
  if (aiProvider === 'gemini') return geminiVerdict(imageBuffer, taskText);
  const response = await client.messages.parse({
    model: config.anthropic.model,
    max_tokens: 4000,
    output_config: { effort: 'low', format: zodOutputFormat(Verdict) },
    system: VERIFIER_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBuffer.toString('base64') } },
          {
            type: 'text',
            text:
              `TASK: ${bounty.question}\n` +
              (bounty.answerHint ? `EXPECTED ANSWER FORMAT: ${bounty.answerHint}\n` : '') +
              `PLACE: ${bounty.placeName || `${bounty.lat}, ${bounty.lng}`}\n` +
              `HUMAN'S NOTE (unverified claim): ${note?.trim() || '(none)'}`,
          },
        ],
      },
    ],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    return {
      error: response.stop_reason === 'refusal' ? 'Model declined to judge this image.' : 'Could not parse model verdict.',
      answers_question: false,
      answer: '',
      confidence: 0,
      scene_description: '',
      suspected_screen_photo: false,
      suspected_ai_generated: false,
      suspicious_reasons: [],
      reasoning: 'Automatic check unavailable; sending to human review.',
    };
  }
  return { ...response.parsed_output, model: config.anthropic.model };
}

const unavailable = (error) => ({
  error,
  answers_question: false,
  answer: '',
  confidence: 0,
  scene_description: '',
  suspected_screen_photo: false,
  suspected_ai_generated: false,
  suspicious_reasons: [],
  reasoning: 'Automatic check unavailable; sending to human review.',
});

async function geminiVerdict(imageBuffer, taskText) {
  const { $schema, ...schema } = z.toJSONSchema(Verdict);
  const cand = await geminiGenerate({
    systemInstruction: { parts: [{ text: VERIFIER_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: imageBuffer.toString('base64') } }, { text: taskText }] }],
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema },
  });
  const text = (cand.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  let parsed;
  try {
    parsed = Verdict.safeParse(JSON.parse(text));
  } catch {
    parsed = { success: false };
  }
  if (!parsed.success) return unavailable(cand.finishReason === 'SAFETY' ? 'Model declined to judge this image.' : 'Could not parse model verdict.');
  return { ...parsed.data, model: cand.modelUsed || aiModel };
}

// ---------------------------------------------------------------- the pipeline

/**
 * @returns {{ decision: 'approved'|'needs_review'|'rejected', signals: object[], ai: object, hash: string }}
 */
export async function verifySubmission({ bounty, imageBuffer, meta, note }) {
  const signals = [];
  const add = (key, label, status, detail) => signals.push({ key, label, status, detail }); // status: pass|warn|fail

  // 1. Live capture
  if (meta.source === 'camera') add('capture', 'Live camera capture', 'pass', 'Captured in-app from the live camera stream.');
  else add('capture', 'Live camera capture', 'warn', 'Not captured from the live camera stream.');

  // 2. Location
  if (meta.simulated) {
    add('location', 'Location', 'warn', 'Simulated GPS (desktop demo mode) — needs human review.');
  } else if (typeof meta.lat !== 'number' || typeof meta.lng !== 'number') {
    add('location', 'Location', 'fail', 'No GPS position provided.');
  } else {
    const d = haversineMeters(meta.lat, meta.lng, bounty.lat, bounty.lng);
    const acc = Number(meta.accuracy) || 0;
    if (d <= bounty.radiusM && acc <= 100)
      add('location', 'Location', 'pass', `${Math.round(d)} m from target (radius ${bounty.radiusM} m, GPS ±${Math.round(acc)} m).`);
    else if (d <= bounty.radiusM + acc)
      add('location', 'Location', 'warn', `${Math.round(d)} m from target, but GPS accuracy is low (±${Math.round(acc)} m).`);
    else add('location', 'Location', 'fail', `${Math.round(d)} m from target — outside the ${bounty.radiusM} m radius.`);
  }

  // 3. Freshness
  const capturedAt = Date.parse(meta.capturedAt);
  const age = (Date.now() - capturedAt) / 1000;
  if (Number.isNaN(capturedAt)) add('freshness', 'Freshness', 'fail', 'Missing capture timestamp.');
  else if (age < -30 || age > config.verify.maxCaptureAgeSeconds)
    add('freshness', 'Freshness', 'fail', `Captured ${Math.round(age)} s before upload (limit ${config.verify.maxCaptureAgeSeconds} s).`);
  else if (capturedAt < Date.parse(bounty.createdAt))
    add('freshness', 'Freshness', 'fail', 'Photo was taken before the bounty was posted.');
  else add('freshness', 'Freshness', 'pass', `Captured ${Math.max(0, Math.round(age))} s before upload, after the bounty was posted.`);

  // 4. Duplicate / recycled photo
  let hash = null;
  try {
    const h = dHash(imageBuffer);
    hash = h.hash;
    let best = null;
    for (const s of db.submissions) {
      if (!s.hash) continue;
      const dist = hamming(hash, s.hash);
      if (!best || dist < best.dist) best = { dist, id: s.id, bountyId: s.bountyId };
    }
    if (best && best.dist <= config.verify.duplicateHammingThreshold)
      add('duplicate', 'Original photo', 'fail', `Near-identical to earlier submission ${best.id} (hash distance ${best.dist}/64).`);
    else add('duplicate', 'Original photo', 'pass', best ? `Closest previous photo is ${best.dist}/64 bits different.` : 'First photo in the system.');
  } catch (e) {
    add('duplicate', 'Original photo', 'fail', `Could not decode image as JPEG: ${e.message}`);
  }

  // 5. Claude vision
  let ai;
  try {
    ai = await visionVerdict(bounty, imageBuffer, note);
  } catch (e) {
    ai = { error: e.message, answers_question: false, confidence: 0, suspicious_reasons: [], reasoning: 'AI check failed; sending to human review.' };
  }
  if (ai.mock) add('ai', 'AI evidence check', 'warn', 'Skipped (mock mode: no AI key set).');
  else if (ai.error) add('ai', 'AI evidence check', 'warn', ai.error);
  else if (ai.suspected_screen_photo || ai.suspected_ai_generated)
    add('ai', 'AI evidence check', 'fail', `Suspected ${ai.suspected_screen_photo ? 'photo of a screen' : 'AI-generated image'}: ${ai.suspicious_reasons.join('; ')}`);
  else if (!ai.answers_question) add('ai', 'AI evidence check', ai.confidence >= 0.7 ? 'fail' : 'warn', ai.reasoning);
  else if (ai.confidence < 0.6) add('ai', 'AI evidence check', 'warn', `Low confidence (${ai.confidence}). ${ai.reasoning}`);
  else add('ai', 'AI evidence check', 'pass', ai.reasoning);

  // Decision
  const fails = signals.filter((s) => s.status === 'fail');
  const warns = signals.filter((s) => s.status === 'warn');
  // Mock AI alone should not block an otherwise-clean demo submission.
  const blockingWarns = warns.filter((w) => !(w.key === 'ai' && ai.mock));
  const decision = fails.length ? 'rejected' : blockingWarns.length ? 'needs_review' : 'approved';

  return { decision, signals, ai, hash };
}
