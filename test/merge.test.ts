import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError, mergeExports, parseExportFile, type ExportFile } from '../src/merge.js';
import type { Row } from '../src/export/rows.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const env = { ...process.env, FORCE_COLOR: '', NO_COLOR: '' };

function row(p: Partial<Row> & Pick<Row, 'event' | 'day' | 'agent'>): Row {
  return { values: {}, labels: {}, ...p };
}
function file(rows: Row[], extra: Partial<ExportFile> = {}): ExportFile {
  return { version: '0.6.0', window: { from: '2026-10-01', to: '2026-10-15' }, team: null, person: null, rows, ...extra };
}

test('parseExportFile: only a roost export report is accepted', () => {
  assert.throws(() => parseExportFile('not json'), InputError);
  assert.throws(() => parseExportFile(JSON.stringify({ tool: { name: 'rookery' }, artifacts: [] })), /not a roost export report/);
  assert.deepEqual(parseExportFile(JSON.stringify(file([]))).rows, []);
});

test('mergeExports: activity sums sessions and every token kind, across files; window spans the widest range', () => {
  const a = file([row({ event: 'roost.activity', day: '2026-10-01', agent: 'claude-code', values: { sessions: 3, 'tokens.input': 100, 'tokens.cache_read': 200, 'tokens.cache_write': 10, 'tokens.output': 50 } })]);
  const b = file([row({ event: 'roost.activity', day: '2026-10-02', agent: 'claude-code', values: { sessions: 2, 'tokens.input': 10, 'tokens.cache_read': 20, 'tokens.cache_write': 1, 'tokens.output': 5 } })], { window: { from: '2026-10-02', to: '2026-10-16' } });
  const r = mergeExports([a, b]);
  assert.equal(r.people, 2);
  assert.deepEqual(r.byAgent, [{ agent: 'claude-code', sessions: 5, tokens: 100 + 200 + 10 + 50 + 10 + 20 + 1 + 5 }]);
  assert.deepEqual(r.window, { from: '2026-10-01', to: '2026-10-16' });
});

test('mergeExports: skills, subagents, commands and MCP servers sum counts and count distinct contributors', () => {
  const a = file([
    row({ event: 'roost.skill_used', day: 'd1', agent: 'claude-code', item: { key: 'skill', value: 'lint' }, values: { runs: 5 } }),
    row({ event: 'roost.mcp_used', day: 'd1', agent: 'claude-code', item: { key: 'mcp_server', value: 'github' }, values: { calls: 4 } }),
  ]);
  const b = file([
    row({ event: 'roost.skill_used', day: 'd2', agent: 'claude-code', item: { key: 'skill', value: 'lint' }, values: { runs: 3 } }),
    row({ event: 'roost.command_used', day: 'd2', agent: 'codex', item: { key: 'command', value: '/ship' }, values: { uses: 2 } }),
  ]);
  const r = mergeExports([a, b]);
  assert.deepEqual(r.skills, [{ name: 'lint', count: 8, people: 2 }]);
  assert.deepEqual(r.commands, [{ name: '/ship', count: 2, people: 1 }]);
  assert.deepEqual(r.mcp, [{ name: 'github', count: 4, people: 1 }]);
  assert.deepEqual(r.subagents, []);
});

test('mergeExports: the same name in different repos is never conflated', () => {
  const a = file([row({ event: 'roost.skill_used', day: 'd', agent: 'claude-code', repo: 'github.com/acme/api', item: { key: 'skill', value: 'lint' }, values: { runs: 5 } })]);
  const b = file([row({ event: 'roost.skill_used', day: 'd', agent: 'claude-code', repo: 'github.com/acme/web', item: { key: 'skill', value: 'lint' }, values: { runs: 3 } })]);
  const r = mergeExports([a, b]);
  assert.deepEqual(r.skills, [
    { name: 'lint', repo: 'github.com/acme/api', count: 5, people: 1 },
    { name: 'lint', repo: 'github.com/acme/web', count: 3, people: 1 },
  ]);
});

