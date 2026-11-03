// Starting the app under test, and running the Playwright projects (specs, repro) against it.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { PKG, BhError } from './config.mjs';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

const require = createRequire(import.meta.url);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function up(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

// Starts the app with "app.start" from bughunterr.json unless something already answers on the url.
// Returns { stop, started, log }. Its output goes to `logFile`, which the agent can read (server errors).
export async function ensureApp(cfg, logFile) {
  const health = cfg.url + (cfg.app?.health || '/');
  if (await up(health)) return { started: false, stop: async () => {}, log: null };
  if (!cfg.app?.start) throw new BhError(`nothing answers on ${health}, and bughunterr.json has no "app.start" command. Start the app first.`);
  mkdirSync(dirname(logFile), { recursive: true });
  const out = createWriteStream(logFile, { flags: 'a' });
  const child = spawn(cfg.app.start, { cwd: cfg.app.cwd, shell: true, env: { ...process.env, ...(cfg.app.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const stop = async () => {
    if (child.exitCode !== null) return;
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else process.kill(-child.pid, 'SIGTERM');
    } catch { /* already gone */ }
    await pause(300);
  };
  process.on('exit', () => { try { if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
  for (let i = 0; i < 60; i++) {
    if (await up(health)) return { started: true, stop, log: logFile };
    if (child.exitCode !== null) break;
    await pause(500);
  }
  await stop();
  throw new BhError(`the app did not come up on ${health} (see ${logFile})`);
}

export function playwrightCli() {
  return join(dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
}

// Runs one Playwright project and returns a flat list of test results.
export function runPlaywright(cfg, { project, only = [], strict = false, run = 'adhoc', out, headed = false, quiet = false }) {
  mkdirSync(dirname(out), { recursive: true });
  const res = spawnSync(process.execPath, [playwrightCli(), 'test', '-c', join(PKG, 'playwright.config.mjs'), '--project', project, '--reporter', quiet ? 'json' : 'list,json'], {
    cwd: PKG,
    stdio: ['ignore', quiet ? 'ignore' : 'inherit', 'inherit'],
    env: {
      ...process.env,
      BH_DIR: cfg.ws,
      BH_RUN: run,
      BH_STRICT: strict ? '1' : '',
      BH_ONLY: only.join(','),
      BH_HEADED: headed ? '1' : '',
      PLAYWRIGHT_JSON_OUTPUT_NAME: out,
      FORCE_COLOR: '0',
    },
  });
  if (!existsSync(out)) throw new BhError(`playwright produced no results (exit ${res.status})`);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const flat = [];
  const walk = (s, path) => {
    for (const c of s.suites || []) walk(c, [...path, c.title]);
    for (const spec of s.specs || []) {
      for (const t of spec.tests) {
        const r = t.results.at(-1) || {};
        flat.push({
          file: spec.file,
          title: [...path.slice(1), spec.title].join(' › '),
          knownBug: t.annotations.find((a) => a.type === 'knownBug')?.description.split(':')[0] || null,
          outcome: t.status,
          status: r.status || 'skipped',
          error: (r.error?.message || '').replace(ANSI, ''),
        });
      }
    }
  };
  for (const s of report.suites || []) walk(s, [s.title]);
  if (!flat.length && report.errors?.length) {
    throw new BhError(`playwright could not load the files:\n${report.errors.map((e) => (e.message || '').replace(ANSI, '')).join('\n')}`);
  }
  return flat;
}
