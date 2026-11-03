// Helpers for the files a hunt writes. Specs and repro scripts import them through the workspace shim:
//
//   import { test, expect, knownBug, named } from '../bh.mjs';
//   test('R4 an employee cannot approve their own request', async ({ api, db }) => {
//     knownBug('AL-1', 'approveRequest has no role check');
//     const ben = await api('employee');
//     …
//   });
//
//   import { demo, caption, evidence, login } from '../bh.mjs';
//   demo('AL-1 employee approves own request', async ({ page, api, db }) => { … });
//
// Rules: helpers throw HelperError on a broken setup, so a setup problem never looks like a pass or a bug.
// knownBug keeps the suite green while the bug is open; BH_STRICT=1 ignores it, so the test must fail on its
// real assertion (that proves the spec reproduces the bug).
/* global document */
import { test as base, expect } from '@playwright/test';
import { copyFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { findWorkspace, loadConfig, account, slug, appendJsonl } from '../src/config.mjs';
import * as dbmod from '../src/db.mjs';

export { expect };

export class HelperError extends Error {
  constructor(message) {
    super(`[helper] ${message}`);
    this.name = 'HelperError';
  }
}

let cached;
export function config() {
  cached ??= loadConfig(findWorkspace(process.env.BH_DIR));
  return cached;
}

export const strict = () => process.env.BH_STRICT === '1';
export const runId = () => process.env.BH_RUN || 'adhoc';
// Name everything a test creates "<run>-<label>", so it is easy to find and clean up.
export const named = (label) => `${runId()}-${label}`;

export function knownBug(id, reason) {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(id)) throw new HelperError(`knownBug: "${id}" is not a bug id like AL-1`);
  base.info().annotations.push({ type: 'knownBug', description: `${id}: ${reason}` });
  if (!strict()) base.fail(true, `${id}: ${reason}`);
}

function fill(template, values) {
  return JSON.parse(JSON.stringify(template), (k, v) => (typeof v === 'string' ? v.replace(/\{(\w+)\}/g, (_, n) => values[n] ?? '') : v));
}

