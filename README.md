<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/roost-wordmark-bone.svg">
    <img alt="roost." src=".github/assets/roost-wordmark-ink.svg" width="220">
  </picture>
</p>

<h3 align="center">See what your AI agents actually use.<br>Keep what works. Retire the rest.</h3>

<p align="center">
  <a href="https://github.com/thinkingraven/roost/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/thinkingraven/roost/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-0F0F14">
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/license-MIT-0F0F14"></a>
</p>

<p align="center">
  Claude Code · Codex · Gemini CLI
</p>

---

Teams install skills, subagents, rules and MCP servers everywhere, and nobody knows which ones get used. Some run every day. Some load thousands of tokens into every session and are never called.

**roost** reads the session logs your agents already keep on your machine and tells you what was actually used, what it cost, and what to keep, improve or retire. It runs locally and never uploads anything.

> **Early days.** `roost usage` works for Claude Code today; Codex and Gemini CLI, context cost and verdicts are next. See the [plan](docs/plan.md).

## Try it

Not on npm yet. From a clone:

```bash
git clone https://github.com/thinkingraven/roost.git
cd roost
npm ci
npm test
node dist/src/cli.js usage
```

### `roost usage`

What your agents actually ran in the last 30 days: skills, subagents, MCP servers and your own slash commands, how often, in how many sessions and repos, with token use per repo.

```text
roost v0.0.0: what your agents actually used
Claude Code · last 30 days · 41 sessions in 5 repos · 2026-09-11 → 2026-10-10

TOKENS        612.4M in · 2.9M out
              of the input, 571.0M was cache reads and 18.2M cache writes

SKILLS        58 runs of 9 skills
  code-review      31 runs   22 sessions   4 repos
  pr-summary       14 runs   11 sessions   3 repos
  release-notes     6 runs    4 sessions   1 repo
  + 6 more (--top 9 shows them all)

SUBAGENTS     19 runs
  Explore          12 runs    8 sessions   3 repos
  general-purpose   7 runs    5 sessions   2 repos

MCP SERVERS   402 calls to 3 servers
  github     288 calls   9 tools   17 sessions   4 repos
  linear      96 calls   5 tools    9 sessions   2 repos
  sentry      18 calls   2 tools    3 sessions   1 repo

COMMANDS      23 uses of your own slash commands
  /deploy   15 uses   10 sessions   1 repo
  /triage    8 uses    6 sessions   2 repos
  Built in: /model 9 · /clear 6 · /compact 4

REPOS
  ~/code/shop   18 sessions   301.2M tokens   29 skill runs   210 MCP calls
  ~/code/api    11 sessions   164.8M tokens   17 skill runs   122 MCP calls
  + 3 more (--top 5 shows them all)

BUILT-IN TOOLS  Bash 3,912 · Edit 1,204 · Read 966 · Write 412 · Grep 380 · WebFetch 74 · …

Only names, counts and dates: no prompt or reply text. Nothing leaves this machine.
```

Sessions are grouped by repo (the nearest git root of the folder they ran in; Claude Code worktrees count as their repo). Each response's tokens are counted once, subagents included.

### `roost sources`

```text
roost v0.0.0: agent session logs on this machine

  Claude Code   ~/.claude/projects   214 sessions   2026-06-02 → 2026-10-10
  Codex         ~/.codex/sessions    38 sessions    2026-07-14 → 2026-10-09
  Gemini CLI    ~/.gemini/tmp        not found

Nothing leaves this machine.
```

| Option | Default | Description |
|---|---|---|
| `--since <30d\|YYYY-MM-DD\|all>` | `30d` | Time window for `usage` |
| `--top <n>` | `10` | Rows per section in the terminal report |
| `--format <terminal\|json>` | `terminal` | Output format; JSON has every row |
| `--home <dir>` | your home folder | Look for logs under another folder |

## Privacy

- No network calls and no telemetry.
- `roost sources` only lists file names and dates; it doesn't open your logs.
- `roost usage` reads logs only to find tool calls, skill and subagent names, slash commands, timestamps and token counts. It never prints, stores or exports the text of your prompts, the agents' replies, or tool inputs and results. Tests check this on every change.
- Reports show paths under your home folder as `~/…`.

## roost and rookery

[rookery](https://github.com/thinkingraven/rookery) shows what your agents *could* do: every skill, the duplicates and the risky ones. roost shows what they *actually did*. Together they answer which skills to share, which to merge and which to retire.

## Licence

[MIT](LICENSE) © Thinking Raven
