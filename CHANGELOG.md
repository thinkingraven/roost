# Changelog

All notable changes to roost are listed here. This project follows [semantic versioning](https://semver.org).

## Unreleased

- **`roost usage`** (Claude Code): skills, subagents, MCP servers and tools, and your own slash commands that agents actually ran, with how many sessions and repos used each, and token use per repo. Subagent logs count towards their session; each response's tokens are counted once; Claude Code worktrees fold into their repo. `--since 30d|YYYY-MM-DD|all`, `--top`, `--format json`. Reports carry names, counts and dates only.
- **`roost sources`**: finds Claude Code, Codex and Gemini CLI session logs on this machine and shows how many sessions each has and their date range, without opening any of them. `--format json` and `--home <dir>`.
