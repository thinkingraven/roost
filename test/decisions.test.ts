import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateDecisions, readDecisions, type Decision } from '../src/decisions.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '', NO_COLOR: '' };
delete env.ROOKERY_HOME; // isolate from whatever the test machine has set
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
const runWith = (extra: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...env, ...extra } });

// One deny, as rookery's hook actually writes it (test/hook.test.ts in rookery).
const DENY = { ts: '2026-10-14T18:32:07.511Z', agent: 'claude-code', kind: 'shell', decision: 'deny', rule: 'RK-POL-003', key: 'shell.deny', subject: 'rm -rf ~/', repo: 'payments-api' };
const WARN = { ts: '2026-10-14T20:00:00.000Z', agent: 'claude-code', kind: 'other', decision: 'warn', rule: 'RK-POL-001', key: 'approvals.bypass', subject: '--dangerously-skip-permissions', repo: 'payments-api' };
const DENY_NO_RULE = { ts: '2026-09-01T09:00:00.000Z', agent: 'codex', kind: 'read', decision: 'deny', key: 'files.read_secrets', subject: 'cat ~/.ssh/**', repo: 'web-app' };

function fakeHome(days: Record<string, unknown[]>): string {
  const home = mkdtempSync(join(tmpdir(), 'roost-decisions-'));
  const dir = join(home, '.rookery', 'decisions');
  mkdirSync(dir, { recursive: true });
  for (const [file, lines] of Object.entries(days)) {
    writeFileSync(join(dir, file), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  }
  return home;
}

test('readDecisions: parses rookery\'s log shape, skips what it doesn\'t recognise', async () => {
  const home = fakeHome({
    '2026-10-14.jsonl': [DENY, WARN, 'not json', { ...DENY, agent: 'a-future-agent' }, { ...DENY, decision: 'pass' }],
  });
  const { decisions, skipped, found } = await readDecisions(join(home, '.rookery'));
  assert.equal(found, true);
  // A newer, unrecognised agent still reads: rookery's agent and kind names are its own, evolving
  // vocabulary, so only a missing ts/decision/subject (bad JSON or a plain "pass") is skipped.
  assert.equal(decisions.length, 3);
  assert.equal(skipped, 2, 'bad JSON and a non-deny/warn decision are skipped; an unfamiliar agent is not');
  assert.deepEqual(decisions[0], { ts: new Date(DENY.ts), agent: 'claude-code', kind: 'shell', decision: 'deny', rule: 'RK-POL-003', key: 'shell.deny', subject: 'rm -rf ~/', repo: 'payments-api' });
  assert.equal(decisions[2].agent, 'a-future-agent');
});

test('readDecisions: a line with no rule id (a plain policy key) still reads', async () => {
  const home = fakeHome({ '2026-09-01.jsonl': [DENY_NO_RULE] });
  const { decisions } = await readDecisions(join(home, '.rookery'));
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].rule, undefined);
  assert.equal(decisions[0].key, 'files.read_secrets');
});

test('readDecisions: no decisions folder is reported, not an error', async () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-decisions-empty-'));
  const { decisions, found } = await readDecisions(join(home, '.rookery'));
  assert.equal(found, false);
  assert.deepEqual(decisions, []);
});

test('readDecisions: --since skips whole days before the window, then filters by line', async () => {
  const home = fakeHome({ '2026-09-01.jsonl': [DENY_NO_RULE], '2026-10-14.jsonl': [DENY, WARN] });
  const { decisions } = await readDecisions(join(home, '.rookery'), new Date('2026-10-01T00:00:00Z'));
  assert.equal(decisions.length, 2);
  assert.ok(decisions.every((d: Decision) => d.ts >= new Date('2026-10-01T00:00:00Z')));
});

test('aggregateDecisions: counts by outcome, agent, repo and rule (falling back to the policy key)', () => {
  const report = aggregateDecisions(
    [DENY, WARN, DENY_NO_RULE].map((d) => ({ ...d, ts: new Date(d.ts) }) as Decision),
    1,
  );
  assert.equal(report.total, 3);
  assert.equal(report.denied, 2);
  assert.equal(report.warned, 1);
  assert.equal(report.skipped, 1);
  assert.deepEqual(report.byAgent, [{ name: 'claude-code', count: 2 }, { name: 'codex', count: 1 }]);
  assert.deepEqual(report.byRepo, [{ name: 'payments-api', count: 2 }, { name: 'web-app', count: 1 }]);
  const unruled = report.byRule.find((r) => r.id === 'files.read_secrets');
  assert.ok(unruled, 'a deny with no rule id falls back to its policy key');
  assert.equal(unruled!.example, 'cat ~/.ssh/**');
});

test('cli: roost decisions reports denies, warns and the skipped line, in terminal and JSON', () => {
  const home = fakeHome({ '2026-10-14.jsonl': [DENY, WARN, 'garbage'] });
  const terminal = run('decisions', '--home', home, '--since', 'all');
  assert.equal(terminal.status, 0);
  assert.match(terminal.stdout, /DENIED 1/);
  assert.match(terminal.stdout, /WARNED 1/);
  assert.match(terminal.stdout, /RK-POL-003/);
  assert.match(terminal.stdout, /1 line in the log roost couldn.t read/);
  assert.doesNotMatch(terminal.stdout, /garbage/);

  const json = JSON.parse(run('decisions', '--home', home, '--since', 'all', '--format', 'json').stdout);
  assert.equal(json.total, 2);
  assert.equal(json.denied, 1);
  assert.equal(json.skipped, 1);
});

test('cli: roost decisions says so when there is no log yet', () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-decisions-empty-'));
  const r = run('decisions', '--home', home);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No ~\/\.rookery\/decisions folder found/);
});

test('cli: roost decisions rejects --agent, which belongs to the session-usage commands', () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-decisions-empty-'));
  const r = run('decisions', '--home', home, '--agent', 'codex');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--agent is not an option of roost decisions/);
});

test('cli: ROOKERY_HOME overrides --home/.rookery, as it does for `roost export`', () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-decisions-elsewhere-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'roost-decisions-rookery-home-'));
  mkdirSync(join(elsewhere, 'decisions'), { recursive: true });
  writeFileSync(join(elsewhere, 'decisions', '2026-10-14.jsonl'), JSON.stringify(DENY) + '\n');
  const r = runWith({ ROOKERY_HOME: elsewhere }, 'decisions', '--home', home, '--since', 'all');
  assert.match(r.stdout, /DENIED 1/);
});
