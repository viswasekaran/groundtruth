// Wallet ledger, spending policy (agent firewall), bounty lifecycle and payouts.
import { config } from './config.js';
import { db, save, emit, id, round2, getAgent, getBounty } from './store.js';
import * as paypal from './paypal.js';

export class PolicyError extends Error {
  constructor(message, rule) {
    super(message);
    this.rule = rule;
  }
}

const resolvedHandlers = [];
/** Register a callback fired when a bounty gets a verified answer (used to wake the agent). */
export const onBountyResolved = (fn) => resolvedHandlers.push(fn);

export function walletView(agentId) {
  const a = getAgent(agentId);
  const { balance, reserved, currency } = a.wallet;
  return { balance: round2(balance), reserved: round2(reserved), available: round2(balance - reserved), currency };
}

export function fundWallet(agentId, amount, meta = {}) {
  const a = getAgent(agentId);
  if (!a) throw new Error(`Unknown agent ${agentId}`);
  a.wallet.balance = round2(a.wallet.balance + amount);
  a.fundings.push({ at: new Date().toISOString(), amount, ...meta });
  save();
  emit('wallet.funded', { agentId, amount, orderId: meta.orderId, mock: !!meta.mock });
  return walletView(agentId);
}

// ---------------------------------------------------------------- policy (agent firewall)

export function policyView(agentId) {
  const spentToday = spentTodayUsd(agentId);
  return {
    ...config.policy,
    spentTodayUsd: spentToday,
    remainingTodayUsd: round2(Math.max(0, config.policy.dailyCapUsd - spentToday)),
  };
}

function spentTodayUsd(agentId) {
  const today = new Date().toISOString().slice(0, 10);
  return round2(
    db.bounties
      .filter((b) => b.agentId === agentId && b.createdAt.startsWith(today) && !['cancelled', 'expired'].includes(b.status))
      .reduce((s, b) => s + b.rewardUsd, 0),
  );
}

/** Throws PolicyError when the agent is not allowed to commit this reward. */
export function enforcePolicy(agentId, rewardUsd) {
  const p = config.policy;
  const w = walletView(agentId);
  if (!(rewardUsd >= 0.5)) throw new PolicyError('Reward must be at least $0.50.', 'min_reward');
  if (rewardUsd > p.maxBountyUsd)
    throw new PolicyError(`Reward $${rewardUsd} exceeds the per-bounty cap of $${p.maxBountyUsd}.`, 'max_bounty');
  const spent = spentTodayUsd(agentId);
  if (spent + rewardUsd > p.dailyCapUsd)
    throw new PolicyError(
      `Daily cap reached: $${spent} already committed today, cap is $${p.dailyCapUsd}.`,
      'daily_cap',
    );
  if (w.available - rewardUsd < p.minWalletReserveUsd)
    throw new PolicyError(
      `Insufficient wallet funds: $${w.available} available, need $${rewardUsd}` +
        (p.minWalletReserveUsd ? ` plus a $${p.minWalletReserveUsd} reserve.` : '.') +
        ' Ask the owner to top up with PayPal.',
      'insufficient_funds',
    );
}

// ---------------------------------------------------------------- bounties

export function createBounty(input) {
  const {
    agentId,
    missionId = null,
    title,
    question,
    answerHint = '',
    lat,
    lng,
    placeName = '',
    radiusM = 150,
    rewardUsd,
    expiresInMinutes = 60,
  } = input;
  const reward = round2(Number(rewardUsd));
  enforcePolicy(agentId, reward);

  const a = getAgent(agentId);
  a.wallet.reserved = round2(a.wallet.reserved + reward); // escrow in the internal ledger

  const now = Date.now();
  const bounty = {
    id: id('bty'),
    agentId,
    missionId,
    title: String(title).slice(0, 120),
    question: String(question).slice(0, 1000),
    answerHint: String(answerHint).slice(0, 300),
    lat: Number(lat),
    lng: Number(lng),
    placeName: String(placeName).slice(0, 300),
    radiusM: Math.min(Math.max(Number(radiusM) || 150, 50), 2000),
    rewardUsd: reward,
    status: 'open',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.min(Math.max(expiresInMinutes, 5), 24 * 60) * 60_000).toISOString(),
    resolvedSubmissionId: null,
    answer: null,
  };
  db.bounties.push(bounty);
  save();
  emit('bounty.posted', { bountyId: bounty.id, agentId, title: bounty.title, rewardUsd: reward, lat: bounty.lat, lng: bounty.lng });
  return bounty;
}

