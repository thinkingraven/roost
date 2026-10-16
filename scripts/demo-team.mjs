#!/usr/bin/env node
// Writes several made-up "acme" teammates' logs under <dir>, one subdirectory per person, each
// with its own seed (a different made-up teammate) and its own fake git identity — so roost export
// and roost merge see them as distinct people, not one person's data sent five times:
//
//   node scripts/demo-team.mjs /tmp/acme-team
//   node dist/src/cli.js usage --home /tmp/acme-team/priya --since all
//
// Each teammate is exactly what `scripts/demo-home.mjs <dir> <seed>` already writes; this script
// only adds the distinct seeds and the per-person .gitconfig roost export's person id is hashed from.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: node scripts/demo-team.mjs <dir>\n');
  process.exit(2);
}

const DEMO_HOME = fileURLToPath(new URL('./demo-home.mjs', import.meta.url));

// name, seed: deterministic, so the same team regenerates identically every time.
const TEAM = [
  ['priya', 20261011],
  ['marcus', 7],
  ['lena', 1984],
  ['devon', 555123],
  ['sofia', 90210],
];

for (const [name, seed] of TEAM) {
  const home = join(dir, name);
  execFileSync(process.execPath, [DEMO_HOME, home, String(seed)], { stdio: 'inherit' });
  const display = name[0].toUpperCase() + name.slice(1);
  writeFileSync(join(home, '.gitconfig'), `[user]\n\temail = ${name}@acme.example\n\tname = ${display}\n`);
}

const names = TEAM.map(([name]) => name).join(' ');
process.stdout.write(`\nWrote ${TEAM.length} demo teammates under ${dir}. Send them all as one team, e.g.:\n`
  + `  for p in ${names}; do ROOST_EXPORT=on ROOST_TEAM=acme npx @thinkingraven/roost export --home ${dir}/$p --since all --send; done\n`);
