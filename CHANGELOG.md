# Changelog

All notable changes to roost are listed here. This project follows [semantic versioning](https://semver.org).

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
