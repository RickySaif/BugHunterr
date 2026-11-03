import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, cpSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PKG, loadConfig, ensureWorkspace, nextBugNumber, secret, findWorkspace, BhError } from '../src/config.mjs';
import * as db from '../src/db.mjs';
import { check } from '../src/finish.mjs';
import { buildPrompt } from '../src/prompt.mjs';
import { buildBoard, fixPrompt } from '../src/board.mjs';
import { sourceReport, dataReport, runSeed } from '../src/setup.mjs';

function workspace(extra = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'bh-'));
  const sqlite = join(ws, 'app.db');
  const d = new DatabaseSync(sqlite);
  d.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('a'), ('b'), ('c');");
  d.close();
  writeFileSync(join(ws, 'bughunterr.json'), JSON.stringify({
    name: 'Acme Leave', prefix: 'AL', url: 'http://localhost:9/', source: join(PKG, 'examples', 'acme-leave'),
    spec: join(PKG, 'examples', 'acme-leave', 'docs', 'prd.md'),
    accounts: { employee: { user: 'ben@acme.example', password: '$BH_TEST_PW' } },
    db: { engine: 'sqlite', file: 'app.db' }, ...extra,
  }));
  ensureWorkspace(ws);
  return ws;
}

function withFakeBugs(ws) {
  for (const dir of ['bugs', 'specs', 'repro']) cpSync(join(PKG, 'examples', 'fake-hunt', dir), join(ws, dir), { recursive: true });
  for (const id of ['AL-1', 'AL-2', 'AL-3']) {
    const f = join(ws, 'bugs', `${id}.json`);
    writeFileSync(f, readFileSync(f, 'utf8').replaceAll('__RUN__', 'r1').replaceAll('__TODAY__', '2026-11-03'));
  }
}

test('config: loads, resolves paths, strips the trailing slash', () => {
  const cfg = loadConfig(workspace());
  assert.equal(cfg.url, 'http://localhost:9');
  assert.equal(cfg.prefix, 'AL');
  assert.equal(cfg.spec.length, 1);
  assert.ok(cfg.db.file.endsWith('app.db'));
});

test('config: finds the workspace from a sub folder, and errors clearly without one', () => {
  const ws = workspace();
  mkdirSync(join(ws, 'bugs', 'deep'), { recursive: true });
  assert.equal(findWorkspace(join(ws, 'bugs', 'deep')), ws);
  assert.throws(() => findWorkspace(tmpdir() + '/definitely-not-a-workspace-' + Date.now()), BhError);
});

test('config: "$VAR" secrets come from the environment', () => {
  process.env.BH_TEST_PW = 's3cret';
  assert.equal(secret('$BH_TEST_PW', 'pw'), 's3cret');
  assert.equal(secret('plain', 'pw'), 'plain');
  assert.throws(() => secret('$BH_NOT_SET_ANYWHERE', 'pw'), /not set/);
});

test('bug ids: the next number follows the highest existing one', () => {
  const ws = workspace();
  assert.equal(nextBugNumber(ws, 'AL'), 1);
  withFakeBugs(ws);
  assert.equal(nextBugNumber(ws, 'AL'), 4);
});

test('db read: SELECT works, anything else is refused', () => {
  const cfg = loadConfig(workspace());
  assert.equal(db.read(cfg, 'SELECT COUNT(*) AS n FROM items').at(0).n, 3);
  assert.throws(() => db.read(cfg, 'DELETE FROM items'), db.DbSafetyError);
  assert.throws(() => db.read(cfg, 'SELECT 1; DELETE FROM items'), db.DbSafetyError);
  assert.throws(() => db.read(cfg, "WITH x AS (SELECT 1) UPDATE items SET name = 'z'"), /readonly|read-only|attempt to write/i);
});

test('db write: off by default; when on, guarded, capped and logged', () => {
  const off = loadConfig(workspace());
  assert.throws(() => db.write(off, { sql: "UPDATE items SET name = 'x' WHERE id = 1", table: 'items', ids: [1] }), /writes are off/);

  const ws = workspace({ db: { engine: 'sqlite', file: 'app.db', write: 'local' } });
  const cfg = loadConfig(ws);
  const ledger = join(ws, 'sessions', 'r1', 'ledger.jsonl');
  const after = db.write(cfg, { sql: "UPDATE items SET name = 'x' WHERE id = 1", table: 'items', ids: [1], why: 'test', ledger });
  assert.equal(after[0].name, 'x');
  assert.match(readFileSync(ledger, 'utf8'), /"before":\[\{"id":1,"name":"a"\}\]/);
  assert.throws(() => db.write(cfg, { sql: 'DROP TABLE items', table: 'items', ids: [1] }), /one INSERT, UPDATE or DELETE/);
  assert.throws(() => db.write(cfg, { sql: "UPDATE items SET name = 'y'", table: 'items', ids: [1], maxRows: 2 }), /changed 3 rows/);
  assert.equal(db.read(cfg, "SELECT COUNT(*) AS n FROM items WHERE name = 'y'")[0].n, 0, 'the over-cap write was rolled back');
  const staging = loadConfig(workspace({ environment: 'staging', db: { engine: 'sqlite', file: 'app.db', write: 'local' } }));
  assert.throws(() => db.write(staging, { sql: "UPDATE items SET name = 'x' WHERE id = 1", table: 'items', ids: [1] }), /only allows writes when "environment" is "local"/);
});

