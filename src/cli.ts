#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { findSources } from './sources.js';
import { renderSourcesJson, renderSourcesTerminal } from './report.js';
import { VERSION } from './version.js';

const HELP = `roost v${VERSION}: see what your AI agents actually use.

Usage
  roost sources                  Find each agent's session logs on this machine

Options
  --format <terminal|json>       Output format (default: terminal)
  --home <dir>                   Look in this home folder instead of yours
  -v, --version                  Print the version
  -h, --help                     Show this help

roost runs locally and never uploads anything.
`;

function fail(msg: string): never {
  process.stderr.write(`roost: ${msg}\n\nRun \`roost --help\` for usage.\n`);
  process.exit(2);
}

function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: 'string', default: 'terminal' },
        home: { type: 'string' },
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
  if (command !== 'sources') fail(`unknown command "${command}"`);
  if (rest.length) fail(`unexpected argument "${rest[0]}"`);
  if (o.format !== 'terminal' && o.format !== 'json') fail(`--format must be terminal or json, not "${o.format}"`);

  const home = o.home ? resolve(o.home) : homedir();
  const sources = findSources(home);
  process.stdout.write(o.format === 'json' ? renderSourcesJson(sources, home) : renderSourcesTerminal(sources, home));
  return 0;
}

process.exitCode = main(process.argv.slice(2));
