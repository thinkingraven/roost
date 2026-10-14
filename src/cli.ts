#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { findSources } from './sources.js';
import { renderSourcesJson, renderSourcesTerminal } from './report/sources.js';
import { renderUsageJson, renderUsageTerminal, type UsageView } from './report/usage.js';
import { useColor } from './report/style.js';
import { aggregate } from './usage/aggregate.js';
import { readClaudeCode } from './usage/claude-code.js';
import { renderVerdictsJson, renderVerdictsTerminal } from './report/verdicts.js';
import { InputError, judge, parseRookery } from './verdicts.js';
import { VERSION } from './version.js';

const HELP = `roost v${VERSION}: see what your AI agents actually use.

Usage
  roost usage                    Skills, subagents, MCP servers and commands your agents
                                 actually ran, with token use, per repo (Claude Code)
  roost verdicts                 Keep, fix, merge or retire each skill: rookery's inventory joined
                                 with what Claude Code actually ran. Pipe rookery's JSON in:
                                   rookery scan ~/code --local --format json | roost verdicts
  roost sources                  Find each agent's session logs on this machine

Options
  --since <30d|YYYY-MM-DD|all>   Time window for usage and verdicts (default: 30d)
  --rookery <file>               rookery's JSON report for verdicts (or pipe it in; - reads stdin)
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

/** All of stdin (async: a synchronous read of a non-blocking pipe can fail with EAGAIN). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
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
        rookery: { type: 'string' },
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
  if (command !== 'sources' && command !== 'usage' && command !== 'verdicts') fail(`unknown command "${command}"`);
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
  if (command === 'verdicts') {
    const source = o.rookery ?? (process.stdin.isTTY ? undefined : '-');
    if (!source) fail('verdicts needs rookery\'s JSON report. Pipe it in:\n  rookery scan ~/code --local --format json | roost verdicts\nor save it and pass --rookery report.json');
    let rookery;
    try {
      rookery = parseRookery(source === '-' ? await readStdin() : readFileSync(source, 'utf8'));
    } catch (err) {
      if (err instanceof InputError) fail(err.message);
      fail(`can't read ${source === '-' ? 'stdin' : source}: ${(err as Error).message}`);
    }
    const { sessions } = await readClaudeCode(home, since);
    let first: Date | null = null, last: Date | null = null;
    for (const s of sessions) {
      if (s.first && (!first || s.first < first)) first = s.first;
      if (s.last && (!last || s.last > last)) last = s.last;
    }
    const view = {
      report: judge(rookery, sessions, home), window, sessions: sessions.length, first, last,
      rookery: { version: rookery.tool.version, scannedAt: rookery.scannedAt }, top, color,
    };
    process.stdout.write(o.format === 'json' ? renderVerdictsJson(view) : renderVerdictsTerminal(view));
    return 0;
  }

  const { sessions, skipped } = await readClaudeCode(home, since);
  const view: UsageView = { report: aggregate(sessions, skipped, since), agentName: 'Claude Code', window, home, top, color };
  process.stdout.write(o.format === 'json' ? renderUsageJson(view, 'claude-code') : renderUsageTerminal(view));
  return 0;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
