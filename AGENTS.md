# AGENTS.md

Guidance for coding agents working on roost.

## Commands

- `npm ci`: install
- `npm test`: build (TypeScript to `dist/`) and run the `node:test` suite. Run it after every change.
- `node dist/src/cli.js sources`: run the CLI from source

## Ground rules

- roost must never make network calls or execute anything it reads.
- Privacy is the product. Read session logs only to find tool calls; never print, store or export prompt or response text. Reports carry names, counts, token numbers and dates only, with home-folder paths shown as `~/…`.
- No runtime dependencies. Use Node built-ins (`node:fs`, `node:util` `parseArgs`, `node:test`).
- ESM with NodeNext resolution: import local files with a `.js` extension.
- Every log format gets synthetic fixtures in `test/`. Never commit real transcripts, even trimmed ones.
- Unknown log shapes are counted and reported, never guessed at.
- The plan and status live in [docs/plan.md](docs/plan.md); keep its status column current.

## Map

See the table in [CONTRIBUTING.md](CONTRIBUTING.md#where-things-live).

## Brand

Copy, colours and type follow the Thinking Raven brand: https://thinkingraven.github.io/brand/ (DESIGN.md and AGENTS.md there). Write "roost." in lowercase with an amber full stop in visuals and "roost" in prose. The wordmark in `.github/assets/` comes from the brand repo (`logos/final/roost-wordmark-*.svg`); copy it again rather than editing it.

## Public repository rules

This repository will be public. Follow the organisation rules in https://github.com/thinkingraven/.github/blob/main/PUBLIC-REPOS.md from the start: no secrets, no employer or client material, no personal data, demo data only in screenshots and examples.