test('mergeExports: verdicts sum uses and scope_sessions, recompute the verdict, and take the biggest issues count rather than adding them up', () => {
  const a = file([row({ event: 'roost.verdict', day: 'd', agent: 'claude-code', item: { key: 'skill', value: 'old-skill' }, labels: { verdict: 'retire' }, values: { uses: 0, sessions: 0, scope_sessions: 5, issues: 0 } })]);
  const b = file([row({ event: 'roost.verdict', day: 'd', agent: 'claude-code', item: { key: 'skill', value: 'old-skill' }, labels: { verdict: 'keep' }, values: { uses: 2, sessions: 2, scope_sessions: 3, issues: 0 } })]);
  assert.deepEqual(mergeExports([a, b]).verdicts, [{ kind: 'skill', name: 'old-skill', verdict: 'keep', uses: 2, scopeSessions: 8, issues: 0, people: 2 }]);

  const c = file([row({ event: 'roost.verdict', day: 'd', agent: 'claude-code', item: { key: 'skill', value: 'ship' }, labels: { verdict: 'improve' }, values: { uses: 1, sessions: 1, scope_sessions: 1, issues: 2 } })]);
  const e = file([row({ event: 'roost.verdict', day: 'd', agent: 'claude-code', item: { key: 'skill', value: 'ship' }, labels: { verdict: 'improve' }, values: { uses: 3, sessions: 3, scope_sessions: 3, issues: 2 } })]);
  assert.deepEqual(mergeExports([c, e]).verdicts, [{ kind: 'skill', name: 'ship', verdict: 'improve', uses: 4, scopeSessions: 4, issues: 2, people: 2 }]);
});

test('mergeExports: a merge verdict from any file wins, no matter what the usage counts say', () => {
  const a = file([row({ event: 'roost.verdict', day: 'd', agent: 'claude-code', item: { key: 'skill', value: 'dup' }, labels: { verdict: 'merge' }, values: { uses: 0, sessions: 0, scope_sessions: 2, issues: 0 } })]);
  const b = file([row({ event: 'roost.verdict', day: 'd', agent: 'claude-code', item: { key: 'skill', value: 'dup' }, labels: { verdict: 'keep' }, values: { uses: 9, sessions: 9, scope_sessions: 9, issues: 0 } })]);
  const r = mergeExports([a, b]);
  assert.equal(r.verdicts[0].verdict, 'merge');
});

test('mergeExports: no session anywhere in scope is no-data, even if someone else used it with no scope overlap recorded', () => {
  const a = file([row({ event: 'roost.verdict', day: 'd', agent: 'claude-code', item: { key: 'skill', value: 'untouched' }, labels: { verdict: 'no-data' }, values: { uses: 0, sessions: 0, scope_sessions: 0, issues: 0 } })]);
  assert.equal(mergeExports([a]).verdicts[0].verdict, 'no-data');
});

test('mergeExports: policy rows sum blocked and warned across files and agents', () => {
  const a = file([row({ event: 'rookery.policy', day: 'd', agent: 'claude-code', item: { key: 'rule', value: 'no-bypass' }, values: { blocked: 2, warned: 1 } })]);
  const b = file([row({ event: 'rookery.policy', day: 'd', agent: 'codex', item: { key: 'rule', value: 'no-bypass' }, values: { blocked: 1, warned: 0 } })]);
  assert.deepEqual(mergeExports([a, b]).policy, [{ rule: 'no-bypass', blocked: 3, warned: 1 }]);
});

test('mergeExports: verdicts and policy are empty, not missing, when no file has that data', () => {
  const r = mergeExports([file([]), file([])]);
  assert.deepEqual(r.verdicts, []);
  assert.deepEqual(r.policy, []);
  assert.deepEqual(r.byAgent, []);
});

