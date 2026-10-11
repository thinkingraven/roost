# Contributing to roost

Thanks for helping. roost is small on purpose: no runtime dependencies, no network calls, and nothing about what people typed ever leaves their machine.

## Setup

```bash
git clone https://github.com/thinkingraven/roost.git
cd roost
npm ci
npm test                       # builds, then runs the test suite
node dist/src/cli.js sources   # try it on your own machine
```

Node 20 or newer.

## Where things live

| Path | What it does |
|---|---|
| `src/cli.ts` | Commands and options |
| `src/sources.ts` | Where each agent keeps its session logs (`SOURCE_DEFS`) and finding them |
| `src/report.ts` | Terminal and JSON output, `~/…` paths |
| `src/version.ts` | Version from `package.json` |
| `test/` | `node:test` suite with synthetic fixtures |
| `docs/plan.md` | What roost will do, and what's done |

## Supporting a new agent

1. Add its log folder and session-file pattern to `SOURCE_DEFS` in `src/sources.ts`, with a comment showing the layout.
2. Add synthetic fixtures and tests: one that finds sessions and one that ignores the agent's other files.
3. Add a row to the log sources table in `docs/plan.md` and the agent to the README, with a link to its docs in the PR.

## Pull requests

- Keep changes focused; one feature per PR.
- No runtime dependencies without discussing it in an issue first.
- No real transcripts in fixtures, issues or screenshots.
