// The deterministic part after the agent: check the bug files, prove the specs, record the videos.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { PKG, readJson, writeJson, listDir, bugIds, slug } from './config.mjs';
import { runPlaywright } from './runner.mjs';

let validator;
function validate(bug) {
  validator ??= new Ajv2020({ allErrors: true, strict: false }).compile(readJson(join(PKG, 'schemas', 'bug.schema.json')));
  return validator(bug) ? [] : validator.errors.map((e) => `${e.instancePath || '(root)'} ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(', ')})` : ''}`);
}

// Checks every bug file against the schema and the files it points to. Returns a list of problems.
export function check(cfg, ids = bugIds(cfg.ws)) {
  const problems = [];
  for (const id of ids) {
    const file = join(cfg.ws, 'bugs', `${id}.json`);
    let bug;
    try {
      bug = readJson(file);
    } catch (err) {
      problems.push(`${id}: not valid JSON (${err.message})`);
      continue;
    }
    for (const p of validate(bug)) problems.push(`${id}: ${p}`);
    if (bug.id !== id) problems.push(`${id}: "id" is ${bug.id}, but the file is ${id}.json`);
    if (bug.expected?.basis === 'spec' && !bug.expected.requirement) problems.push(`${id}: expected.basis is "spec" but there is no expected.requirement`);
    if (bug.expected?.basis === 'inferred' && !bug.expected.evidence) problems.push(`${id}: expected.basis is "inferred" but there is no expected.evidence`);
    for (const k of ['spec', 'repro']) {
      if (bug[k] && !existsSync(join(cfg.ws, bug[k]))) problems.push(`${id}: ${k} file ${bug[k]} does not exist`);
    }
    if (bug.spec && existsSync(join(cfg.ws, bug.spec)) && !readFileSync(join(cfg.ws, bug.spec), 'utf8').includes(`knownBug('${id}'`) && bug.state === 'open') {
      problems.push(`${id}: ${bug.spec} has no knownBug('${id}', …) marker`);
    }
    if (bug.where?.file && cfg.source && !existsSync(join(cfg.source, bug.where.file))) problems.push(`${id}: where.file ${bug.where.file} is not in the source folder`);
  }
  return problems;
}

// Runs the specs twice. Normal mode: everything green (knownBug tests are expected to fail). Strict mode
// (BH_STRICT=1): each knownBug test must fail on its real assertion. Returns { tests, perBug, problems }.
export function verify(cfg, { only = [], run = 'adhoc', outDir, quiet = false }) {
  const specFiles = listDir(join(cfg.ws, 'specs'), (f) => f.endsWith('.spec.mjs'));
  if (!specFiles.length) return { tests: [], perBug: {}, problems: [] };
  const names = only.length ? only : [];
  const normal = runPlaywright(cfg, { project: 'specs', only: names, run, out: join(outDir, 'specs-normal.json'), quiet });
  const strictRes = runPlaywright(cfg, { project: 'specs', only: names, run, strict: true, out: join(outDir, 'specs-strict.json'), quiet });
  const problems = [];
  const perBug = {};
  const key = (t) => `${t.file} › ${t.title}`;
  const strictBy = new Map(strictRes.map((t) => [key(t), t]));
  const tests = normal.map((t) => {
    const s = strictBy.get(key(t)) || {};
    let result;
    if (t.knownBug) {
      if (t.status === 'passed') result = 'possibly-fixed';
      else if (s.status === 'passed') result = 'does-not-reproduce';
      else if (/\[helper\]/.test(s.error) || !/expect\(/.test(s.error)) result = 'setup-error';
      else result = 'known-bug-open';
    } else result = t.outcome === 'expected' ? 'passed' : t.outcome === 'skipped' ? 'skipped' : 'failed';
    if (t.knownBug) {
      const b = (perBug[t.knownBug] ??= { tests: 0, proven: 0, results: [] });
      b.tests++;
      if (result === 'known-bug-open') b.proven++;
      b.results.push(result);
    }
    if (result === 'possibly-fixed') problems.push(`${key(t)} passed although it is marked knownBug('${t.knownBug}'): the bug may be fixed, or the test does not reproduce it`);
    if (result === 'does-not-reproduce') problems.push(`${key(t)}: passes in strict mode, so it does not reproduce ${t.knownBug}`);
    if (result === 'setup-error') problems.push(`${key(t)}: fails on a setup or helper error, not on its assertion: ${(s.error || '').split('\n')[0]}`);
    if (result === 'failed') problems.push(`${key(t)} failed and has no knownBug marker: ${t.error.split('\n')[0]}`);
    return { ...t, result, strictError: s.error?.split('\n')[0] || '' };
  });
  return { tests, perBug, problems };
}

// Records the captioned video of each bug that has a repro script, and writes the path into the bug file.
export function record(cfg, { only = [], run = 'adhoc', outDir, headed = false, quiet = false }) {
  const ids = (only.length ? only : bugIds(cfg.ws)).filter((id) => existsSync(join(cfg.ws, 'repro', `${id}.repro.mjs`)));
  if (!ids.length) return { recorded: [], failed: [] };
  const results = runPlaywright(cfg, { project: 'repro', only: ids, run, out: join(outDir, 'repro.json'), headed, quiet });
  const recorded = [];
  const failed = [];
  for (const id of ids) {
    // demo() registers the test from lib/bh.mjs, so match on the title, which starts with the bug id.
    const t = results.find((r) => r.file.endsWith(`${id}.repro.mjs`) || r.title.split(' › ').at(-1).startsWith(`${id} `));
    const video = listDir(join(cfg.ws, 'videos'), (f) => f.startsWith(`${id}-`) && f.endsWith('.webm')).at(0);
    if (t?.status === 'passed' && video) {
      const file = join(cfg.ws, 'bugs', `${id}.json`);
      if (existsSync(file)) {
        const bug = readJson(file);
        bug.video = `videos/${video}`;
        bug.repro = `repro/${id}.repro.mjs`;
        writeJson(file, bug);
      }
      recorded.push(id);
    } else failed.push(`${id}: ${t ? t.error.split('\n')[0] || t.status : 'repro did not run'}`);
  }
  return { recorded, failed };
}

export { slug };