async function bodyOf(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// An HTTP client logged in as a role (login.api in bughunterr.json). Calls return { status, body };
// okGet/okPost/… throw unless the status is 2xx.
async function apiClient(playwright, role) {
  const cfg = config();
  const ctx = await playwright.request.newContext({ baseURL: cfg.url });
  let me = null;
  let acc = { role, user: null };
  if (role) {
    const login = cfg.login?.api;
    if (!login) throw new HelperError('bughunterr.json has no login.api section, so api(role) cannot log in');
    acc = account(cfg, role);
    const res = await ctx.fetch(login.path, { method: login.method || 'POST', data: fill(login.body, acc) });
    if (!res.ok()) throw new HelperError(`login as ${role} (${acc.user}) failed: HTTP ${res.status()}`);
    me = await bodyOf(res);
  }
  const call = async (method, path, data) => {
    let r;
    try {
      r = await ctx.fetch(path, { method, data });
    } catch (err) {
      throw new HelperError(`${method} ${path} as ${role || 'anonymous'}: ${err.message}`);
    }
    return { status: r.status(), body: await bodyOf(r) };
  };
  const ok = async (method, path, data) => {
    const r = await call(method, path, data);
    if (r.status < 200 || r.status > 299) throw new HelperError(`${method} ${path} as ${role || 'anonymous'}: expected 2xx, got ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  return {
    role, user: acc.user, me, ctx,
    get: (p) => call('GET', p), post: (p, d) => call('POST', p, d), put: (p, d) => call('PUT', p, d), patch: (p, d) => call('PATCH', p, d), delete: (p) => call('DELETE', p),
    okGet: (p) => ok('GET', p), okPost: (p, d) => ok('POST', p, d), okPut: (p, d) => ok('PUT', p, d), okPatch: (p, d) => ok('PATCH', p, d), okDelete: (p) => ok('DELETE', p),
  };
}

// Logs a page in through the UI (login.ui in bughunterr.json).
export async function login(page, role) {
  const ui = config().login?.ui;
  if (!ui) throw new HelperError('bughunterr.json has no login.ui section');
  const acc = account(config(), role);
  await page.goto(ui.path || '/');
  await page.locator(ui.user).fill(acc.user);
  await page.locator(ui.password).fill(acc.password);
  await page.locator(ui.submit).click();
  try {
    await page.locator(ui.loggedIn).filter({ hasText: /\S/ }).first().waitFor({ timeout: 10_000 });
  } catch {
    throw new HelperError(`UI login as ${role} (${acc.user}) did not finish`);
  }
  if (current) await caption(`Logged in as ${role} (${acc.user})`, { hold: 1500 });
  return acc;
}

const dbFixture = {
  read: async (sql) => {
    try {
      return dbmod.read(config(), sql);
    } catch (err) {
      throw new HelperError(`db.read: ${err.message}`);
    }
  },
  available: () => Boolean(config().db),
};

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  cfg: async ({}, use) => use(config()),
  // api('manager') → logged-in client; api() → anonymous. Several roles in one test are fine.
  api: async ({ playwright }, use) => {
    const clients = [];
    await use(async (role) => {
      const c = await apiClient(playwright, role);
      clients.push(c);
      return c;
    });
    for (const c of clients) await c.ctx.dispose();
  },
  // eslint-disable-next-line no-empty-pattern
  db: async ({}, use) => use(dbFixture),
  // eslint-disable-next-line no-empty-pattern
  track: async ({}, use) => {
    await use((entry) => {
      const dir = join(config().ws, 'sessions', runId());
      appendJsonl(join(dir, 'ledger.jsonl'), { at: new Date().toISOString(), kind: 'created', ...entry });
    });
  },
});

// ---------- captioned videos ----------

let current = null;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const STYLE = `
#bh-caption{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:80%;z-index:2147483647;
  background:rgba(17,24,39,.92);color:#fff;font:600 20px/1.35 system-ui,sans-serif;padding:12px 20px;border-radius:10px;
  box-shadow:0 6px 24px rgba(0,0,0,.3);text-align:center;transition:opacity .2s}
#bh-badge{position:fixed;bottom:34px;left:16px;z-index:2147483647;background:#b91c1c;color:#fff;font:700 13px system-ui;
  padding:4px 10px;border-radius:999px;letter-spacing:.03em}
#bh-evidence{position:fixed;top:12px;right:12px;width:360px;z-index:2147483647;background:#0f172a;color:#e2e8f0;
  font:13px/1.45 ui-monospace,Menlo,monospace;border-radius:10px;padding:12px 14px;box-shadow:0 6px 24px rgba(0,0,0,.35);
  border-left:4px solid #f59e0b}
#bh-evidence h4{margin:0 0 6px;font:700 13px system-ui;color:#fbbf24;text-transform:uppercase;letter-spacing:.05em}
#bh-evidence .k{color:#94a3b8} #bh-evidence .bad{color:#fca5a5;font-weight:700} #bh-evidence .good{color:#86efac}`;

async function paint(page) {
  if (!current) return;
  await page.evaluate(({ css, badge, text, panel }) => {
    if (!document.getElementById('bh-style')) {
      const s = document.createElement('style');
      s.id = 'bh-style';
      s.textContent = css;
      document.documentElement.appendChild(s);
    }
    const el = (id) => document.getElementById(id) || Object.assign(document.body.appendChild(document.createElement('div')), { id });
    el('bh-badge').textContent = badge;
    const c = el('bh-caption');
    c.textContent = text || '';
    c.style.opacity = text ? '1' : '0';
    const old = document.getElementById('bh-evidence');
    if (!panel) { if (old) old.remove(); return; }
    const box = el('bh-evidence');
    box.replaceChildren();
    const h = document.createElement('h4');
    h.textContent = panel.title || 'Evidence';
    box.append(h);
    for (const [k, v] of Object.entries(panel.rows || {})) {
      const line = document.createElement('div');
      const key = document.createElement('span');
      key.className = 'k';
      key.textContent = k + ': ';
      const val = document.createElement('span');
      val.textContent = typeof v === 'object' && v !== null ? String(v.value ?? JSON.stringify(v)) : String(v);
      if (v && v.bad) val.className = 'bad';
      if (v && v.good) val.className = 'good';
      line.append(key, val);
      box.append(line);
    }
  }, { css: STYLE, badge: current.badge, text: current.text, panel: current.panel }).catch(() => {});
}

// A caption at the bottom of the video, held long enough to read.
export async function caption(text, { hold } = {}) {
  if (!current) throw new HelperError('caption() used outside demo()');
  current.text = text;
  await paint(current.page);
  await pause(hold ?? Math.min(4000, 1200 + text.length * 35));
}

// The evidence panel (top right). Values may be { value, bad: true } or { value, good: true }.
export async function evidence(panel, { hold = 2500 } = {}) {
  if (!current) throw new HelperError('evidence() used outside demo()');
  current.panel = panel;
  await paint(current.page);
  await pause(hold);
}

const hasFfmpeg = () => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// demo('AL-2 weekend days are counted', async ({ page, api, db }) => { … }) → videos/AL-2-weekend-days-are-counted.webm
export function demo(name, fn) {
  const id = name.split(' ')[0];
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(id)) throw new HelperError(`demo name must start with the bug id, e.g. "AL-1 …" (got "${name}")`);
  test(name, async ({ page, api, db, track, cfg }, info) => {
    current = { page, badge: `${id} · bug`, text: '', panel: null };
    page.on('load', () => paint(page));
    try {
      await fn({ page, api, db, track, cfg });
      await caption('End of clip', { hold: 1200 });
    } finally {
      current = null;
      const video = page.video();
      await page.close();
      if (video && info.status === info.expectedStatus) {
        const dir = join(config().ws, 'videos');
        mkdirSync(dir, { recursive: true });
        const out = join(dir, `${id}-${slug(name.slice(id.length))}.webm`);
        // Playwright's webm has no duration header, so players cannot seek; ffmpeg (if installed) rewrites it.
        if (hasFfmpeg()) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', await video.path(), '-c', 'copy', out]);
        else copyFileSync(await video.path(), out);
        info.annotations.push({ type: 'video', description: out });
      }
    }
  });
}
