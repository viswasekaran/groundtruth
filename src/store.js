// Tiny JSON-file store. Good enough for a hackathon demo; swap for Postgres later.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DATA_DIR, UPLOAD_DIR } from './config.js';

const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const empty = () => ({
  agents: {
    atlas: {
      id: 'atlas',
      name: 'Atlas — travel & local concierge agent',
      wallet: { balance: 0, reserved: 0, currency: 'USD' },
      fundings: [],
    },
    external: {
      id: 'external',
      name: 'External agents (REST / MCP)',
      wallet: { balance: 0, reserved: 0, currency: 'USD' },
      fundings: [],
    },
  },
  bounties: [],
  submissions: [],
  missions: [],
  payouts: [],
  events: [],
});

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return empty();
  }
}

export const db = load();
export const bus = new EventEmitter(); // live updates -> SSE
bus.setMaxListeners(100);

let timer = null;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 50);
}

export const id = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
export const round2 = (n) => Math.round(n * 100) / 100;

/** Append to the public activity feed and push to live listeners. */
export function emit(type, data) {
  const ev = { id: id('ev'), type, at: new Date().toISOString(), ...data };
  db.events.push(ev);
  if (db.events.length > 500) db.events.splice(0, db.events.length - 500);
  save();
  bus.emit('event', ev);
  return ev;
}

export function resetDb() {
  const fresh = empty();
  for (const k of Object.keys(db)) delete db[k];
  Object.assign(db, fresh);
  for (const f of fs.readdirSync(UPLOAD_DIR)) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });
  save();
}

export const getAgent = (agentId) => db.agents[agentId];
export const getBounty = (bountyId) => db.bounties.find((b) => b.id === bountyId);
export const getSubmission = (subId) => db.submissions.find((s) => s.id === subId);
export const getMission = (mId) => db.missions.find((m) => m.id === mId);
