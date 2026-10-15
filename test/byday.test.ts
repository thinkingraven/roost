import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readClaudeCode } from '../src/usage/claude-code.js';
import { readCodex } from '../src/usage/codex.js';
import { readGemini } from '../src/usage/gemini.js';
import type { SessionUsage } from '../src/usage/types.js';

// One session per agent that runs from 23:00 on 1 Oct to 01:00 on 2 Oct (UTC), then is resumed on 3 Oct.
const D1 = '2026-10-01T23:00:00Z', D2 = '2026-10-02T01:00:00Z', D3 = '2026-10-03T09:00:00Z';

function home() {
  const h = mkdtempSync(join(tmpdir(), 'roost-byday-'));
  const repo = join(h, 'code', 'app');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const write = (rel: string, text: string) => { const p = join(h, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
  const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 5 };
  const a = (uuid: string, ts: string, id: string, skill: string) => ({ type: 'assistant', uuid, sessionId: 'c1', cwd: repo, timestamp: ts, requestId: id, message: { role: 'assistant', id, usage, content: [{ type: 'tool_use', id: `t-${uuid}`, name: 'Skill', input: { skill } }] } });
  write('.claude/projects/-code-app/c1.jsonl', [a('1', D1, 'm1', 'review'), a('2', D2, 'm2', 'review'), a('3', D3, 'm3', 'deploy')].map((l) => JSON.stringify(l)).join('\n') + '\n');

  const u = (input: number, total: number) => ({ input_tokens: input, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total });
  const line = (ts: string, type: string, payload: object) => JSON.stringify({ timestamp: ts, type, payload });
  const count = (ts: string, total: number, last: number) => line(ts, 'event_msg', { type: 'token_count', info: { total_token_usage: u(total, total), last_token_usage: u(last, last) } });
  write('.codex/sessions/2026/10/01/rollout-2026-10-01T23-00-00-x1.jsonl', [
    line(D1, 'session_meta', { id: 'x1', cwd: repo, timestamp: D1 }),
    line(D1, 'response_item', { type: 'function_call', name: 'exec_command', arguments: '{}', call_id: 'k1' }),
    count(D1, 100, 100),
    count(D2, 100, 100),                 // a repeat of the total just after midnight: not new tokens
    line(D2, 'response_item', { type: 'function_call', name: 'exec_command', arguments: '{}', call_id: 'k2' }),
    count(D2, 150, 50),
    count(D3, 180, 30),
  ].join('\n') + '\n');

  const tokens = (input: number) => ({ input, output: 1, cached: 0, thoughts: 0, tool: 0, total: input + 1 });
  write('.gemini/tmp/app/.project_root', repo);
  write('.gemini/tmp/app/chats/session-2026-10-01T23-00-g1.json', JSON.stringify({ sessionId: 'g1', projectHash: 'x', startTime: D1, lastUpdated: D3, messages: [
    { id: 'a', timestamp: D1, type: 'gemini', tokens: tokens(10), toolCalls: [{ id: 'q1', name: 'read_file', args: {} }] },
    { id: 'b', timestamp: D2, type: 'gemini', tokens: tokens(20), toolCalls: [{ id: 'q2', name: 'activate_skill', args: { name: 'pdf' } }] },
    { id: 'c', timestamp: D3, type: 'gemini', tokens: tokens(40), toolCalls: [] },
  ] }));
  write('.gemini/tmp/app/logs.json', JSON.stringify([{ sessionId: 'g1', messageId: 0, timestamp: D2, type: 'user', message: '/review' }]));
  return h;
}

const byDay = (sessions: SessionUsage[]) => Object.fromEntries(sessions.map((s) => [s.day, s]));
const total = (sessions: SessionUsage[]) => sessions.reduce((n, s) => n + s.tokens.input + s.tokens.cacheRead + s.tokens.output, 0);

test('by day: each agent splits a session at midnight, and the days add up to the whole', async () => {
  const h = home();
  for (const read of [readClaudeCode, readCodex, readGemini]) {
    const whole = await read(h);
    const split = await read(h, undefined, { byDay: true });
    assert.equal(whole.sessions.length, 1, read.name);
    assert.deepEqual(split.sessions.map((s) => s.day).sort(), ['2026-10-01', '2026-10-02', '2026-10-03'], read.name);
    assert.equal(total(split.sessions), total(whole.sessions), `${read.name}: the days add up to the whole`);
    assert.ok(split.sessions.every((s) => s.id === whole.sessions[0].id && s.repo === whole.sessions[0].repo), `${read.name}: same session, same repo`);
  }
  const claude = byDay((await readClaudeCode(h, undefined, { byDay: true })).sessions);
  assert.deepEqual([[...claude['2026-10-01'].skills], [...claude['2026-10-02'].skills], [...claude['2026-10-03'].skills]], [[['review', 1]], [['review', 1]], [['deploy', 1]]]);

  const codex = byDay((await readCodex(h, undefined, { byDay: true })).sessions);
  assert.deepEqual([codex['2026-10-01'].tokens.input, codex['2026-10-02'].tokens.input, codex['2026-10-03'].tokens.input], [100, 50, 30], 'the repeat at midnight adds nothing');
  assert.deepEqual([[...codex['2026-10-01'].tools], [...codex['2026-10-02'].tools]], [[['exec_command', 1]], [['exec_command', 1]]]);

  const gemini = byDay((await readGemini(h, undefined, { byDay: true })).sessions);
  assert.deepEqual([[...gemini['2026-10-02'].skills], [...gemini['2026-10-02'].commands]], [[['pdf', 1]], [['/review', 1]]]);
});

test('by day: a window of whole days, read on different days, never counts twice', async () => {
  const h = home();
  for (const read of [readClaudeCode, readCodex, readGemini]) {
    const day = async (from: string, to: string) => (await read(h, new Date(from), { byDay: true, until: new Date(to) })).sessions;
    const d1 = await day('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
    const d2 = await day('2026-10-02T00:00:00Z', '2026-10-03T00:00:00Z');
    const d3 = await day('2026-10-03T00:00:00Z', '2026-10-04T00:00:00Z');
    assert.deepEqual([d1, d2, d3].map((s) => s.map((x) => x.day)), [['2026-10-01'], ['2026-10-02'], ['2026-10-03']], read.name);
    const all = (await read(h, undefined, { byDay: true })).sessions;
    assert.equal(total([...d1, ...d2, ...d3]), total(all), `${read.name}: three daily sends add up to the whole`);
  }
});
