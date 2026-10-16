import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { personId } from '../src/export/identity.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const DEMO_TEAM = fileURLToPath(new URL('../../scripts/demo-team.mjs', import.meta.url));
const env = { ...process.env, FORCE_COLOR: '', NO_COLOR: '' };

test('demo-team.mjs writes several distinct teammates, each with its own git identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-demo-team-'));
  const r = spawnSync(process.execPath, [DEMO_TEAM, dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);

  const people = readdirSync(dir).sort();
  assert.ok(people.length >= 2, 'a team is more than one person');

  const emails = people.map((p) => {
    const cfg = readFileSync(join(dir, p, '.gitconfig'), 'utf8');
    return /email = (\S+)/.exec(cfg)![1];
  });
  assert.equal(new Set(emails).size, people.length, 'every teammate has a different email');

  const hashes = people.map((p) => personId('a-salt', join(dir, p)));
  assert.equal(new Set(hashes).size, people.length, 'roost export would hash each teammate to a different person id');

  // Each teammate is a real demo-home.mjs person: roost usage recovers the same totals as the solo test.
  const usage = JSON.parse(spawnSync(process.execPath, [CLI, 'usage', '--home', join(dir, people[0]), '--since', 'all', '--format', 'json'], { encoding: 'utf8', env }).stdout);
  assert.equal(usage.agents[0].sessions, 41);
});
