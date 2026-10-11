#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { findSources } from './sources.js';
import { renderSourcesJson, renderSourcesTerminal } from './report/sources.js';
import { renderUsageJson, renderUsageTerminal, type UsageView } from './report/usage.js';
import { useColor } from './report/style.js';
import { aggregate } from './usage/aggregate.js';
import { readClaudeCode } from './usage/claude-code.js';
import { VERSION } from './version.js';

const HELP = `roost v${VERSION}: see what your AI agents actually use.

Usage
  roost usage                    Skills, subagents, MCP servers and commands your agents
                                 actually ran, with token use, per repo (Claude Code)
  roost sources                  Find each agent's session logs on this machine

Options
  --since <30d|YYYY-MM-DD|all>   Time window for usage (default: 30d)
  --top <n>                      Rows per section in the terminal report (default: 10)
  --format <terminal|json>       Output format (default: terminal)
  --home <dir>                   Look in this home folder instead of yours
  --no-color                     Disable colours (also respects NO_COLOR; FORCE_COLOR forces them)
  -v, --version                  Print the version
  -h, --help                     Show this help

roost runs locally and never uploads anything. Reports carry names, counts and dates only.
`;

function fail(msg: string): never {
  process.stderr.write(`roost: ${msg}\n\nRun \`roost --help\` for usage.\n`);
  process.exit(2);
}

/** "30d", "2026-09-01" or "all" → a start date (undefined = all time) and a label for the report. */
export function parseSince(value: string, now = new Date()): { since?: Date; window: string } {
  if (value === 'all') return { window: 'all time' };
  const days = /^(\d+)d$/.exec(value);
  if (days) {
    const n = Number(days[1]);
    if (n < 1) fail('--since needs at least 1d');
    return { since: new Date(now.getTime() - n * 86_400_000), window: n === 1 ? 'last day' : `last ${n} days` };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const since = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(since.getTime())) return { since, window: `since ${value}` };
  }
  fail(`--since must look like 30d, 2026-09-01 or all, not "${value}"`);
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        since: { type: 'string', default: '30d' },
        top: { type: 'string', default: '10' },
        format: { type: 'string', default: 'terminal' },
        home: { type: 'string' },
        'no-color': { type: 'boolean', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    fail((err as Error).message);
  }
  const { values: o, positionals } = parsed;
  if (o.help) { process.stdout.write(HELP); return 0; }
  if (o.version) { process.stdout.write(`${VERSION}\n`); return 0; }
  if (positionals.length === 0) { process.stdout.write(HELP); return 0; }

  const [command, ...rest] = positionals;
  if (command !== 'sources' && command !== 'usage') fail(`unknown command "${command}"`);
  if (rest.length) fail(`unexpected argument "${rest[0]}"`);
  if (o.format !== 'terminal' && o.format !== 'json') fail(`--format must be terminal or json, not "${o.format}"`);
  const home = o.home ? resolve(o.home) : homedir();
  const color = useColor(o['no-color']);

  if (command === 'sources') {
    const sources = findSources(home);
    process.stdout.write(o.format === 'json' ? renderSourcesJson(sources, home) : renderSourcesTerminal(sources, home, color));
    return 0;
  }

  const top = Number(o.top);
  if (!Number.isInteger(top) || top < 1) fail(`--top must be a whole number of 1 or more, not "${o.top}"`);
  const { since, window } = parseSince(o.since);
  const { sessions, skipped } = await readClaudeCode(home, since);
  const view: UsageView = { report: aggregate(sessions, skipped, since), agentName: 'Claude Code', window, home, top, color };
  process.stdout.write(o.format === 'json' ? renderUsageJson(view, 'claude-code') : renderUsageTerminal(view));
  return 0;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
