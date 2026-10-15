import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateContext } from '../src/context.js';
import { newSession, type SessionUsage, type Tokens } from '../src/usage/types.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const env = { ...process.env, FORCE_COLOR: '', NO_COLOR: '' };
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });

const tok = (total: number): Tokens => ({ input: 0, cacheWrite: 0, cacheRead: total, output: 0 });

function session(agent: SessionUsage['agent'], repo: string | undefined, when: string, preload?: number): SessionUsage {
  const s = newSession(agent, `${agent}-${repo}-${when}`);
  s.repo = repo;
  s.first = new Date(when);
  if (preload !== undefined) s.preload = tok(preload);
  return s;
}

test('aggregateContext: splits measured from unmeasured, and averages per token field', () => {
  const sessions = [
    session('claude-code', 'shop', '2026-10-01T10:00:00Z', 100),
    session('claude-code', 'shop', '2026-10-02T10:00:00Z', 300),
    session('codex', 'shop', '2026-10-03T10:00:00Z'), // no preload: couldn't be measured
  ];
  const r = aggregateContext(sessions);
  assert.equal(r.measured, 2);
  assert.equal(r.unmeasured, 1);
  assert.deepEqual(r.average, { input: 0, cacheWrite: 0, cacheRead: 200, output: 0 });
});

test('aggregateContext: groups by agent and by repo, heaviest sessions first', () => {
  const sessions = [
    session('claude-code', 'shop', '2026-10-01T10:00:00Z', 100),
    session('claude-code', 'api', '2026-10-02T10:00:00Z', 500),
    session('codex', 'shop', '2026-10-03T10:00:00Z', 700),
  ];
  const r = aggregateContext(sessions);
  assert.deepEqual(r.byAgent.map((a) => [a.agent, a.sessions, a.average]), [['codex', 1, 700], ['claude-code', 2, 300]]);
  // shop: (100 + 700) / 2 = 400; api: 500 alone — api sorts first.
  assert.deepEqual(r.byRepo.map((x) => [x.repo, x.sessions, x.average]), [['api', 1, 500], ['shop', 2, 400]]);
  assert.deepEqual(r.heaviest.map((x) => x.total), [700, 500, 100]);
});

test('aggregateContext: a repo with one measured session has no trend yet', () => {
  const r = aggregateContext([session('claude-code', 'solo', '2026-10-01T10:00:00Z', 100)]);
  const [repo] = r.byRepo;
  assert.ok(repo.earliest);
  assert.equal(repo.latest, undefined);
});

test('aggregateContext: a repo trend compares its earliest and latest measured sessions', () => {
  const r = aggregateContext([
    session('claude-code', 'growing', '2026-09-01T10:00:00Z', 1000),
    session('claude-code', 'growing', '2026-10-01T10:00:00Z', 5000),
  ]);
  const [repo] = r.byRepo;
  assert.deepEqual([repo.earliest?.total, repo.latest?.total], [1000, 5000]);
});

test('aggregateContext: a repo with no measured sessions is left out entirely', () => {
  const r = aggregateContext([session('codex', 'ghost', '2026-10-01T10:00:00Z')]);
  assert.deepEqual(r.byRepo, []);
  assert.equal(r.unmeasured, 1);
});

function fakeClaudeCodeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'roost-context-cli-'));
  const shop = join(home, 'code', 'shop');
  const api = join(home, 'code', 'api');
  mkdirSync(join(shop, '.git'), { recursive: true });
  mkdirSync(join(api, '.git'), { recursive: true });
  const write = (rel: string, lines: unknown[]) => {
    const path = join(home, '.claude', 'projects', rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  const msg = (sessionId: string, cwd: string, id: string, ts: string, u: object) => ({
    type: 'assistant', uuid: `u-${id}`, sessionId, cwd, timestamp: ts,
    message: { role: 'assistant', id, model: 'claude-x', usage: u, content: [] },
  });
  const usage = (input: number, cacheWrite: number, cacheRead: number, output: number) =>
    ({ input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: output });
  write('-code-shop/s1.jsonl', [
    msg('s1', shop, 'm1', '2026-10-01T10:00:00Z', usage(2, 10000, 20000, 200)),
    msg('s1', shop, 'm2', '2026-10-01T10:05:00Z', usage(5, 100, 500, 80)),
  ]);
  write('-code-shop/s2.jsonl', [
    msg('s2', shop, 'm3', '2026-10-05T10:00:00Z', usage(2, 40000, 10000, 200)),
  ]);
  write('-code-api/s3.jsonl', [
    msg('s3', api, 'm4', '2026-10-02T10:00:00Z', usage(2, 1000, 2000, 50)),
  ]);
  return home;
}

test('cli: roost context reports average preload, by-repo trend and the heaviest sessions', () => {
  const home = fakeClaudeCodeHome();
  const terminal = run('context', '--home', home, '--since', 'all');
  assert.equal(terminal.status, 0);
  assert.match(terminal.stdout, /AVERAGE PRELOAD/);
  assert.match(terminal.stdout, /BY REPO/);
  assert.match(terminal.stdout, /HEAVIEST SESSIONS/);
  assert.match(terminal.stdout, /growing/, 'shop grew from s1 (30,002) to s2 (50,002)');

  const json = JSON.parse(run('context', '--home', home, '--since', 'all', '--format', 'json').stdout);
  assert.equal(json.measured, 3);
  assert.equal(json.unmeasured, 0);
  assert.equal(json.byRepo.length, 2);
  assert.equal(json.heaviest[0].total, 50002, 'shop/s2: 2 + 40,000 cache write + 10,000 cache read');
});

test('cli: roost context says so plainly when nothing was measured', () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-context-empty-'));
  const r = run('context', '--home', home);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No session had a turn with usable token usage/);
});

test('cli: roost context --agent filters to one agent', () => {
  const home = fakeClaudeCodeHome();
  const r = run('context', '--home', home, '--since', 'all', '--agent', 'codex');
  assert.match(r.stdout, /No session had a turn with usable token usage/);
});
