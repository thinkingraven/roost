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
| `src/sources.ts` | Where each agent keeps its session logs (`SOURCE_DEFS`), finding them, `walkFiles` |
| `src/usage/claude-code.ts` | Reads Claude Code logs into per-session usage; repo resolution; built-in commands |
| `src/usage/codex.ts` | Reads Codex rollouts: tool calls, MCP (from end events), skills (`<skill>` blocks), subagents, tokens; forks and subagent threads |
| `src/usage/gemini.ts` | Reads Gemini CLI sessions (`.json` and `.jsonl`), subagent transcripts and `logs.json`; project roots |
| `src/usage/agents.ts` | The agents roost reads: names, readers, built-in commands and subagents |
| `src/export/*` | `roost export`: settings (`config.ts`), repo and person ids (`identity.ts`), daily rows (`rows.ts`), OTLP JSON (`otlp.ts`), the one network call and the sent-days record (`send.ts`), the command (`run.ts`) |
| `scripts/gen-grafana-dashboard.mjs` | Generates `dashboards/grafana/roost.json` (`npm run dashboard`); a test checks every field it queries is one export sends |
| `src/usage/aggregate.ts` | Totals across sessions: skills, subagents, MCP servers, commands, tools, repos |
| `src/usage/types.ts` | `SessionUsage` (names, counts, dates, tokens only, plus `preload`: the first top-level turn's usage) and name cleaning |
| `src/verdicts.ts` | `roost verdicts`: reads rookery's JSON report and judges each Claude Code skill, command and subagent against the sessions |
| `src/fix.ts` | `roost verdicts --fix`: turns retire/merge verdicts into a plan of files to remove, grouped by repo. Pure — no filesystem or git calls |
| `src/fix-apply.ts` | `roost verdicts --fix --write`: the only place roost runs `git` — one branch per repo, `git rm` the planned files, commit. Never pushes, never calls `gh` |
| `src/decisions.ts` | `roost decisions`: reads rookery's runtime-hook log (`<rookery home>/decisions/*.jsonl`) and groups denies/warnings by rule, agent and repo |
| `src/context.ts` | `roost context`: groups each session's `preload` by agent and repo, with a per-repo trend and the heaviest sessions |
| `src/report/*` | Terminal and JSON output for `sources`, `usage`, `verdicts`, `decisions`, `context` and `fix`; colours (`style.ts`), `~/…` paths and number formatting |
| `scripts/demo-home.mjs` | Writes a made-up "acme" team's logs, in each agent's real layout, for screenshots and trying roost |
| `src/version.ts` | Version from `package.json` |
| `test/` | `node:test` suite with synthetic fixtures |
| `docs/plan.md` | What roost will do, and what's done |

## Supporting a new agent

1. Add its log folder and session-file pattern to `SOURCE_DEFS` in `src/sources.ts`, with a comment showing the layout.
2. Add a reader in `src/usage/` that turns its logs into `SessionUsage` objects, keeping names, counts, dates and tokens only.
3. Add synthetic fixtures and tests: sessions found, other files ignored, usage counted, and no message text in any output (see `test/usage.test.ts`).
4. Add a row to the log sources table in `docs/plan.md` and the agent to the README, with a link to its docs in the PR.

## Demo data and screenshots

`node scripts/demo-home.mjs /tmp/acme` writes 41 Claude Code sessions (plus a few Codex and Gemini CLI ones) for a fictional team, dated September to October 2026, so run it with `--since all`. `test/demo.test.ts` checks roost recovers its exact totals.

The images in `.github/assets/` are rendered from `FORCE_COLOR=1 node dist/src/cli.js usage --home /tmp/acme --top 5`, in the same frame as rookery's (transparent background, 2360 px wide, 13 px Space Mono). Screenshots and examples only ever use the demo team, never real logs.

## Pull requests

- Keep changes focused; one feature per PR.
- No runtime dependencies without discussing it in an issue first.
- No real transcripts in fixtures, issues or screenshots.
