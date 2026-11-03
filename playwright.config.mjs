// One Playwright config for every workspace. bughunterr sets BH_DIR to the workspace before it runs this.
//   project "specs"  → <workspace>/specs/*.spec.mjs   (regression specs with knownBug)
//   project "repro"  → <workspace>/repro/*.repro.mjs  (captioned videos, recorded headless)
import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { findWorkspace, loadConfig } from './src/config.mjs';

const cfg = loadConfig(findWorkspace(process.env.BH_DIR));
const only = process.env.BH_ONLY ? new RegExp(`(^|/)(${process.env.BH_ONLY.split(',').join('|')})\\.`) : null;

export default defineConfig({
  outputDir: join(cfg.ws, 'sessions', '.playwright'),
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'list',
  use: { baseURL: cfg.url, headless: process.env.BH_HEADED !== '1', trace: 'off' },
  projects: [
    { name: 'specs', testDir: join(cfg.ws, 'specs'), testMatch: only || /.*\.spec\.mjs$/ },
    {
      name: 'repro',
      testDir: join(cfg.ws, 'repro'),
      testMatch: only || /.*\.repro\.mjs$/,
      timeout: 180_000,
      use: { viewport: { width: 1100, height: 640 }, video: { mode: 'on', size: { width: 1100, height: 640 } } },
    },
  ],
});
