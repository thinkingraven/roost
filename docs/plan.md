# roost: plan

> rookery shows what your agents *could* do. roost shows what they *actually did*.

Odin's raven Huginn flies out each day and comes back at night, to roost, with what it learned. roost does the same for a team's AI agents: it reads the session logs agents already keep on each machine and comes back with what was actually used, what it cost, and what to keep, improve or retire.

## The problem

Teams install skills, subagents, rules files and MCP servers in every repo and every tool. [rookery](https://github.com/thinkingraven/rookery) shows what exists, where the duplicates are and which ones are risky. Nobody can see what's *used*:

- Which of the four code-review skills does anyone actually run?
- Which MCP servers load their tool definitions into every session but are never called?
- How many tokens do agents spend on instructions before anyone types a word?
- When a skill gets a v2, do people use it more, or less?

## What roost does

| Step | What | Status |
|---|---|---|
| 1. Sources | Find each agent's session logs on the machine | Done (`roost sources`) |
| 2. Usage | Count skills, slash commands, subagents and MCP tools actually invoked, per repo and per agent, with token use | Done for Claude Code, Codex and Gemini CLI (`roost usage`) |
| 3. Context tax | Tokens loaded before the first prompt: instruction files, rules, skill descriptions, MCP tool definitions; what each one costs per session | |
| 4. Verdicts | Join usage with rookery's JSON inventory: **keep**, **improve**, **merge** (duplicate clusters, with the copy that wins) or **retire** (installed, never used), with the tokens each change saves | Done for Claude Code, Codex and Gemini CLI (`roost verdicts`, rookery 0.7.2+ for exact repo matching); token savings and the retire/merge PR next |
| 5. Team | Each developer exports a summary (counts and names only); `roost merge` combines them into one team report | Started with `roost export`: daily counts to the company's OpenTelemetry backend, plus a Grafana dashboard (0.3.0); a file-based `roost merge` and pipeline (software factory) runs next |
| 6. Reports | Terminal, JSON, Markdown and a self-contained HTML page, in rookery's style; a retire/merge PR instead of just a chart | |

## Decisions: rookery's policy log

`rookery hook <agent>` checks every tool call against a repo's `.rookery.yml` while an agent works, and appends each deny or warn to `<rookery home>/decisions/YYYY-MM-DD.jsonl` (`~/.rookery` by default, or `ROOKERY_HOME`). Two things read it:

- `roost export` turns it into `rookery.policy` rows for a company's dashboards (0.3.0).
- `roost decisions` (0.4.0) is the local, no-setup view: denies and warnings by rule, agent and repo, with no OTLP config needed.

Both share nothing but the log format: `roost export`'s reader (`src/export/rows.ts`) stays lenient and OTLP-row-shaped on purpose; `roost decisions` (`src/decisions.ts`) is its own small reader, built for a human report.

## Log sources

All local files; roost never asks an agent or a service for anything.

| Agent | Where | Format |
|---|---|---|
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` (subagents nested under the session) | JSON Lines: messages with `tool_use` entries (`Skill`, `Agent`, `mcp__<server>__<tool>`) and per-message token `usage` |
| Codex | `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` | JSON Lines rollout events |
| Gemini CLI | `~/.gemini/tmp/<project-hash>/chats/session-*.json` | JSON chat records |
| Cursor, Copilot | Later: editor storage (SQLite / VS Code workspace storage) | |

Formats change without notice, so every parser is tested against synthetic fixtures for each known version, and unknown shapes are counted and reported rather than guessed at.

## Privacy model

- Runs locally. No network calls, no telemetry.
- Reads prompts and responses only to find tool calls; never prints, stores or exports their text.
- Reports carry names (skills, tools, servers), counts, token numbers and dates. Paths under the home folder are shown as `~/…`.
- Team summaries are counts-only JSON files that people choose to share; repo paths in them can be hashed.

## Not doing

- Spend dashboards by day or model: [ccusage](https://github.com/ryoppippi/ccusage) does that well.
- Anything hosted. The future registry can read roost's JSON, but roost stays a local CLI.

## Prior art and how roost differs

- **[toktop](https://github.com/toktop/toktop)** finds installed-but-unused skills and MCP servers in Claude Code and Codex logs, for one person.
- **[ccusage](https://github.com/ryoppippi/ccusage)** reports token spend per day, month and session.
- **[tokenscope](https://github.com/wartzar-bee/tokenscope)** attributes Claude Code token cost and re-sent context.

roost's edge is what only Thinking Raven has: usage joined with rookery's inventory and duplicate clusters, team-level summaries that never carry content, and verdicts that end in a pull request.

## Name

A roost is where ravens return at night. Product name: "roost." in visuals (wordmark from the brand repo), "roost" in prose.
