import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { config, paypalMock, aiMock, aiProvider, aiModel, aiName, ROOT } from './config.js';
import { db, bus, save, emit, id, resetDb, getBounty, getSubmission, getMission, initStore, flushStore, putUpload, getUpload, storage } from './store.js';
import * as paypal from './paypal.js';
import {
  createBounty,
  publicBounty,
  walletView,
  policyView,
  fundWallet,
  resolveAndPay,
  retryPayout,
  expireBounties,
  pollPayouts,
  cancelBounty,
  PolicyError,
} from './bounties.js';
import { verifySubmission } from './verify.js';
import { startMission, continueMission, missionView, recoverMissions } from './agent.js';
import { haversineMeters } from './geo.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
// Frontend: Vite build output (npm run build). Hashed assets are cached for a year; HTML is never cached.
const DIST = path.join(ROOT, 'dist');
if (!fs.existsSync(path.join(DIST, 'index.html'))) console.warn('[web] dist/ is missing: run "npm run build" to build the frontend.');
app.use('/assets', express.static(path.join(DIST, 'assets'), { immutable: true, maxAge: '1y' }));
app.use(express.static(DIST, { setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));

// Submitted photos: from Postgres when DATABASE_URL is set, else from data/uploads.
app.get('/uploads/:name', async (req, res, next) => {
  try {
    const f = await getUpload(path.basename(req.params.name));
    if (!f) return res.status(404).end();
    res.set({ 'Content-Type': f.mime, 'Cache-Control': 'public, max-age=3600' }).send(f.data);
  } catch (e) { next(e); }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/jpe?g$/.test(file.mimetype)),
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length < 200;
const AGENTS = new Set(['atlas', 'external']);

// ---------------------------------------------------------------- status & live events

app.get('/api/status', (_req, res) => {
  const paid = db.payouts.filter((p) => p.status === 'SUCCESS');
  res.json({
    paypal: paypal.paypalInfo(),
    ai: { mode: aiMock ? 'mock' : 'live', provider: aiProvider, name: aiName, model: aiModel },
    allowSimulatedGps: config.verify.allowSimulatedGps,
    storage,
    agents: Object.fromEntries([...AGENTS].map((a) => [a, { wallet: walletView(a), policy: policyView(a), name: db.agents[a].name }])),
    stats: {
      bountiesPosted: db.bounties.length,
      open: db.bounties.filter((b) => b.status === 'open').length,
      verified: db.bounties.filter((b) => ['resolved', 'paid'].includes(b.status)).length,
      submissions: db.submissions.length,
      rejected: db.submissions.filter((s) => s.status === 'rejected').length,
      paidOutUsd: Math.round(paid.reduce((s, p) => s + p.amountUsd, 0) * 100) / 100,
    },
  });
});

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  for (const ev of db.events.slice(-25)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const onEv = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  bus.on('event', onEv);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    bus.off('event', onEv);
    clearInterval(ping);
  });
});

// ---------------------------------------------------------------- bounties (public)

app.get('/api/bounties', (req, res) => {
  const { lat, lng, status } = req.query;
  let list = db.bounties.slice().reverse();
  if (status) list = list.filter((b) => b.status === status);
  const out = list.slice(0, 200).map((b) => {
    const pb = publicBounty(b);
    if (lat && lng) pb.distanceM = Math.round(haversineMeters(Number(lat), Number(lng), b.lat, b.lng));
    pb.submissionCount = db.submissions.filter((s) => s.bountyId === b.id).length;
    return pb;
  });
  res.json(out);
});

function bountyDetail(b) {
  const subs = db.submissions
    .filter((s) => s.bountyId === b.id)
    .map((s) => ({ ...s, payout: db.payouts.find((p) => p.id === s.payoutId) || null }));
  return { bounty: publicBounty(b), submissions: subs };
}

app.get('/api/bounties/:id', (req, res) => {
  const b = getBounty(req.params.id);
  if (!b) return res.status(404).json({ error: 'Bounty not found' });
  res.json(bountyDetail(b));
});

app.post('/api/bounties/:id/cancel', (req, res) => {
  const b = getBounty(req.params.id);
  if (!b) return res.status(404).json({ error: 'Bounty not found' });
  if (b.status !== 'open') return res.status(409).json({ error: `Bounty is ${b.status}` });
  cancelBounty(b.id);
  res.json(bountyDetail(b));
});

// Manual bounty posting from the owner console (same policy as the agent).
app.post('/api/bounties', (req, res) => {
  try {
    const b = createBounty({ ...req.body, agentId: AGENTS.has(req.body.agentId) ? req.body.agentId : 'atlas' });
    res.status(201).json(publicBounty(b));
  } catch (e) {
    res.status(e instanceof PolicyError ? 402 : 400).json({ error: e.message, rule: e.rule });
  }
});

