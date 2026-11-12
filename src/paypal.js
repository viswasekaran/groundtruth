// PayPal REST integration: Orders v2 (wallet funding) + Payouts v1 (paying hunters).
// Falls back to a clearly-labelled MOCK when sandbox keys are not configured.
import crypto from 'node:crypto';
import { config, paypalMock } from './config.js';

const BASE = config.paypal.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

let cachedToken = null; // { token, expiresAt }

async function accessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.token;
  const basic = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new PayPalError('OAuth token request failed', res.status, await safeJson(res));
  const json = await res.json();
  cachedToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.token;
}

export class PayPalError extends Error {
  constructor(message, status, details) {
    super(`${message} (HTTP ${status})`);
    this.status = status;
    this.details = details;
  }
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function call(method, path, body, { requestId } = {}) {
  const token = await accessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (requestId) headers['PayPal-Request-Id'] = requestId; // idempotency
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await safeJson(res);
  if (!res.ok) {
    let msg = json?.message || json?.name || 'PayPal API error';
    if (/country that is not allowed/i.test(msg))
      msg += ' Hint: the PayPal app belongs to a sandbox business account in a country without Payouts (e.g. India). Create a US sandbox business account, create the REST app under it, and use the client ID and secret of that app.';
    throw new PayPalError(`${method} ${path}: ${msg}`, res.status, json);
  }
  return json;
}

const money = (n) => Number(n).toFixed(2);

// ---------------------------------------------------------------- Orders (funding)

export async function createOrder(amountUsd, description = 'GroundTruth agent wallet top-up') {
  if (paypalMock) return { id: `MOCK-ORDER-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, status: 'CREATED', mock: true };
  return call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [
      {
        description,
        amount: { currency_code: 'USD', value: money(amountUsd) },
      },
    ],
    application_context: { brand_name: 'GroundTruth', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' },
  });
}

/** Captures an approved order. Returns { orderId, captureId, amount, payerEmail, status }. */
export async function captureOrder(orderId, mockAmountUsd) {
  if (paypalMock) {
    return {
      orderId,
      captureId: `MOCK-CAP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      amount: Number(mockAmountUsd || 0),
      payerEmail: 'mock-buyer@example.com',
      status: 'COMPLETED',
      mock: true,
    };
  }
  const json = await call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, undefined, {
    requestId: `cap-${orderId}`,
  });
  const capture = json.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    orderId: json.id,
    captureId: capture?.id,
    amount: Number(capture?.amount?.value || 0),
    payerEmail: json.payer?.email_address,
    status: json.status,
  };
}

// ---------------------------------------------------------------- Payouts (paying hunters)

const mockPayouts = new Map(); // batchId -> { createdAt }

/** Sends one payout. Returns { batchId, status }. */
export async function createPayout({ receiverEmail, amountUsd, note, senderItemId }) {
  const senderBatchId = `gt_${senderItemId}`; // stable -> PayPal rejects duplicates, so no double-pay
  if (paypalMock) {
    const batchId = `MOCK-BATCH-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    mockPayouts.set(batchId, { createdAt: Date.now() });
    return { batchId, status: 'PENDING', senderBatchId, mock: true };
  }
  const json = await call('POST', '/v1/payments/payouts', {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: 'You earned a GroundTruth bounty!',
      email_message: 'Thanks for verifying the real world. Your reward is here.',
    },
    items: [
      {
        recipient_type: 'EMAIL',
        amount: { value: money(amountUsd), currency: 'USD' },
        receiver: receiverEmail,
        note: note?.slice(0, 4000) || 'GroundTruth bounty reward',
        sender_item_id: senderItemId,
      },
    ],
  });
  return { batchId: json.batch_header.payout_batch_id, status: json.batch_header.batch_status, senderBatchId };
}

/** Returns { batchStatus, itemStatus, transactionId }. */
export async function getPayout(batchId) {
  if (paypalMock) {
    const p = mockPayouts.get(batchId);
    const done = !p || Date.now() - p.createdAt > 2500;
    return {
      batchStatus: done ? 'SUCCESS' : 'PROCESSING',
      itemStatus: done ? 'SUCCESS' : 'PENDING',
      transactionId: done ? `MOCK-TXN-${batchId.slice(-8)}` : null,
      mock: true,
    };
  }
  const json = await call('GET', `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
  const item = json.items?.[0];
  return {
    batchStatus: json.batch_header?.batch_status,
    itemStatus: item?.transaction_status,
    transactionId: item?.transaction_id,
  };
}

export const paypalInfo = () => ({
  mode: paypalMock ? 'mock' : config.paypal.env,
  clientId: paypalMock ? null : config.paypal.clientId,
});
