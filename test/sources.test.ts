import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findSources } from '../src/sources.js';
import { tilde } from '../src/report.js';

/** A fake home folder. Files are empty: roost must work from names and dates alone. */
function fakeHome(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), 'roost-home-'));
  for (const [rel, date] of Object.entries(files)) {
    const path = join(home, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
    const t = new Date(date);
    utimesSync(path, t, t);
  }
  return home;
}

test('finds Claude Code, Codex and Gemini CLI sessions, with date ranges', () => {
  const home = fakeHome({
    '.claude/projects/-Users-ana-shop/0b1c.jsonl': '2026-05-01T10:00:00Z',
    '.claude/projects/-Users-ana-shop/7f2e.jsonl': '2026-09-30T10:00:00Z',
    '.claude/projects/-Users-ana-api/91aa.jsonl': '2026-07-15T10:00:00Z',
    '.codex/sessions/2026/04/12/rollout-2026-04-12T22-39-16-abc.jsonl': '2026-04-12T22:39:16Z',
    '.codex/sessions/2026/08/20/rollout-2026-08-20T12-28-33-def.jsonl': '2026-08-20T12:28:33Z',
    '.gemini/tmp/77b2/chats/session-2025-12-25T13-32-ead8.json': '2025-12-25T13:32:00Z',
  });
  const [claude, codex, gemini] = findSources(home);

  assert.equal(claude.agent, 'claude-code');
  assert.equal(claude.sessions, 3);
  assert.equal(claude.first?.toISOString(), '2026-05-01T10:00:00.000Z');
  assert.equal(claude.last?.toISOString(), '2026-09-30T10:00:00.000Z');

  assert.equal(codex.sessions, 2);
  assert.equal(codex.first?.toISOString(), '2026-04-12T22:39:16.000Z');

  assert.equal(gemini.sessions, 1);
});

test('ignores files that are not sessions', () => {
  const home = fakeHome({
    '.claude/projects/-Users-ana-shop/0b1c.jsonl': '2026-05-01T10:00:00Z',
    '.claude/projects/-Users-ana-shop/0b1c/subagents/agent-1.jsonl': '2026-05-01T10:05:00Z', // part of 0b1c
    '.claude/projects/-Users-ana-shop/notes.md': '2026-05-01T10:00:00Z',
    '.codex/sessions/2026/04/12/history.json': '2026-04-12T10:00:00Z',
    '.gemini/tmp/77b2/logs.json': '2025-12-25T13:32:00Z',
    '.gemini/tmp/bin/rg': '2025-12-25T13:32:00Z',
  });
  const [claude, codex, gemini] = findSources(home);
  assert.equal(claude.sessions, 1);
  assert.equal(codex.sessions, 0);
  assert.equal(codex.found, true);
  assert.equal(gemini.sessions, 0);
});

test('reports agents whose folders are missing as not found', () => {
  const home = fakeHome({});
  for (const source of findSources(home)) {
    assert.equal(source.found, false);
    assert.equal(source.sessions, 0);
    assert.equal(source.first, undefined);
  }
});

test('never opens session files (an unreadable session still counts)', { skip: process.getuid?.() === 0 && 'root can read anything' }, () => {
  const home = fakeHome({ '.claude/projects/-Users-ana-shop/0b1c.jsonl': '2026-05-01T10:00:00Z' });
  const file = join(home, '.claude/projects/-Users-ana-shop/0b1c.jsonl');
  chmodSync(file, 0o000);
  try {
    assert.equal(findSources(home)[0].sessions, 1);
  } finally {
    chmodSync(file, 0o600);
  }
});

test('tilde() hides the home folder', () => {
  const home = join('/', 'home', 'ana');
  assert.equal(tilde(join(home, '.claude', 'projects'), home), '~/.claude/projects');
  const neighbour = join('/', 'home', 'anabel', 'x');
  assert.equal(tilde(neighbour, home), neighbour);
});
