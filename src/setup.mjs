// What a hunt needs besides the running app: the source code, seed data and working test accounts.
// Used by "bughunterr doctor" (to report) and "bughunterr hunt" (to seed before starting).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { BhError, account } from './config.mjs';
import * as db from './db.mjs';

const CODE = /\.(m?[jt]sx?|py|rb|php|go|java|kt|cs|rs|vue|svelte|sql|html)$/;

// Counts code files (skipping dependencies and build output), and reads the git commit if there is one.
export function sourceReport(cfg) {
  if (!cfg.source) return { ok: false, message: 'no "source" in bughunterr.json: the agent cannot read the code, so bugs will have no "where" and unguided hunts lose their best evidence' };
  if (!existsSync(cfg.source)) return { ok: false, message: `source folder not found: ${cfg.source}` };
  let files = 0;
  const walk = (d, depth) => {
    if (depth > 8 || files > 5000) return;
    for (const f of readdirSync(d)) {
      if (/^(node_modules|\.git|dist|build|vendor|\.next|coverage|__pycache__)$/.test(f)) continue;
      const p = join(d, f);
      const s = statSync(p, { throwIfNoEntry: false });
      if (s?.isDirectory()) walk(p, depth + 1);
      else if (CODE.test(f)) files++;
    }
  };
  walk(cfg.source, 0);
  const git = spawnSync('git', ['-C', cfg.source, 'log', '-1', '--format=%h %cs %s'], { encoding: 'utf8' });
  const commit = git.status === 0 ? git.stdout.trim() : null;
  if (!files) return { ok: false, message: `source folder has no code files: ${cfg.source}` };
  return { ok: true, message: `source: ${files} code file(s) in ${cfg.source}${commit ? ` (commit ${commit})` : ' (not a git checkout: the version tested is not recorded)'}` };
}

// Tables and row counts, so a thin seed is visible before an agent wastes its time box on empty screens.
export function dataReport(cfg) {
  if (!cfg.db) return { ok: false, tables: [], message: 'no "db" in bughunterr.json: the agent confirms stored state through the API only' };
  let rows;
  try {
    if (cfg.db.engine === 'sqlite') {
      const names = db.read(cfg, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
      rows = names.map((name) => ({ table: name, rows: Number(db.read(cfg, `SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`)[0].n) }));
    } else if (cfg.db.engine === 'postgres') {
      rows = db.read(cfg, 'SELECT relname AS "table", n_live_tup AS rows FROM pg_stat_user_tables ORDER BY relname').map((r) => ({ table: r.table, rows: Number(r.rows) }));
    } else {
      rows = db.read(cfg, 'SELECT table_name AS `table`, table_rows AS `rows` FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name').map((r) => ({ table: r.table, rows: Number(r.rows) }));
    }
  } catch (err) {
    return { ok: false, tables: [], message: `database: ${err.message.split('\n')[0]}` };
  }
  const empty = rows.filter((r) => r.rows === 0).map((r) => r.table);
  const total = rows.reduce((n, r) => n + r.rows, 0);
  const thin = !rows.length || total < 10 || empty.length > rows.length / 2;
  const message = `database: ${rows.length} table(s), ${total} row(s)${empty.length ? `; empty: ${empty.join(', ')}` : ''}`;
  return { ok: !thin, tables: rows, message: thin ? `${message}. The seed looks thin: add data for every role and state (see README, "Before you hunt")` : message };
}

// Logs in once per role through login.api. Needs the app running.
export async function loginReport(cfg) {
  const roles = Object.keys(cfg.accounts || {});
  if (!roles.length) return [{ ok: false, message: 'no "accounts": the agent can only explore as an anonymous visitor' }];
  const api = cfg.login?.api;
  if (!api) return [{ ok: false, message: 'no "login.api": logins are not checked, and specs cannot use api(role)' }];
  const out = [];
  for (const role of roles) {
    let acc;
    try {
      acc = account(cfg, role);
    } catch (err) {
      out.push({ ok: false, message: `account ${role}: ${err.message}` });
      continue;
    }
    const body = JSON.parse(JSON.stringify(api.body), (k, v) => (typeof v === 'string' ? v.replace(/\{(\w+)\}/g, (_, n) => acc[n] ?? '') : v));
    try {
      const res = await fetch(cfg.url + api.path, { method: api.method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      out.push({ ok: res.ok, message: `account ${role} (${acc.user}): login ${res.ok ? 'works' : `failed, HTTP ${res.status}. Is this user in the seed?`}` });
    } catch (err) {
      out.push({ ok: false, message: `account ${role}: ${err.message}` });
    }
  }
  return out;
}

// Runs "seed" from bughunterr.json (a command that resets and fills the test database), before the app starts.
export function runSeed(cfg, logFile) {
  const seed = typeof cfg.seed === 'string' ? { command: cfg.seed } : cfg.seed;
  if (!seed?.command) return false;
  if (db.isProd(cfg.environment)) throw new BhError(`"seed" never runs on production (environment "${cfg.environment}")`);
  mkdirSync(dirname(logFile), { recursive: true });
  const res = spawnSync(seed.command, { cwd: seed.cwd ? join(cfg.ws, seed.cwd) : cfg.app?.cwd || cfg.ws, shell: true, encoding: 'utf8', env: { ...process.env, ...(cfg.app?.env || {}), ...(seed.env || {}) }, timeout: 5 * 60_000 });
  appendFileSync(logFile, `$ ${seed.command}\n${res.stdout || ''}${res.stderr || ''}\n`);
  if (res.status !== 0) throw new BhError(`seed command failed (exit ${res.status}): ${seed.command}. Output in ${logFile}`);
  return true;
}