test('db write: "on" works on a shared environment, never on production; --db-write turns it on for one hunt', () => {
  const sql = { sql: "UPDATE items SET name = 'q' WHERE id = 2", table: 'items', ids: [2] };
  const staging = loadConfig(workspace({ environment: 'staging', db: { engine: 'sqlite', file: 'app.db', write: 'on' } }));
  assert.equal(db.write(staging, sql)[0].name, 'q');
  const prod = loadConfig(workspace({ environment: 'production', db: { engine: 'sqlite', file: 'app.db', write: 'on' } }));
  assert.throws(() => db.write(prod, sql), /never run on production/);
  const off = loadConfig(workspace());
  assert.equal(db.writeLevel(off), 'off');
  process.env.BH_DB_WRITE = '1';
  try {
    assert.equal(db.writeLevel(off), 'on');
    assert.equal(db.write(off, sql)[0].name, 'q');
  } finally {
    delete process.env.BH_DB_WRITE;
  }
});

test('setup: source and data reports, and the seed command', () => {
  const ws = workspace();
  const cfg = loadConfig(ws);
  assert.match(sourceReport(cfg).message, /code file\(s\) in/);
  assert.equal(sourceReport({ ...cfg, source: null }).ok, false);
  const data = dataReport(cfg);
  assert.match(data.message, /1 table\(s\), 3 row\(s\)/);
  assert.equal(data.ok, false, 'three rows is a thin seed');
  const seeded = loadConfig(workspace({ seed: { command: `node -e "require('fs').writeFileSync('seeded.txt','ok')"` } }));
  assert.equal(runSeed(seeded, join(seeded.ws, 'sessions', 'r1', 'seed.log')), true);
  assert.equal(readFileSync(join(seeded.ws, 'seeded.txt'), 'utf8'), 'ok');
  const prodSeed = loadConfig(workspace({ environment: 'prod', seed: 'true' }));
  assert.throws(() => runSeed(prodSeed, join(prodSeed.ws, 'seed.log')), /never runs on production/);
  assert.equal(runSeed(cfg, join(ws, 'seed.log')), false, 'no seed configured');
});

test('check: the fixture bugs are valid; broken ones are reported', () => {
  const ws = workspace();
  withFakeBugs(ws);
  const cfg = loadConfig(ws);
  assert.deepEqual(check(cfg), []);
  const f = join(ws, 'bugs', 'AL-2.json');
  const bug = JSON.parse(readFileSync(f, 'utf8'));
  delete bug.how;
  bug.sev = 'urgent';
  bug.expected = { text: 'x', basis: 'inferred' };
  writeFileSync(f, JSON.stringify(bug));
  const problems = check(cfg).join('\n');
  assert.match(problems, /AL-2: \(root\) must have required property 'how'/);
  assert.match(problems, /AL-2: \/sev must be equal to one of the allowed values/);
  assert.match(problems, /no expected.evidence/);
});

test('prompt: guided cites the spec; unguided asks for an inferred spec', () => {
  const cfg = loadConfig(workspace());
  const base = { run: 'r1', deadline: 'soon', nextId: 4, appLog: null, existing: [{ id: 'AL-1', title: 'x', state: 'open' }] };
  const guided = buildPrompt(cfg, { ...base, mode: 'guided' });
  assert.match(guided, /GUIDED by the spec/);
  assert.match(guided, /prd\.md/);
  assert.match(guided, /AL-4/);
  assert.match(guided, /do NOT report again: AL-1/);
  assert.doesNotMatch(guided, /\$BH_TEST_PW|s3cret/, 'env passwords are not inlined');
  const unguided = buildPrompt(cfg, { ...base, mode: 'unguided' });
  assert.match(unguided, /UNGUIDED/);
  assert.match(unguided, /inferred-spec\.md/);
  assert.match(guided, /Writes are off/);
  const writes = buildPrompt(cfg, { ...base, mode: 'guided', dbWrite: 'on', seeded: true });
  assert.match(writes, /Writes are \*\*on\*\*/);
  assert.match(writes, /reset and filled by the seed command/);
});

test('board: one self-contained page with a fix prompt per bug', () => {
  const ws = workspace();
  withFakeBugs(ws);
  const cfg = loadConfig(ws);
  const b = buildBoard(cfg);
  assert.equal(b.bugs, 3);
  const html = readFileSync(b.file, 'utf8');
  assert.match(html, /"id":"AL-1"/);
  assert.doesNotMatch(html, /__BOARD_DATA__/);
  const prompt = fixPrompt(JSON.parse(readFileSync(join(ws, 'bugs', 'AL-1.json'), 'utf8')), cfg);
  assert.match(prompt, /src\/leave\.mjs, function `approveRequest`/);
  assert.match(prompt, /Requirement R4/);
});
