# Changelog

All notable changes to roost are listed here. This project follows [semantic versioning](https://semver.org).

## 0.7.0 — 2026-10-16

- **`roost merge <file...>`: team summaries with no server at all.** Combines several people's `roost export --format json` files into one team report — no OpenTelemetry backend, no Grafana, just files shared however your team already shares files.
  - Sums `roost export`'s own counts across people: sessions and tokens by agent, skills/subagents/commands/MCP servers team-wide (with how many people used each), and `rookery.policy` denials and warnings by rule.
  - When any file exported with `--rookery`, team-wide verdicts too: `uses` and `scope_sessions` summed across the team, the verdict recomputed from the totals (a quality finding's count is taken once, not added per person, since it's the same static rookery finding for everyone).
  - Needs at least 2 files. Same-named items in different repos are never conflated — `ROOST_REPO` keeps the same anonymity tradeoff it already has in `roost export`.
  - `--format json` gives the same report as data; `--top` controls how many rows each section shows.

## 0.6.0 — 2026-10-16

- **`roost verdicts` reports the tokens each retire or merge verdict would save**, via rookery 0.8.0's `preloadTokens`: what that skill, subagent or rules file costs every session it's installed in, not just when it runs.
  - Shown per item (`saves 310 tokens/session`), totalled per verdict section, and totalled for the whole report.
  - `--fix` carries the same numbers into its preview and its per-repo total; `--write`'s commit message says what it saved.
  - Optional, same as context attribution: a rookery scan from before 0.8.0 has no `preloadTokens`, and everything works exactly as before, just without the numbers.

## 0.5.0 — 2026-10-16

- **`roost context --rookery <file>`**: attributes part of a repo's average preload to specific skills, subagents and rules files, via rookery 0.8.0's `preloadTokens` field (name + description for a skill or subagent; the whole file for anything always-on). Optional — `roost context` works exactly as before without it.
  - Still not attributed: MCP servers. Their tool-definition schemas aren't visible in a static config file, so `mcp-config` is deliberately left out rather than reported against the wrong number.
  - `--rookery` only ever read from an explicit `--rookery <file>` (or `-` for stdin); unlike `roost verdicts`, `roost context` doesn't assume a pipe is meant for it, since it's fully useful without one.
- **`roost verdicts --fix`**: turns retire and merge verdicts into a plan — the files to remove, one group per repo, with why (never used in N sessions, or a duplicate of the copy that's used). `--write` applies it: one branch per repo (`roost/retire-skills-<date>`), `git rm` the files, one commit.
  - **Never pushes, never calls `gh` or any hosting API.** The only command that writes to a repo, and the only place roost shells out to anything — `git`, locally. Pushing and opening the pull request stays a manual step.
  - A repo with uncommitted changes is skipped, not committed into. A file already gone (removed by hand, or a stale rookery scan) is skipped by name, not an error. A branch name collision gets `-2`, `-3`, and so on.
  - Personal skills (`~/.claude/skills/…`) have no repo to branch from, so they're counted and left alone.
- **`roost pipeline`: pipeline mode, for agents running headless in CI.** Call it once, at the end of a job: it reads whichever session is newest under `--home` (an ephemeral runner has exactly one), and reports the job's cost, the skills it ran and the outcome you pass in (`--outcome merged|failed|retried`, `--pr`, `--job` — defaults to `GITHUB_RUN_ID`/`CI_JOB_ID`/`BUILD_ID` if you don't set one).
  - Shares `roost export`'s config, identity and OTLP code: `--send` posts through the exact same opt-in (`ROOST_EXPORT=on`), the same settings, the same one network call. `--format json` and `--format otlp` work the same way.
  - Sends the ordinary `roost.activity`/`roost.skill_used`/etc. rows for that one session, plus one new `roost.run` row (job, outcome, tokens, skills, MCP calls) for cost-per-merged-change and success-rate dashboards.
  - It can't know a PR's outcome before you do — that's on whichever CI step calls it, not roost.
- **Grafana dashboard:** a new "Factory runs" section — runs, success rate, cost per merged change, runs per day by outcome, runs by repo.

## 0.4.0 — 2026-10-16

- **`roost decisions`**: a readable report of what rookery's runtime hook (`rookery hook`) denied or warned about — by rule, agent and repo, with one example subject per rule. `roost export` already turns the same log into `rookery.policy` rows for a dashboard; this is the local, no-setup view of it. `--since`, `--top`, `--format json`.
  - Reads `<rookery home>/decisions/YYYY-MM-DD.jsonl` (`~/.rookery` by default, or `ROOKERY_HOME`, matching `roost export`). Says so plainly when the folder doesn't exist yet, or when the window has nothing logged.
  - rookery's hook agent and kind names are read as plain strings, not a fixed list, so a future agent or kind still shows up instead of being dropped.
- **`roost context`: context tax.** Each session now carries `preload`: the usage of its first top-level turn (never a subagent's) — the system prompt, instructions, skill descriptions and MCP tool definitions, all sent before anyone types a real prompt. `roost context` reports the average, a trend per repo (growing, steady or shrinking, comparing its earliest and latest measured sessions), and the heaviest sessions overall. `--since`, `--top`, `--format json`.
  - Measured directly from each agent's own usage field — Claude Code's first `cache_creation_input_tokens`/`cache_read_input_tokens`, Codex's first `token_count`/`token_usage_record` (whichever the session's totals already prefer), Gemini CLI's first `tokens` object by timestamp (not file order) — never a guess.
  - Does **not** attribute the cost to a specific skill, rules file or MCP server: rookery's own per-artifact token count is the wrong unit for that today (a skill's whole file, when only its description preloads; an MCP server's config, not its tool-definition schemas). The report says so.

## 0.3.0 — 2026-10-15

- **`roost export`: daily, counts-only summaries for your dashboards.** Sent as OpenTelemetry logs (OTLP/HTTP JSON) to Grafana Cloud, Loki, OpenObserve or any OpenTelemetry Collector.
  - **Events:**
    - `roost.activity`: sessions and tokens per day × agent × repo;
    - `roost.skill_used`, `roost.subagent_used`, `roost.command_used`, `roost.mcp_used`;
    - `rookery.policy`, from rookery's hook log;
    - `roost.verdict`, with `--rookery`.
  - **Identity:** each row has a team, a salted hashed person id, the repo as `host/org/repo` (credentials dropped), and a stable row id.
  - **Settings:** the standard `OTEL_EXPORTER_OTLP_*` and `OTEL_RESOURCE_ATTRIBUTES` variables, plus `ROOST_EXPORT`, `ROOST_TEAM`, `ROOST_PERSON`, `ROOST_PERSON_SALT` and `ROOST_REPO`.
  - **Preview by default:** `--format json` lists every row and `--format otlp` prints the exact payload.
  - **`--send`:** needs `ROOST_EXPORT=on` (or `--endpoint`). It sends finished UTC days not sent yet, at most 7 days back by default, and records them in `~/.roost/export-state.json`.
  - **One stream per person** (`service.instance.id`), so a late send from one machine is never rejected for being older than another's data.
- **Starter Grafana dashboard:** `dashboards/grafana/roost.json`, generated by `scripts/gen-grafana-dashboard.mjs`.
  - Sections: adoption, cost, skills that work, safety, and team-wide verdicts (retire: nobody used it; fix first: used, with issues).
  - Queries checked against Loki 3.7, and the dashboard against Grafana 13.2.
- **Counts by day:** the Claude Code, Codex and Gemini CLI readers can split each session by UTC day (`byDay`, `until`). A session that runs past midnight, or is resumed, counts on each day once.
- **The network rule:** roost still makes no network calls except `roost export --send`, to the endpoint you configure.
- **Demo:** `scripts/demo-home.mjs <dir> [seed]` makes more made-up teammates.

## 0.2.0 — 2026-10-14

- **Codex and Gemini CLI.** `roost usage` and `roost verdicts` now read all three agents' logs. `--agent claude-code|codex|gemini` picks one; the default shows every agent that has sessions.
  - **Codex:** rollouts in `sessions/` and `archived_sessions/`.
    - Tool calls, MCP servers (named from the call's end event), skills (from Codex's `<skill>` blocks, name only), and `spawn_agent` roles.
    - Tokens from the per-turn usage whenever the running total changes, so repeats and context resets don't count twice.
    - A legacy fork's copy of its parent is skipped. Subagent threads count into their parent.
  - **Gemini CLI:** `.json` (v0.22 and earlier) and `.jsonl` sessions.
    - Messages united by id, so repeated appends and migrated copies count once. Subagent transcripts count into their parent.
    - Skills (`activate_skill`), subagents (`invoke_agent`, `delegate_to_agent`), and MCP servers from the call's display name.
    - Slash-command names from `logs.json`. The project comes from `.project_root` or `projects.json`.
- **Verdicts across agents.** A skill, command or subagent is judged against the sessions of the agents that load it:
  - `.claude/` is Claude Code, `.codex/` is Codex, and `.gemini/` is Gemini CLI;
  - `.agents/skills` is Codex and Gemini CLI;
  - links count for the agent they point into.

  Gemini commands are `/folder:name`; Codex custom prompts are `/prompts:name`.
- **JSON:** `usage --format json` is now `{ version, window, agents: [ … ] }`, with one entry per agent.

## 0.1.0 — 2026-10-14

The first release on npm: `npx @thinkingraven/roost usage`.


- **`roost verdicts`**: rookery's inventory joined with what Claude Code actually ran. Each skill, command and subagent gets one of five verdicts:
  - **fix first:** used, with quality or serious security findings;
  - **merge:** a copy of a more-used one;
  - **retire:** available but never used;
  - **keep:** used and clean;
  - **no data:** no sessions in its repo.

  Reads `rookery scan --format json` from a pipe or `--rookery <file>`. Skills match by name, folder name or `/name`. Personal skills win over project ones. Skills linked into `~/.claude/skills` count, and a used claude.ai or plugin copy is noted. Names that ran but aren't in the scan are listed. `--format json`.
- **`roost usage`** (Claude Code): skills, subagents, MCP servers and tools, and your own slash commands that agents actually ran, with how many sessions and repos used each, and token use per repo. Subagent logs count towards their session; each response's tokens are counted once; Claude Code worktrees fold into their repo. `--since 30d|YYYY-MM-DD|all`, `--top`, `--format json`. Reports carry names, counts and dates only.
- **Next steps** at the end of `roost usage`, from the counts alone: the skill used in the most repos, skills that ran just once, and MCP servers few sessions used.
- **Colour** in the terminal, in rookery's style: bold headings, dim detail, amber bars. Off when piped; `--no-color`, `NO_COLOR` and `FORCE_COLOR` are respected.
- **Demo team**: `scripts/demo-home.mjs` writes a made-up team's logs for screenshots and trying roost.
- **`roost sources`**: finds Claude Code, Codex and Gemini CLI session logs on this machine and shows how many sessions each has and their date range, without opening any of them. `--format json` and `--home <dir>`.