export function publicBounty(b) {
  return { ...b, expired: Date.parse(b.expiresAt) < Date.now() };
}

export function cancelBounty(bountyId, reason = 'cancelled') {
  const b = getBounty(bountyId);
  if (!b || b.status !== 'open') return b;
  b.status = reason === 'expired' ? 'expired' : 'cancelled';
  const a = getAgent(b.agentId);
  a.wallet.reserved = round2(Math.max(0, a.wallet.reserved - b.rewardUsd)); // release escrow
  save();
  emit(`bounty.${b.status}`, { bountyId: b.id, title: b.title, rewardUsd: b.rewardUsd });
  return b;
}

export function expireBounties() {
  const now = Date.now();
  for (const b of db.bounties) if (b.status === 'open' && Date.parse(b.expiresAt) < now) cancelBounty(b.id, 'expired');
}

/** Called once a submission is approved (automatically or by a human reviewer). */
export async function resolveAndPay(bounty, submission) {
  if (bounty.status !== 'open') throw new Error(`Bounty is ${bounty.status}, cannot pay again.`);
  bounty.status = 'resolved';
  bounty.resolvedSubmissionId = submission.id;
  bounty.answer = submission.ai?.answer || submission.note || '(see photo)';
  submission.status = 'approved';
  save();
  emit('bounty.resolved', { bountyId: bounty.id, submissionId: submission.id, title: bounty.title, answer: bounty.answer });

  // Other pending submissions for this bounty lose the race.
  for (const s of db.submissions)
    if (s.bountyId === bounty.id && s.id !== submission.id && ['needs_review', 'pending'].includes(s.status)) s.status = 'superseded';

  await sendPayout(bounty, submission);
  for (const fn of resolvedHandlers) Promise.resolve(fn(bounty, submission)).catch((e) => console.error('[resolved handler]', e));
}

async function sendPayout(bounty, submission) {
  const payout = {
    id: id('pay'),
    bountyId: bounty.id,
    submissionId: submission.id,
    receiver: submission.paypalEmail,
    amountUsd: bounty.rewardUsd,
    status: 'creating',
    createdAt: new Date().toISOString(),
  };
  db.payouts.push(payout);
  submission.payoutId = payout.id;
  save();
  try {
    const res = await paypal.createPayout({
      receiverEmail: submission.paypalEmail,
      amountUsd: bounty.rewardUsd,
      note: `GroundTruth bounty: ${bounty.title}`,
      senderItemId: submission.id,
    });
    payout.batchId = res.batchId;
    payout.status = res.status; // PENDING
    payout.mock = !!res.mock;
    const a = getAgent(bounty.agentId);
    a.wallet.reserved = round2(Math.max(0, a.wallet.reserved - bounty.rewardUsd));
    a.wallet.balance = round2(a.wallet.balance - bounty.rewardUsd);
    save();
    emit('payout.sent', { bountyId: bounty.id, payoutId: payout.id, batchId: res.batchId, amountUsd: bounty.rewardUsd, mock: !!res.mock });
  } catch (e) {
    payout.status = 'FAILED';
    payout.error = e.message;
    payout.details = e.details;
    save();
    emit('payout.failed', { bountyId: bounty.id, payoutId: payout.id, error: e.message });
  }
}

/** Retry a failed payout (e.g. after fixing sandbox config). */
export async function retryPayout(payoutId) {
  const p = db.payouts.find((x) => x.id === payoutId);
  if (!p || p.status !== 'FAILED') throw new Error('Only failed payouts can be retried.');
  const bounty = getBounty(p.bountyId);
  const sub = db.submissions.find((s) => s.id === p.submissionId);
  p.status = 'retried';
  save();
  await sendPayout(bounty, sub);
}

const FINAL = new Set(['SUCCESS', 'DENIED', 'FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'UNCLAIMED', 'CANCELED']);

export async function pollPayouts() {
  for (const p of db.payouts) {
    if (!p.batchId || FINAL.has(p.status) || p.status === 'retried') continue;
    try {
      const r = await paypal.getPayout(p.batchId);
      const status = r.itemStatus || r.batchStatus;
      if (status && status !== p.status) {
        p.status = status;
        p.transactionId = r.transactionId || p.transactionId;
        save();
        const b = getBounty(p.bountyId);
        if (status === 'SUCCESS' && b) {
          b.status = 'paid';
          save();
        }
        emit('payout.status', { bountyId: p.bountyId, payoutId: p.id, status, transactionId: p.transactionId });
      }
    } catch (e) {
      console.error('[payout poll]', e.message);
    }
  }
}
