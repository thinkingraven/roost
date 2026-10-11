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

> **Early days.** `roost sources` works today. Usage, context cost and verdicts are next: see the [plan](docs/plan.md).

## Try it

Not on npm yet. From a clone:

```bash
git clone https://github.com/thinkingraven/roost.git
cd roost
npm ci
npm test
node dist/src/cli.js sources
```

```text
roost v0.0.0: agent session logs on this machine

  Claude Code   ~/.claude/projects   214 sessions   2026-06-02 → 2026-10-10
  Codex         ~/.codex/sessions    38 sessions    2026-07-14 → 2026-10-09
  Gemini CLI    ~/.gemini/tmp        not found

Nothing leaves this machine.
```

| Option | Default | Description |
|---|---|---|
| `--format <terminal\|json>` | `terminal` | Output format |
| `--home <dir>` | your home folder | Look for logs under another folder |

## Privacy

- No network calls and no telemetry.
- `roost sources` only lists file names and dates; it doesn't open your logs.
- Later commands read logs only to find tool calls. They never print, store or export the text of your prompts or the agents' replies.
- Reports show paths under your home folder as `~/…`.

## roost and rookery

[rookery](https://github.com/thinkingraven/rookery) shows what your agents *could* do: every skill, the duplicates and the risky ones. roost shows what they *actually did*. Together they answer which skills to share, which to merge and which to retire.

## Licence

[MIT](LICENSE) © Thinking Raven