test('mergeExports: distinct, non-null team labels are collected so a mismatch can be flagged', () => {
  assert.deepEqual(mergeExports([file([], { team: 'acme' }), file([], { team: 'acme' })]).teams, ['acme']);
  assert.deepEqual(mergeExports([file([], { team: 'acme' }), file([], { team: null })]).teams, ['acme']);
  assert.deepEqual(mergeExports([file([], { team: 'acme' }), file([], { team: 'other' })]).teams.sort(), ['acme', 'other']);
});

// ---------- CLI ----------

function writeExport(dir: string, name: string, data: ExportFile): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(data));
  return path;
}

test('CLI: roost merge combines files into a team report, terminal and json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-merge-'));
  const a = writeExport(dir, 'alice.json', file([
    row({ event: 'roost.activity', day: '2026-10-01', agent: 'claude-code', values: { sessions: 2, 'tokens.input': 10, 'tokens.cache_read': 0, 'tokens.cache_write': 0, 'tokens.output': 0 } }),
    row({ event: 'roost.skill_used', day: '2026-10-01', agent: 'claude-code', item: { key: 'skill', value: 'code-review' }, values: { runs: 6 } }),
  ], { team: 'acme' }));
  const b = writeExport(dir, 'bob.json', file([
    row({ event: 'roost.activity', day: '2026-10-02', agent: 'codex', values: { sessions: 1, 'tokens.input': 5, 'tokens.cache_read': 0, 'tokens.cache_write': 0, 'tokens.output': 0 } }),
    row({ event: 'roost.skill_used', day: '2026-10-02', agent: 'codex', item: { key: 'skill', value: 'code-review' }, values: { runs: 2 } }),
  ], { team: 'acme', window: { from: '2026-10-02', to: '2026-10-16' } }));

  const terminal = spawnSync(process.execPath, [CLI, 'merge', a, b, '--no-color'], { encoding: 'utf8', env });
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.match(terminal.stdout, /merge\s+·\s+2 files\s+·\s+2026-10-01 → 2026-10-16/);
  assert.match(terminal.stdout, /code-review.*8.*2 people/);
  assert.ok(!terminal.stdout.includes('different teams'));

  const json = JSON.parse(spawnSync(process.execPath, [CLI, 'merge', a, b, '--format', 'json'], { encoding: 'utf8', env }).stdout);
  assert.equal(json.people, 2);
  assert.deepEqual(json.teams, ['acme']);
  assert.deepEqual(json.skills, [{ name: 'code-review', count: 8, people: 2 }]);
  assert.deepEqual(json.byAgent.sort((x: { agent: string }, y: { agent: string }) => x.agent.localeCompare(y.agent)), [
    { agent: 'claude-code', sessions: 2, tokens: 10 },
    { agent: 'codex', sessions: 1, tokens: 5 },
  ]);
});

test('CLI: roost merge needs at least 2 files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-merge-'));
  const a = writeExport(dir, 'alice.json', file([]));
  const none = spawnSync(process.execPath, [CLI, 'merge'], { encoding: 'utf8', env });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /at least 2 files/);
  const one = spawnSync(process.execPath, [CLI, 'merge', a], { encoding: 'utf8', env });
  assert.equal(one.status, 2);
  assert.match(one.stderr, /at least 2 files/);
});

test('CLI: roost merge reports which file is bad, reading or parsing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-merge-'));
  const a = writeExport(dir, 'alice.json', file([]));
  const badJson = join(dir, 'bad.json');
  writeFileSync(badJson, 'not json');
  const bad = spawnSync(process.execPath, [CLI, 'merge', a, badJson], { encoding: 'utf8', env });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, new RegExp(`${badJson.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: not JSON`));

  const missing = spawnSync(process.execPath, [CLI, 'merge', a, join(dir, 'missing.json')], { encoding: 'utf8', env });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /can't read/);

  const rookery = join(dir, 'rookery.json');
  writeFileSync(rookery, JSON.stringify({ tool: { name: 'rookery', version: '0.8.0' }, artifacts: [] }));
  const wrong = spawnSync(process.execPath, [CLI, 'merge', a, rookery], { encoding: 'utf8', env });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /not a roost export report/);
});
