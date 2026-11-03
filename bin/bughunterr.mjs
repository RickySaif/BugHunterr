#!/usr/bin/env node
// BugHunterr: exploratory testing by an AI agent (Claude Code or Codex) with a real browser, the source code,
// the database and the shell. Guided by a spec (PRD) or unguided. Run "bughunterr help".
import { parseArgs } from 'node:util';
import { existsSync, writeFileSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import { join, resolve, relative, extname, sep } from 'node:path';
import { createServer } from 'node:http';
import {
  PKG, CONFIG_FILE, BhError, findWorkspace, loadConfig, ensureWorkspace, writeJson, readJson, bugIds, nextBugNumber, runIdNow,
} from '../src/config.mjs';
import * as db from '../src/db.mjs';
import { ensureApp } from '../src/runner.mjs';
import { check, verify, record } from '../src/finish.mjs';
import { buildBoard } from '../src/board.mjs';
import { buildPrompt } from '../src/prompt.mjs';
import { runAgent, which } from '../src/agent.mjs';

const HELP = `BugHunterr: an AI agent hunts bugs in your web app and proves each one.

  bughunterr init [dir] --url <url> [--source <path>] [--spec <prd.md>] [--name <app>] [--prefix <AB>]
      Create a workspace (bughunterr.json + folders). Edit bughunterr.json for accounts, login and database.

  bughunterr hunt [--agent claude|codex|fake] [--unguided] [--focus "<area or risk>"] [--minutes 20]
                  [--model <m>] [--headed] [--yolo]
      Start the app if needed, let the agent hunt, then check, record videos, prove specs, build the board.
      Guided when bughunterr.json has "spec" (a PRD); --unguided ignores it and infers intent from code and UI.

  bughunterr check   [ID…]            validate bug files
  bughunterr verify  [ID…] [--run r]  prove regression specs (green normally, red in strict mode)
  bughunterr record  [ID…] [--run r]  record captioned videos from repro scripts
  bughunterr board                    rebuild board/index.html
  bughunterr serve   [--port 4800]    serve the board
  bughunterr db "<SELECT …>"          read-only query (JSON out)
  bughunterr db --write --table t --ids 1,2 --why "…" --run r "<UPDATE …>"   guarded local write
  bughunterr doctor                   check the tools
  bughunterr demo                     offline demo: fake agent against the bundled Acme Leave app

  Common: --dir <workspace>  (default: the folder with bughunterr.json, here or above)`;

const { values: opt, positionals: pos } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string' }, url: { type: 'string' }, source: { type: 'string' }, spec: { type: 'string' }, name: { type: 'string' },
    prefix: { type: 'string' }, agent: { type: 'string', default: 'claude' }, unguided: { type: 'boolean' }, focus: { type: 'string' },
    minutes: { type: 'string' }, model: { type: 'string' }, headed: { type: 'boolean' }, yolo: { type: 'boolean' }, run: { type: 'string' },
    port: { type: 'string' }, write: { type: 'boolean' }, table: { type: 'string' }, ids: { type: 'string' }, why: { type: 'string' },
    quiet: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
});
const [command = 'help', ...rest] = pos;
const ws = () => findWorkspace(opt.dir);
const cfg = () => loadConfig(ws());
const say = (s) => console.log(s);

async function withApp(c, run, fn) {
  const app = await ensureApp(c, join(c.ws, 'sessions', run, 'app.log'));
  try {
    return await fn();
  } finally {
    await app.stop();
  }
}

function printProblems(problems) {
  for (const p of problems) console.error(`  ✖ ${p}`);
}

