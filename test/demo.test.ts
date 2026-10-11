import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const DEMO = fileURLToPath(new URL('../../scripts/demo-home.mjs', import.meta.url));
const env = { ...process.env, FORCE_COLOR: '', NO_COLOR: '' };

// The demo writes ~23k log lines in Claude Code's real shape (responses split into several entries,
// subagent logs) with known totals; roost has to recover them exactly.
test('recovers the demo team\'s exact totals from 23k realistic log lines', () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-demo-'));
  assert.equal(spawnSync(process.execPath, [DEMO, home], { encoding: 'utf8' }).status, 0);
  const r = spawnSync(process.execPath, [CLI, 'usage', '--home', home, '--since', 'all', '--format', 'json'], { encoding: 'utf8', env });
  const out = JSON.parse(r.stdout);
  const skill = (n: string) => out.skills.find((s: { name: string }) => s.name === n)?.count;
  assert.equal(out.sessions, 41);
  assert.equal(out.repos.length, 6);
  assert.equal(skill('code-review'), 31);
  assert.equal(out.skills.reduce((a: number, s: { count: number }) => a + s.count, 0), 71);
  assert.equal(out.subagents.reduce((a: number, s: { count: number }) => a + s.count, 0), 25);
  assert.deepEqual(out.mcp.map((m: { server: string; calls: number }) => [m.server, m.calls]), [['github', 288], ['linear', 96], ['sentry', 18]]);
  assert.equal(out.commands.find((c: { name: string }) => c.name === '/deploy')?.count, 15);
  assert.equal(out.tools.find((t: { name: string }) => t.name === 'Bash')?.count, 3912);
  assert.equal(out.skipped, 0);

  const text = spawnSync(process.execPath, [CLI, 'usage', '--home', home, '--since', 'all'], { encoding: 'utf8', env }).stdout;
  assert.match(text, /→ code-review runs in 4 repos: worth one shared, reviewed version/);
  assert.match(text, /→ 1 skill ran just once \(all time\): changelog\. Check it still earns its place\./);
  assert.match(text, /→ sentry was used in 6 of 41 sessions\. If it's enabled everywhere, its tool definitions cost tokens in the other 35\./);
});