// ---------------------------------------------------------------- submissions (hunters)

app.post(
  '/api/bounties/:id/submissions',
  upload.single('photo'),
  wrap(async (req, res) => {
    const b = getBounty(req.params.id);
    if (!b) return res.status(404).json({ error: 'Bounty not found' });
    if (b.status !== 'open' || Date.parse(b.expiresAt) < Date.now())
      return res.status(409).json({ error: `This bounty is no longer open (${b.status}).` });
    if (!req.file) return res.status(400).json({ error: 'A JPEG photo is required.' });
    const paypalEmail = String(req.body.paypalEmail || '').trim();
    if (!isEmail(paypalEmail)) return res.status(400).json({ error: 'A valid PayPal email is required to get paid.' });

    let meta;
    try {
      meta = JSON.parse(req.body.meta || '{}');
    } catch {
      return res.status(400).json({ error: 'Invalid meta' });
    }
    if (meta.simulated && !config.verify.allowSimulatedGps) return res.status(400).json({ error: 'Simulated GPS is disabled on this server.' });

    const subId = id('sub');
    const file = `${subId}.jpg`;
    await putUpload(file, req.file.buffer, req.file.mimetype);

    const sub = {
      id: subId,
      bountyId: b.id,
      paypalEmail,
      note: String(req.body.note || '').slice(0, 500),
      photoUrl: `/uploads/${file}`,
      capturedAt: meta.capturedAt,
      receivedAt: new Date().toISOString(),
      location: { lat: meta.lat, lng: meta.lng, accuracy: meta.accuracy, simulated: !!meta.simulated },
      source: meta.source,
      status: 'verifying',
    };
    emit('submission.received', { bountyId: b.id, submissionId: subId, title: b.title });

    const result = await verifySubmission({ bounty: b, imageBuffer: req.file.buffer, meta, note: sub.note });
    Object.assign(sub, { hash: result.hash, signals: result.signals, ai: result.ai, decision: result.decision });
    sub.status = result.decision === 'approved' ? 'approved' : result.decision; // needs_review | rejected
    db.submissions.push(sub);
    save();
    emit('submission.verified', { bountyId: b.id, submissionId: subId, decision: result.decision, title: b.title });

    if (result.decision === 'approved') {
      if (b.status === 'open') await resolveAndPay(b, sub);
      else {
        sub.status = 'superseded'; // someone else won the race while we were verifying
        save();
      }
    }
    res.status(201).json({ submission: getSubmission(subId), bounty: publicBounty(b) });
  }),
);

