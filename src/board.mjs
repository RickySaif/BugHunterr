// Builds board/index.html: one self-contained page with every bug (video, evidence, copy-fix-prompt) and session.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { PKG, readJson, listDir, bugIds } from './config.mjs';

export function fixPrompt(bug, cfg) {
  const where = bug.where?.file
    ? `${bug.where.file}${bug.where.function ? `, function \`${bug.where.function}\`` : ''}${bug.where.line ? ` (around line ${bug.where.line})` : ''}`
    : 'not pinned down yet: start from the area and the steps below';
  const basis = bug.expected.basis === 'spec'
    ? `Requirement ${bug.expected.requirement}${bug.expected.link ? ` (${bug.expected.link})` : ''}: ${bug.expected.text}`
    : `Intended behaviour (no written spec): ${bug.expected.text}\nEvidence of intent: ${bug.expected.evidence}`;
  return [
    `Fix bug ${bug.id} in ${cfg.name}${cfg.repo ? ` (${cfg.repo})` : cfg.source ? ` (the \`${basename(cfg.source)}\` code base)` : ''}.`,
    '',
    `## The bug: ${bug.title}`,
    bug.summary,
    '',
    `Where: ${where}`,
    '',
    '## Why it is wrong',
    basis,
    `Actual: ${bug.actual}`,
    '',
    '## How it was confirmed',
    `- Response: ${bug.how.response}`,
    `- Stored state: ${bug.how.state}`,
    ...(bug.how.byDesignCheck ? [`- Not by design: ${bug.how.byDesignCheck}`] : []),
    '',
    '## Steps to reproduce',
    ...bug.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    '## The fix',
    bug.hint || 'Make the behaviour match the expectation above. Keep the change small and in the place named under "Where".',
    '',
    '## Done when',
    bug.spec
      ? `- The regression spec \`${bug.spec}\` (BugHunterr workspace) passes in strict mode: \`bughunterr verify ${bug.id}\` reports it as possibly fixed.`
      : '- A test that states the expected behaviour passes.',
    `- The app's own test suite has a test for this rule.`,
    '- No other behaviour changes.',
  ].join('\n');
}

const readIf = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);

export function buildBoard(cfg) {
  const ws = cfg.ws;
  const sessions = listDir(join(ws, 'sessions'), (d) => !d.startsWith('.') && existsSync(join(ws, 'sessions', d, 'status.json')))
    .map((d) => {
      const dir = join(ws, 'sessions', d);
      return {
        ...readJson(join(dir, 'status.json')),
        notes: readIf(join(dir, 'notes.md')),
        rules: readIf(join(dir, 'rules.md')) || readIf(join(dir, 'inferred-spec.md')),
      };
    })
    .sort((a, b) => (a.started < b.started ? 1 : -1));
  const lastVerify = sessions.find((s) => s.verify)?.verify || {};
  const bugs = bugIds(ws).map((id) => {
    const bug = readJson(join(ws, 'bugs', `${id}.json`));
    return { ...bug, proof: lastVerify[id] || null, fixPrompt: fixPrompt(bug, cfg) };
  }).sort((a, b) => Number(a.id.split('-')[1]) - Number(b.id.split('-')[1]));
  const data = { generated: new Date().toISOString(), app: cfg.name, url: cfg.url, bugs, sessions, videoBase: '../' };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const html = readFileSync(join(PKG, 'templates', 'board.html'), 'utf8').replace('/*__BOARD_DATA__*/null', json);
  writeFileSync(join(ws, 'board', 'index.html'), html);
  return { bugs: bugs.length, sessions: sessions.length, file: join(ws, 'board', 'index.html') };
}
