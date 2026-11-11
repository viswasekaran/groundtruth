// Shared helpers for all pages.
export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
export const ago = (iso) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};
export const until = (iso) => {
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (s <= 0) return 'expired';
  if (s < 3600) return `${Math.ceil(s / 60)} min left`;
  return `${Math.round(s / 3600)} h left`;
};
export const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || 'POST';
    init.headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data, status: res.status });
  return data;
}

export function toast(msg, ms = 3500) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

const NAV = [
  ['/', 'Live map'],
  ['/agent.html', 'Agent console'],
  ['/hunter.html', 'Earn'],
  ['/developers.html', 'For agents'],
];

export async function topbar() {
  const bar = document.createElement('header');
  bar.className = 'topbar';
  const here = location.pathname === '/index.html' ? '/' : location.pathname;
  bar.innerHTML = `
    <a class="logo" href="/"><svg width="24" height="24" viewBox="0 0 28 28" fill="none" aria-hidden="true"><rect x="1" y="1" width="26" height="26" rx="7" fill="#18181B"/><circle cx="14" cy="14" r="6" stroke="#FAFAFA" stroke-width="2"/><path d="M14 4v5M14 19v5M4 14h5M19 14h5" stroke="#FAFAFA" stroke-width="2" stroke-linecap="round"/><circle cx="14" cy="14" r="2" fill="#3D5AFE"/></svg>GroundTruth</a>
    <div class="modes" id="modes"></div>
    <nav>${NAV.map(([h, l]) => `<a href="${h}" class="${h === here ? 'active' : ''}">${l}</a>`).join('')}</nav>`;
  document.body.prepend(bar);
  try {
    const s = await api('/api/status');
    $('#modes', bar).innerHTML =
      `<span class="pill ${s.paypal.mode === 'mock' ? 'mock' : 'live'}" title="PayPal mode">PayPal ${s.paypal.mode}</span>` +
      `<span class="pill ${s.ai.mode === 'mock' ? 'mock' : 'live'}" title="${esc(s.ai.model)}">Claude ${s.ai.mode}</span>`;
    return s;
  } catch {
    return null;
  }
}

/** Subscribe to live server events (SSE). */
export function live(onEvent) {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {}
  };
  return es;
}

export function describeEvent(ev) {
  switch (ev.type) {
    case 'bounty.posted': return `Agent posted <b>${esc(ev.title)}</b> for ${usd(ev.rewardUsd)}`;
    case 'submission.received': return `Live photo submitted for <b>${esc(ev.title)}</b>`;
    case 'submission.verified': return `Verification: <b>${esc(ev.decision.replace('_', ' '))}</b> · ${esc(ev.title)}`;
    case 'bounty.resolved': return `Verified answer: “${esc(ev.answer)}”`;
    case 'payout.sent': return `PayPal payout sent: ${usd(ev.amountUsd)}${ev.mock ? ' (mock)' : ''}`;
    case 'payout.status': return `Payout status: <b>${esc(ev.status)}</b>`;
    case 'payout.failed': return `Payout failed: ${esc(ev.error)}`;
    case 'wallet.funded': return `Agent wallet funded with PayPal: ${usd(ev.amount)}${ev.mock ? ' (mock)' : ''}`;
    case 'bounty.expired': return `Bounty expired, ${usd(ev.rewardUsd)} returned to wallet`;
    case 'bounty.cancelled': return `Bounty cancelled, ${usd(ev.rewardUsd)} returned to wallet`;
    case 'submission.rejected': return `Reviewer rejected a submission`;
    case 'mission.started': return `New agent mission: ${esc(ev.goal.slice(0, 80))}`;
    default: return null;
  }
}

export function leafletMap(el, center = [37.7749, -122.4194], zoom = 13) {
  const map = L.map(el).setView(center, zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  return map;
}

export function getPosition(opts = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.message || 'Location permission denied')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0, ...opts },
    );
  });
}