// Human-in-the-loop review by the agent's owner.
app.post(
  '/api/submissions/:id/review',
  wrap(async (req, res) => {
    const sub = getSubmission(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    if (sub.status !== 'needs_review') return res.status(409).json({ error: `Submission is ${sub.status}` });
    const b = getBounty(sub.bountyId);
    if (req.body.action === 'approve') {
      if (b.status !== 'open') return res.status(409).json({ error: `Bounty is ${b.status}` });
      sub.reviewedBy = 'owner';
      if (req.body.answer) sub.ai = { ...sub.ai, answer: String(req.body.answer).slice(0, 500) };
      await resolveAndPay(b, sub);
    } else {
      sub.status = 'rejected';
      sub.reviewedBy = 'owner';
      save();
      emit('submission.rejected', { bountyId: b.id, submissionId: sub.id });
    }
    res.json(bountyDetail(b));
  }),
);

app.post(
  '/api/payouts/:id/retry',
  wrap(async (req, res) => {
    await retryPayout(req.params.id);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- wallet funding (PayPal Orders)

app.post(
  '/api/wallet/:agentId/orders',
  wrap(async (req, res) => {
    if (!AGENTS.has(req.params.agentId)) return res.status(404).json({ error: 'Unknown agent' });
    const amount = Number(req.body.amount);
    if (!(amount >= 1 && amount <= 500)) return res.status(400).json({ error: 'Amount must be between $1 and $500.' });
    const order = await paypal.createOrder(amount, `GroundTruth wallet top-up (${req.params.agentId})`);
    db.pendingOrders = db.pendingOrders || {};
    db.pendingOrders[order.id] = { agentId: req.params.agentId, amount };
    save();
    res.json({ id: order.id, status: order.status, mock: !!order.mock });
  }),
);

app.post(
  '/api/wallet/:agentId/orders/:orderId/capture',
  wrap(async (req, res) => {
    const pending = db.pendingOrders?.[req.params.orderId];
    if (!pending || pending.agentId !== req.params.agentId) return res.status(404).json({ error: 'Unknown order' });
    const cap = await paypal.captureOrder(req.params.orderId, pending.amount);
    if (cap.status !== 'COMPLETED') return res.status(402).json({ error: `Payment not completed (${cap.status})` });
    delete db.pendingOrders[req.params.orderId];
    const wallet = fundWallet(req.params.agentId, cap.amount, {
      orderId: cap.orderId,
      captureId: cap.captureId,
      payerEmail: cap.payerEmail,
      mock: !!cap.mock,
    });
    res.json({ wallet, capture: cap });
  }),
);

// ---------------------------------------------------------------- agent missions

app.post('/api/missions', (req, res) => {
  const goal = String(req.body.goal || '').trim();
  if (!goal) return res.status(400).json({ error: 'Goal is required' });
  const m = startMission({ goal, userLocation: req.body.userLocation });
  res.status(201).json(missionView(m));
});
app.post("/api/missions/:id/messages", (req, res) => {
  const m = getMission(req.params.id);
  if (!m) return res.status(404).json({ error: "Mission not found" });
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "Message is required" });
  continueMission(m, { text, userLocation: req.body.userLocation });
  res.json(missionView(m));
});
app.get('/api/missions', (_req, res) => res.json(db.missions.slice().reverse().map(missionView)));
app.get('/api/missions/:id', (req, res) => {
  const m = getMission(req.params.id);
  if (!m) return res.status(404).json({ error: 'Mission not found' });
  res.json(missionView(m));
});

// ---------------------------------------------------------------- public agent API (REST)
// Any AI agent can hire humans: POST /api/v1/bounties with header x-api-key.

const requireKey = (req, res, next) =>
  req.get('x-api-key') === config.agentApiKey ? next() : res.status(401).json({ error: 'Missing or invalid x-api-key' });

app.get('/api/v1/wallet', requireKey, (_req, res) => res.json({ wallet: walletView('external'), policy: policyView('external') }));

app.post('/api/v1/bounties', requireKey, (req, res) => {
  const { title, question, answer_hint, lat, lng, place_name, radius_m, reward_usd, expires_in_minutes } = req.body || {};
  if (!title || !question || typeof lat !== 'number' || typeof lng !== 'number' || typeof reward_usd !== 'number')
    return res.status(400).json({ error: 'title, question, lat (number), lng (number) and reward_usd (number) are required' });
  try {
    const b = createBounty({
      agentId: 'external',
      title,
      question,
      answerHint: answer_hint,
      lat,
      lng,
      placeName: place_name,
      radiusM: radius_m,
      rewardUsd: reward_usd,
      expiresInMinutes: expires_in_minutes ?? 60,
    });
    res.status(201).json({ ...publicBounty(b), url: `${config.baseUrl}/bounty.html?id=${b.id}` });
  } catch (e) {
    res.status(e instanceof PolicyError ? 402 : 400).json({ error: e.message, rule: e.rule });
  }
});

app.get('/api/v1/bounties/:id', requireKey, (req, res) => {
  const b = getBounty(req.params.id);
  if (!b) return res.status(404).json({ error: 'Bounty not found' });
  const sub = b.resolvedSubmissionId ? getSubmission(b.resolvedSubmissionId) : null;
  res.json({
    ...publicBounty(b),
    evidence: sub
      ? { photoUrl: `${config.baseUrl}${sub.photoUrl}`, capturedAt: sub.capturedAt, signals: sub.signals, scene: sub.ai?.scene_description }
      : null,
  });
});

// ---------------------------------------------------------------- demo helpers

app.post('/api/demo/reset', (_req, res) => {
  resetDb();
  emit('demo.reset', {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------- errors & boot

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(err.status && err.status < 600 ? err.status : 500).json({ error: err.message || 'Server error' });
});

try {
  await initStore();
} catch (e) {
  console.error(`
[db] Could not connect to Postgres (DATABASE_URL): ${e.message}
`);
  process.exit(1);
}
recoverMissions();
setInterval(expireBounties, 15_000);
setInterval(pollPayouts, paypalMock ? 1500 : 5000);

app.listen(config.port, () => {
  console.log(`\nGroundTruth running at http://localhost:${config.port}`);
  console.log(`  PayPal: ${paypalMock ? 'MOCK (add PAYPAL_CLIENT_ID/SECRET to .env for sandbox)' : config.paypal.env}`);
  console.log(`  Data:   ${storage === 'postgres' ? `Postgres (namespace "${config.dbNamespace}")` : 'data/db.json'}`);
  console.log(`  AI:     ${aiMock ? 'MOCK (add OPENROUTER_API_KEY, GEMINI_API_KEY or ANTHROPIC_API_KEY to .env)' : `${aiName} · ${aiModel}`}\n`);
});

// Render sends SIGTERM before a redeploy: write any pending change first.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => flushStore().finally(() => process.exit(0)));
