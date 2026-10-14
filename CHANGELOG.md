# Changelog

All notable changes to roost are listed here. This project follows [semantic versioning](https://semver.org).

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
