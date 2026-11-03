#!/usr/bin/env node
// End-to-end check without AI: the offline demo (fake agent → check → videos → strict proof → board) must produce
// three proven bugs with videos. Run: npm run test:e2e
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const demo = join(root, '.demo');
rmSync(demo, { recursive: true, force: true });
const r = spawnSync(process.execPath, [join(root, 'bin', 'bughunterr.mjs'), 'demo', '--quiet'], { stdio: 'inherit', cwd: root });
const fail = (m) => { console.error(`✖ e2e: ${m}`); process.exit(1); };
if (r.status !== 0) fail(`demo exited ${r.status}`);
const sessions = readdirSync(join(demo, 'sessions')).filter((d) => !d.startsWith('.'));
const status = JSON.parse(readFileSync(join(demo, 'sessions', sessions.at(-1), 'status.json'), 'utf8'));
if (status.status !== 'complete') fail(`status ${status.status}`);
if (status.problems.length) fail(`problems: ${status.problems.join('; ')}`);
for (const id of ['AL-1', 'AL-2', 'AL-3']) {
  const v = status.verify[id];
  if (!v || v.proven !== v.tests || !v.tests) fail(`${id} spec not proven: ${JSON.stringify(v)}`);
  const bug = JSON.parse(readFileSync(join(demo, 'bugs', `${id}.json`), 'utf8'));
  if (!bug.video || !existsSync(join(demo, bug.video))) fail(`${id} has no video`);
}
const html = readFileSync(join(demo, 'board', 'index.html'), 'utf8');
if (!html.includes('"id":"AL-3"')) fail('board misses AL-3');
console.log('✓ e2e: 3 bugs, every spec proven in strict mode, 3 videos, board built');
