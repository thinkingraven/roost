import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('--version prints the package version', () => {
  const r = run('--version');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), VERSION);
});

test('no command shows help', () => {
  const r = run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /roost sources/);
});

test('sources --format json lists every agent, with paths relative to home', () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-cli-'));
  mkdirSync(join(home, '.claude/projects/-Users-ana-shop'), { recursive: true });
  writeFileSync(join(home, '.claude/projects/-Users-ana-shop/0b1c.jsonl'), '');
  const r = run('sources', '--home', home, '--format', 'json');
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.version, VERSION);
  assert.deepEqual(out.sources.map((s: { agent: string }) => s.agent), ['claude-code', 'codex', 'gemini-cli']);
  assert.equal(out.sources[0].dir, '~/.claude/projects');
  assert.equal(out.sources[0].sessions, 1);
  assert.equal(out.sources[1].found, false);
  assert.ok(!r.stdout.includes(home), 'the home path must not appear in the report');
});

test('sources prints a terminal table', () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-cli-'));
  const r = run('sources', '--home', home);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Claude Code\s+~\/\.claude\/projects\s+not found/);
  assert.match(r.stdout, /Nothing leaves this machine\./);
});

test('usage errors exit 2', () => {
  assert.equal(run('scan').status, 2);
  assert.equal(run('sources', '--format', 'xml').status, 2);
  assert.equal(run('sources', '--nope').status, 2);
});
