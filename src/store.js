// In-memory store, persisted to Postgres when DATABASE_URL is set (else to data/db.json).
// Everything lives in one `db` object; save() writes a snapshot after each change.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { DATA_DIR, UPLOAD_DIR, config } from './config.js';

const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// A fresh wallet, pre-funded with DEMO_WALLET_USD when set (recorded as a demo credit, not a PayPal payment).
const wallet = () => ({ balance: config.demoWalletUsd, reserved: 0, currency: 'USD' });
const credits = () => (config.demoWalletUsd > 0 ? [{ at: new Date().toISOString(), amount: config.demoWalletUsd, source: 'demo-credit' }] : []);

const empty = () => ({
  agents: {
    atlas: {
      id: 'atlas',
      name: 'Atlas — travel & local concierge agent',
      wallet: wallet(),
      fundings: credits(),
    },
    external: {
      id: 'external',
      name: 'External agents (REST / MCP)',
      wallet: wallet(),
      fundings: credits(),
    },
  },
  bounties: [],
  submissions: [],
  missions: [],
  payouts: [],
  events: [],
});

function loadFile() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return empty();
  }
}

// ---------------------------------------------------------------- Postgres

const usePg = !!config.databaseUrl;
export const storage = usePg ? 'postgres' : 'file';
const NS = config.dbNamespace; // 'live' on Render, 'local' elsewhere: local runs never overwrite the live site
let pool = null;

/** Connect, create tables and load the saved state. Call once before serving requests. */
export async function initStore() {
  if (!usePg) return;
  // sslmode=require already means full certificate checks in pg; say so explicitly to silence its warning.
  const connectionString = config.databaseUrl.replace(/sslmode=(require|prefer|verify-ca)\b/, 'sslmode=verify-full');
  pool = new pg.Pool({ connectionString, max: 4 });
  pool.on('error', (e) => console.error('[db] idle client error:', e.message));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gt_state (ns text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS gt_uploads (ns text NOT NULL, name text NOT NULL, mime text NOT NULL, data bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (ns, name));`);
  const { rows } = await pool.query('SELECT data FROM gt_state WHERE ns = $1', [NS]);
  replaceDb(rows[0]?.data || empty());
  if (!rows.length) await writeSnapshot();
}

function replaceDb(next) {
  for (const k of Object.keys(db)) delete db[k];
  Object.assign(db, next);
}

const writeSnapshot = () =>
  pool.query(
    `INSERT INTO gt_state (ns, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (ns) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [NS, JSON.stringify(db)],
  );

// Writes are chained so they never overlap; each one sends the latest state.
let chain = Promise.resolve();
function persist() {
  if (!usePg) {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
    return;
  }
  if (!pool) return; // not initialised (e.g. unit tests)
  chain = chain.then(writeSnapshot).catch((e) => console.error('[db] save failed:', e.message));
}

export const db = usePg ? empty() : loadFile();
export const bus = new EventEmitter(); // live updates -> SSE
bus.setMaxListeners(100);

let timer = null;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(persist, 50);
}

/** Write any pending change now (used on shutdown so a redeploy never loses the last seconds). */
export async function flushStore() {
  clearTimeout(timer);
  persist();
  await chain;
  await pool?.end();
}

// ---------------------------------------------------------------- photos

export async function putUpload(name, buffer, mime = 'image/jpeg') {
  if (!usePg) return fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  await pool.query(
    `INSERT INTO gt_uploads (ns, name, mime, data) VALUES ($1, $2, $3, $4)
     ON CONFLICT (ns, name) DO UPDATE SET data = EXCLUDED.data, mime = EXCLUDED.mime`,
    [NS, name, mime, buffer],
  );
}

/** @returns {Promise<{mime: string, data: Buffer} | null>} */
export async function getUpload(name) {
  if (!usePg) {
    const f = path.join(UPLOAD_DIR, path.basename(name));
    return fs.existsSync(f) ? { mime: 'image/jpeg', data: fs.readFileSync(f) } : null;
  }
  const { rows } = await pool.query('SELECT mime, data FROM gt_uploads WHERE ns = $1 AND name = $2', [NS, name]);
  return rows[0] || null;
}

// ---------------------------------------------------------------- helpers

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
  replaceDb(empty());
  if (usePg) pool.query('DELETE FROM gt_uploads WHERE ns = $1', [NS]).catch((e) => console.error('[db] reset uploads:', e.message));
  else for (const f of fs.readdirSync(UPLOAD_DIR)) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });
  save();
}

export const getAgent = (agentId) => db.agents[agentId];
export const getBounty = (bountyId) => db.bounties.find((b) => b.id === bountyId);
export const getSubmission = (subId) => db.submissions.find((s) => s.id === subId);
export const getMission = (mId) => db.missions.find((m) => m.id === mId);
