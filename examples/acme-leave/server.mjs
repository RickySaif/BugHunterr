#!/usr/bin/env node
// Acme Leave: a tiny, fictional leave-request app used by the BugHunterr demo.
// No dependencies. Run: node server.mjs [--reset]
//   PORT                 default 4310
//   ACME_DB              SQLite file, default ./data/acme-leave.db
//   ACME_TODAY           fixed "today" (YYYY-MM-DD) so the example is repeatable
//   ACME_DEMO_PASSWORD   password of the seeded demo users, default acme-demo
//   ACME_VERSION         the commit this copy was built from, shown at /version
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDb, checkPassword } from './src/db.mjs';
import * as leave from './src/leave.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4310);
const DB_FILE = process.env.ACME_DB || join(here, 'data', 'acme-leave.db');
const DEMO_PASSWORD = process.env.ACME_DEMO_PASSWORD || 'acme-demo';
const db = openDb(DB_FILE, { reset: process.argv.includes('--reset'), demoPassword: DEMO_PASSWORD });
const sessions = new Map();

const today = () => process.env.ACME_TODAY || new Date().toISOString().slice(0, 10);
const now = () => `${today()}T${new Date().toISOString().slice(11, 19)}Z`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new leave.HttpError(400, 'body must be JSON');
  }
}

function currentUser(req) {
  const sid = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  const userId = sid && sessions.get(sid);
  return userId ? db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(userId) : null;
}

const routes = [
  ['GET', /^\/health$/, () => ({ ok: true })],
  ['GET', /^\/version$/, () => ({ app: 'acme-leave', sha: process.env.ACME_VERSION || 'unknown', today: today() })],
  ['POST', /^\/api\/login$/, async (req, res) => {
    const { email, password } = await readBody(req);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
    if (!user || !checkPassword(String(password || ''), user.password_hash)) throw new leave.HttpError(401, 'wrong e-mail or password');
    const sid = randomBytes(16).toString('hex');
    sessions.set(sid, user.id);
    res.setHeader('set-cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/`);
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }, { public: true }],
  ['POST', /^\/api\/logout$/, (req, res) => {
    res.setHeader('set-cookie', 'sid=; Max-Age=0; Path=/');
    return { ok: true };
  }],
  ['GET', /^\/api\/me$/, (req, res, user) => ({ ...user, today: today() })],
  ['GET', /^\/api\/balance$/, (req, res, user, url) => leave.balance(db, user.id, url.searchParams.get('year') || today().slice(0, 4))],
  ['GET', /^\/api\/requests$/, (req, res, user) => leave.listOwn(db, user.id)],
  ['GET', /^\/api\/team\/requests$/, (req, res, user) => leave.listTeam(db, user)],
  ['POST', /^\/api\/requests$/, async (req, res, user) => {
    res.statusCode = 201;
    return leave.createRequest(db, user, await readBody(req), now());
  }],
  ['POST', /^\/api\/requests\/(\d+)\/approve$/, (req, res, user, url, m) => leave.approveRequest(db, user, Number(m[1]), now())],
  ['POST', /^\/api\/requests\/(\d+)\/reject$/, (req, res, user, url, m) => leave.rejectRequest(db, user, Number(m[1]), now())],
  ['POST', /^\/api\/requests\/(\d+)\/cancel$/, (req, res, user, url, m) => leave.cancelRequest(db, user, Number(m[1]), now())],
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    for (const [method, pattern, handler, opts = {}] of routes) {
      const m = url.pathname.match(pattern);
      if (!m || req.method !== method) continue;
      const user = currentUser(req);
      if (!user && !opts.public && url.pathname.startsWith('/api/')) throw new leave.HttpError(401, 'log in first');
      const body = await handler(req, res, user, url, m);
      return send(res, res.statusCode, body);
    }
    if (req.method === 'GET') {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (/^[a-z0-9-]+\.(html|js|css)$/.test(file)) {
        res.writeHead(200, { 'content-type': TYPES[extname(file)] });
        return res.end(readFileSync(join(here, 'public', file)));
      }
    }
    throw new leave.HttpError(404, 'not found');
  } catch (err) {
    if (err instanceof leave.HttpError) return send(res, err.status, { error: err.message });
    if (err.code === 'ENOENT') return send(res, 404, { error: 'not found' });
    console.error(err);
    return send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => console.log(`Acme Leave on http://localhost:${PORT} (db ${DB_FILE}, today ${today()})`));
