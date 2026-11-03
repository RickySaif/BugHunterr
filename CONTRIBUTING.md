# Contributing

- Node 22.13+. `npm install && npx playwright install chromium`.
- Before a pull request: `npm run check` (lint, unit tests, offline e2e).
- Code: plain ES modules, no build step, no new runtime dependencies without a reason.
- The demo app (`examples/acme-leave`) keeps its three seeded bugs on purpose. Do not fix them.
- Never commit real credentials or personal data. Test accounts in examples are fictional.
