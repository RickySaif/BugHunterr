// Runs the hunting agent: Claude Code (claude -p) or Codex (codex exec), each with the Playwright MCP browser,
// read access to the source, the shell, and the db command. "fake" replays a recorded hunt, for tests and demos.
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, writeFileSync, mkdirSync, cpSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { PKG, BhError } from './config.mjs';

const require = createRequire(import.meta.url);

function mcpServer(sessionDir, { headed }) {
  const pkgFile = require.resolve('@playwright/mcp/package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
  const args = [join(dirname(pkgFile), bin), '--browser', 'chromium', '--isolated', '--output-dir', join(sessionDir, 'browser'), '--viewport-size', '1280,800'];
  if (!headed) args.push('--headless');
  return { command: process.execPath, args };
}

export function which(bin) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Short, human progress lines from the agent's JSON event stream.
function claudeProgress(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev.type === 'assistant') {
    const out = [];
    for (const c of ev.message?.content || []) {
      if (c.type === 'tool_use') {
        const i = c.input || {};
        const what = i.command || i.file_path || i.url || i.pattern || i.element || i.description || '';
        out.push(`  · ${c.name.replace('mcp__playwright__', 'browser.')} ${String(what).split('\n')[0].slice(0, 110)}`);
      } else if (c.type === 'text' && c.text.trim()) out.push(`  ${c.text.trim().split('\n')[0].slice(0, 140)}`);
    }
    return out.join('\n') || null;
  }
  if (ev.type === 'result') return `  agent finished: ${ev.subtype}${ev.total_cost_usd ? `, $${ev.total_cost_usd.toFixed(2)}` : ''}${ev.num_turns ? `, ${ev.num_turns} turns` : ''}`;
  return null;
}

function codexProgress(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  const item = ev.item || ev.msg || {};
  if (ev.type === 'item.started' || ev.type === 'item.completed') {
    if (item.type === 'command_execution' && ev.type === 'item.started') return `  · shell ${String(item.command).slice(0, 110)}`;
    if (item.type === 'mcp_tool_call' && ev.type === 'item.started') return `  · browser.${item.tool} ${JSON.stringify(item.arguments || {}).slice(0, 100)}`;
    if (item.type === 'agent_message' && ev.type === 'item.completed') return `  ${String(item.text).split('\n')[0].slice(0, 140)}`;
    if (item.type === 'file_change' && ev.type === 'item.completed') return `  · wrote ${(item.changes || []).map((c) => c.path.split('/').pop()).join(', ')}`;
  }
  if (ev.type === 'turn.completed') return '  agent finished';
  return null;
}

function stream(child, logFile, progress, quiet) {
  const log = createWriteStream(logFile, { flags: 'a' });
  let buf = '';
  child.stdout.on('data', (d) => {
    log.write(d);
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const p = progress(line);
      if (p && !quiet) console.log(p);
    }
  });
  child.stderr.on('data', (d) => log.write(d));
  return log;
}

export async function runAgent(cfg, { agent, prompt, sessionDir, run, minutes, model, headed, yolo, quiet }) {
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'prompt.md'), prompt);
  const logFile = join(sessionDir, 'agent.log');
  const mcp = mcpServer(sessionDir, { headed });
  const env = { ...process.env, BH_DIR: cfg.ws, BH_RUN: run };
  let child;

  if (agent === 'fake') return fakeAgent(cfg, { run, sessionDir });

  if (agent === 'claude') {
    if (!which(process.env.CLAUDE_BIN || 'claude')) throw new BhError('Claude Code is not installed (https://code.claude.com). Or use --agent codex.');
    const mcpFile = join(sessionDir, 'mcp.json');
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { playwright: mcp } }, null, 2));
    const src = cfg.source ? `/${cfg.source}/**` : null; // "//abs/path" in permission rules is an absolute path
    const args = ['-p', 'Start the bug hunt now. Your full brief is in the system prompt above; follow it to the end.',
      '--append-system-prompt', prompt,
      '--output-format', 'stream-json', '--verbose',
      '--mcp-config', mcpFile, '--strict-mcp-config',
      ...(cfg.source ? ['--add-dir', cfg.source] : []),
      ...(model ? ['--model', model] : [])];
    if (yolo) args.push('--dangerously-skip-permissions');
    else {
      args.push('--permission-mode', 'acceptEdits',
        '--allowedTools', 'Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'TodoWrite', 'mcp__playwright',
        '--disallowedTools', 'Bash(git push:*)', 'Bash(rm -rf:*)', 'WebFetch', 'WebSearch',
        ...(src ? [`Edit(${src})`, `Write(${src})`] : []));
    }
    child = spawn(process.env.CLAUDE_BIN || 'claude', args, { cwd: cfg.ws, env, stdio: ['ignore', 'pipe', 'pipe'] });
    stream(child, logFile, claudeProgress, quiet);
  } else if (agent === 'codex') {
    if (!which(process.env.CODEX_BIN || 'codex')) throw new BhError('Codex is not installed (npm i -g @openai/codex). Or use --agent claude.');
    const toml = (v) => JSON.stringify(v);
    const args = ['exec', '--skip-git-repo-check', '--json', '-C', cfg.ws,
      '-o', join(sessionDir, 'agent-last-message.md'),
      '-c', `mcp_servers.playwright.command=${toml(mcp.command)}`,
      '-c', `mcp_servers.playwright.args=[${mcp.args.map(toml).join(',')}]`,
      '-c', 'mcp_servers.playwright.startup_timeout_sec=60',
      ...(model ? ['-m', model] : [])];
    if (yolo) args.push('--dangerously-bypass-approvals-and-sandbox');
    // workspace-write: writes only in the workspace (the source stays read-only); the network is needed to reach the app.
    else args.push('-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '-c', 'approval_policy="never"');
    args.push('-');
    child = spawn(process.env.CODEX_BIN || 'codex', args, { cwd: cfg.ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(prompt);
    stream(child, logFile, codexProgress, quiet);
  } else throw new BhError(`unknown agent "${agent}" (claude, codex or fake)`);

  // Hard stop: the time box plus 10 minutes to finish the deliverables.
  const limit = (minutes + 10) * 60_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, limit);
  const code = await new Promise((res) => child.on('close', res));
  clearTimeout(timer);
  return { code, timedOut, logFile };
}

// Replays examples/fake-hunt: what an agent would write for the demo app. No AI, no network beyond the app.
function fakeAgent(cfg, { run, sessionDir }) {
  const src = join(PKG, 'examples', 'fake-hunt');
  for (const dir of ['bugs', 'specs', 'repro']) cpSync(join(src, dir), join(cfg.ws, dir), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  for (const f of readdirSync(join(cfg.ws, 'bugs')).filter((x) => x.endsWith('.json'))) {
    const file = join(cfg.ws, 'bugs', f);
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('__RUN__', run).replaceAll('__TODAY__', today));
  }
  for (const f of ['notes.md', 'rules.md', 'summary.json']) {
    writeFileSync(join(sessionDir, f), readFileSync(join(src, 'session', f), 'utf8').replaceAll('__RUN__', run));
  }
  writeFileSync(join(sessionDir, 'agent.log'), 'fake agent: replayed examples/fake-hunt\n');
  return { code: 0, timedOut: false, logFile: join(sessionDir, 'agent.log') };
}