const commands = {
  help: () => say(HELP),

  init: () => {
    const dir = resolve(rest[0] || opt.dir || '.');
    if (existsSync(join(dir, CONFIG_FILE))) throw new BhError(`${join(dir, CONFIG_FILE)} already exists`);
    if (!opt.url) throw new BhError('init needs --url (where the app runs, e.g. http://localhost:3000)');
    mkdirSync(dir, { recursive: true });
    const r = (p) => (p ? relative(dir, resolve(p)) || '.' : undefined);
    const config = {
      name: opt.name || 'My app',
      prefix: opt.prefix || undefined,
      url: opt.url,
      source: r(opt.source),
      spec: r(opt.spec),
      environment: 'local',
      minutes: 20,
      accounts: { user: { user: 'test-user@example.com', password: '$APP_TEST_PASSWORD' } },
      login: {
        api: { method: 'POST', path: '/api/login', body: { email: '{user}', password: '{password}' } },
        ui: { path: '/', user: 'input[type=email]', password: 'input[type=password]', submit: 'button[type=submit]', loggedIn: '[data-testid=who]' },
      },
      db: null,
      app: null,
    };
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config, null, 2) + '\n');
    ensureWorkspace(dir);
    writeFileSync(join(dir, '.gitignore'), 'bh.mjs\nsessions/.playwright/\nsessions/*/browser/\n');
    say(`Workspace ready: ${dir}\nNext: edit ${CONFIG_FILE} (accounts, login, "db", "app.start"), then run: bughunterr hunt`);
  },

  hunt: async () => {
    const c = cfg();
    ensureWorkspace(c.ws);
    const mode = c.spec.length && !opt.unguided ? 'guided' : 'unguided';
    for (const s of mode === 'guided' ? c.spec : []) if (!existsSync(s)) throw new BhError(`spec not found: ${s}`);
    const run = opt.run || runIdNow(mode);
    const minutes = Number(opt.minutes || c.minutes);
    const sessionDir = join(c.ws, 'sessions', run);
    const before = new Set(bugIds(c.ws));
    const existing = [...before].map((id) => readJson(join(c.ws, 'bugs', `${id}.json`))).map((b) => ({ id: b.id, title: b.title, state: b.state }));
    const started = new Date();
    const deadline = new Date(started.getTime() + minutes * 60_000);
    const status = { run, mode, agent: opt.agent, focus: opt.focus || null, minutes, started: started.toISOString(), status: 'running', url: c.url };
    writeJson(join(sessionDir, 'status.json'), status);
    say(`BugHunterr · ${c.name} · ${mode} · agent ${opt.agent} · ${minutes} min · session ${run}`);

    const app = await ensureApp(c, join(sessionDir, 'app.log'));
    if (app.started) say(`  app started (${c.url}), output → ${relative(c.ws, app.log)}`);
    let result;
    try {
      const prompt = buildPrompt(c, {
        run, mode, deadline: deadline.toLocaleString(), nextId: nextBugNumber(c.ws, c.prefix), focus: opt.focus,
        appLog: app.log ? join(sessionDir, 'app.log') : null, existing,
      });
      say('  hunting… (live log: ' + relative(c.ws, join(sessionDir, 'agent.log')) + ')');
      result = await runAgent(c, { agent: opt.agent, prompt, sessionDir, run, minutes, model: opt.model, headed: opt.headed, yolo: opt.yolo, quiet: opt.quiet });

      say('\nFinishing: check → videos → prove specs → board');
      const newBugs = bugIds(c.ws).filter((id) => !before.has(id));
      const problems = check(c);
      const needVideo = bugIds(c.ws).filter((id) => {
        const b = readJson(join(c.ws, 'bugs', `${id}.json`));
        return !b.video || !existsSync(join(c.ws, b.video)) || newBugs.includes(id);
      });
      const rec = record(c, { only: needVideo, run, outDir: sessionDir, quiet: true });
      problems.push(...rec.failed.map((f) => `video ${f}`));
      const ver = verify(c, { run, outDir: sessionDir, quiet: true });
      problems.push(...ver.problems);
      const summaryFile = join(sessionDir, 'summary.json');
      const summary = existsSync(summaryFile) ? (() => { try { return readJson(summaryFile); } catch { return {}; } })() : {};
      Object.assign(status, {
        status: result.code === 0 && !result.timedOut ? 'complete' : result.timedOut ? 'timed-out' : 'agent-error',
        finished: new Date().toISOString(),
        minutesUsed: Math.round((Date.now() - started.getTime()) / 6000) / 10,
        newBugs,
        possiblyFixed: Object.entries(ver.perBug).filter(([, v]) => v.results.includes('possibly-fixed')).map(([id]) => id),
        explored: summary.explored || [], notExplored: summary.notExplored || [], suspicions: summary.suspicions || [],
        videos: rec.recorded,
        verify: ver.perBug,
        problems,
      });
      writeJson(join(sessionDir, 'status.json'), status);
      const board = buildBoard(c);
      say(`\n${status.status === 'complete' ? '✓' : '!'} Hunt ${status.status}: ${newBugs.length} new bug(s) ${newBugs.join(', ')}`);
      for (const id of newBugs) {
        const b = readJson(join(c.ws, 'bugs', `${id}.json`));
        const p = ver.perBug[id];
        say(`  ${id} [${b.sev}] ${b.title}  · spec ${p ? (p.proven === p.tests ? 'proven' : 'NOT proven') : 'missing'} · video ${b.video ? 'yes' : 'no'}`);
      }
      if (problems.length) { say(`  ${problems.length} problem(s):`); printProblems(problems); }
      say(`  Board: ${board.file}`);
    } catch (err) {
      Object.assign(status, { status: 'error', finished: new Date().toISOString(), problems: [err.message] });
      writeJson(join(sessionDir, 'status.json'), status);
      throw err;
    } finally {
      await app.stop();
    }
    if (result.code !== 0 && opt.agent !== 'fake') process.exitCode = 1;
  },

  check: () => {
    const c = cfg();
    const problems = check(c, rest.length ? rest : undefined);
    if (problems.length) { printProblems(problems); process.exitCode = 1; } else say(`✓ ${rest.length ? rest.join(', ') : bugIds(c.ws).length + ' bug file(s)'} valid`);
  },

  verify: async () => {
    const c = cfg();
    const run = opt.run || 'adhoc';
    const res = await withApp(c, run, () => verify(c, { only: rest, run, outDir: join(c.ws, 'sessions', run, 'verify') }));
    for (const [id, v] of Object.entries(res.perBug)) say(`  ${id}: ${v.proven}/${v.tests} knownBug test(s) proven (${[...new Set(v.results)].join(', ')})`);
    if (!res.tests.length) say('  no specs found' + (rest.length ? ` for ${rest.join(', ')}` : ''));
    if (res.problems.length) { printProblems(res.problems); process.exitCode = 1; } else if (res.tests.length) say(`✓ ${res.tests.length} test(s): green normally, every knownBug test fails on its assertion in strict mode`);
  },

  record: async () => {
    const c = cfg();
    const run = opt.run || 'adhoc';
    const res = await withApp(c, run, () => record(c, { only: rest, run, outDir: join(c.ws, 'sessions', run, 'record'), headed: opt.headed }));
    if (res.recorded.length) say(`✓ recorded ${res.recorded.join(', ')} → videos/`);
    buildBoard(c);
    if (res.failed.length) { printProblems(res.failed); process.exitCode = 1; }
    if (!res.recorded.length && !res.failed.length) say('  no repro scripts found');
  },

  board: () => {
    const b = buildBoard(cfg());
    say(`board: ${b.bugs} bug(s), ${b.sessions} session(s) → ${b.file}`);
  },

  serve: () => {
    const c = cfg();
    const port = Number(opt.port || process.env.PORT || 4800);
    const types = { '.html': 'text/html; charset=utf-8', '.webm': 'video/webm', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.mjs': 'text/javascript' };
    createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path === '/') {
        buildBoard(c);
        res.writeHead(302, { location: '/board/index.html' });
        return res.end();
      }
      const file = resolve(c.ws, '.' + path);
      if (!file.startsWith(c.ws + sep) || !existsSync(file) || !statSync(file).isFile() || /bughunterr\.json$/.test(file)) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
      createReadStream(file).pipe(res);
    }).listen(port, '127.0.0.1', () => say(`BugHunterr board for ${c.name}: http://localhost:${port}/`));
    return new Promise(() => {});
  },

  db: () => {
    const c = cfg();
    const sql = rest.join(' ');
    if (!sql) throw new BhError('db needs a SQL statement in quotes');
    const rows = opt.write
      ? db.write(c, { sql, table: opt.table, ids: (opt.ids || '').split(',').filter(Boolean).map((x) => (/^\d+$/.test(x) ? Number(x) : x)), why: opt.why, ledger: join(c.ws, 'sessions', opt.run || 'adhoc', 'ledger.jsonl') })
      : db.read(c, sql);
    say(JSON.stringify(rows, null, 2));
  },

  doctor: async () => {
    const ok = (b, s, fix) => say(`${b ? '✓' : '✖'} ${s}${b || !fix ? '' : `  → ${fix}`}`);
    const [maj, min] = process.versions.node.split('.').map(Number);
    ok(maj > 22 || (maj === 22 && min >= 13), `Node ${process.versions.node} (needs 22.13+)`, 'install Node 22.13 or newer');
    ok(which('claude'), 'Claude Code (claude)', 'https://code.claude.com, then run "claude" once to sign in');
    ok(which('codex'), 'Codex (codex), optional', 'npm i -g @openai/codex');
    let browser = false;
    try {
      const { chromium } = await import('@playwright/test');
      browser = existsSync(chromium.executablePath());
    } catch { /* not installed */ }
    ok(browser, 'Playwright Chromium', 'npx playwright install chromium');
    ok(which('ffmpeg'), 'ffmpeg, optional (seekable videos)', 'brew install ffmpeg');
    try {
      const c = cfg();
      ok(true, `workspace ${c.ws} (${c.name}, ${c.spec.length ? 'guided' : 'unguided'})`);
      for (const s of c.spec) ok(existsSync(s), `spec ${s}`);
      if (c.source) ok(existsSync(c.source), `source ${c.source}`);
    } catch (err) {
      say(`· no workspace here (${err.message.split('.')[0]})`);
    }
  },

  demo: async () => {
    const dir = join(PKG, '.demo');
    mkdirSync(dir, { recursive: true });
    const config = readJson(join(PKG, 'examples', 'workspace', CONFIG_FILE));
    config.source = '../examples/acme-leave';
    config.spec = '../examples/acme-leave/docs/prd.md';
    config.db.file = 'acme-leave.db';
    config.app = { ...config.app, cwd: '.', env: { ...config.app.env, ACME_DB: 'acme-leave.db', PORT: '4311' }, start: 'node ../examples/acme-leave/server.mjs --reset' };
    config.url = 'http://localhost:4311';
    writeJson(join(dir, CONFIG_FILE), config);
    opt.dir = dir;
    opt.agent = 'fake';
    opt.minutes ??= '1';
    await commands.hunt();
    say('\nOpen the board: ' + join(dir, 'board', 'index.html'));
  },
};

try {
  if (opt.help) commands.help();
  else if (!commands[command]) throw new BhError(`unknown command "${command}". Run "bughunterr help".`);
  else await commands[command]();
} catch (err) {
  if (err instanceof BhError) {
    console.error(`bughunterr: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
