import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readCodex } from '../src/usage/codex.js';

// Synthetic Codex rollouts in the shapes of codex-rs (0.119 and current). Every text a report must never show contains "SECRET".
const line = (timestamp: string, type: string, payload: object) => JSON.stringify({ timestamp, type, payload });
const usage = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 1, total_tokens: input + output });
const tokenCount = (ts: string, total: ReturnType<typeof usage>, last: ReturnType<typeof usage>) =>
  line(ts, 'event_msg', { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 272000 }, rate_limits: null });
const meta = (ts: string, id: string, cwd: string, extra: object = {}) =>
  line(ts, 'session_meta', { id, session_id: id, timestamp: ts, cwd, originator: 'codex_cli_rs', cli_version: '0.162.0', source: 'cli', history_mode: 'legacy', git: { commit_hash: 'abc', branch: 'main', repository_url: 'https://example.com/SECRET.git' }, ...extra });
const call = (ts: string, name: string, callId: string, extra: object = {}) =>
  line(ts, 'response_item', { type: 'function_call', name, arguments: '{"cmd":"SECRET-COMMAND"}', call_id: callId, ...extra });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'roost-codex-'));
  const shop = join(home, 'code', 'shop');
  mkdirSync(join(shop, '.git'), { recursive: true });
  const write = (rel: string, lines: string[]) => {
    const path = join(home, '.codex', rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  };
  const d = '2026-10-01T10:00:';

  write('sessions/2026/10/01/rollout-2026-10-01T10-00-00-t1.jsonl', [
    meta(`${d}00Z`, 't1', join(shop, 'src')),
    line(`${d}01Z`, 'turn_context', { cwd: shop, model: 'gpt-5.5', effort: 'medium' }),
    line(`${d}02Z`, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SECRET-PROMPT' }] }),
    line(`${d}02Z`, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<skill>\n<name>pdf-tools</name>\n<path>/SECRET/skills/pdf-tools/SKILL.md</path>\nSECRET-SKILL-BODY\n</skill>' }] }),
    line(`${d}02Z`, 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>catalog, not a use</skills_instructions>' }] }),
    line(`${d}03Z`, 'response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'SECRET-REASONING' }] }),
    call(`${d}04Z`, 'exec_command', 'c1'),
    line(`${d}04Z`, 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'SECRET-OUTPUT' }),
    line(`${d}05Z`, 'response_item', { type: 'custom_tool_call', name: 'apply_patch', input: 'SECRET-PATCH', call_id: 'c2', status: 'completed' }),
    line(`${d}05Z`, 'response_item', { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'SECRET-QUERY' } }),
    call(`${d}06Z`, 'get_item', 'c3', { namespace: 'mcp__demo_srv' }),
    line(`${d}07Z`, 'event_msg', { type: 'mcp_tool_call_end', call_id: 'c3', invocation: { server: 'demo-srv', tool: 'get_item', arguments: { id: 'SECRET' } } }),
    call(`${d}08Z`, 'list', 'c4', { namespace: 'mcp__my_srv' }),   // no end event: the namespace is the best guess
    call(`${d}09Z`, 'spawn_agent', 'c5', { namespace: 'multi_agent_v1', arguments: '{"agent_type":"reviewer","message":"SECRET-TASK"}' }),
    call(`${d}09Z`, 'spawn_agent', 'c6', { arguments: '{"task_name":"x","message":"SECRET"}' }),
    tokenCount(`${d}10Z`, usage(1000, 800, 50), usage(1000, 800, 50)),
    tokenCount(`${d}10Z`, usage(1000, 800, 50), usage(1000, 800, 50)),            // a repeat
    line(`${d}11Z`, 'event_msg', { type: 'token_count', info: null, rate_limits: null }),
    tokenCount(`${d}12Z`, usage(1600, 1200, 80), usage(600, 400, 30)),
    tokenCount(`${d}13Z`, { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 272000 }, usage(10, 0, 0)), // window reset
    tokenCount(`${d}14Z`, usage(300, 100, 20), usage(300, 100, 20)),
    line(`${d}15Z`, 'event_msg', { type: 'entered_review_mode', target: 'SECRET' }),
    'not json {',
  ]);

  // A subagent's own thread: counted into its parent t1.
  write('sessions/2026/10/01/rollout-2026-10-01T10-00-20-t2.jsonl', [
    meta(`${d}20Z`, 't2', shop, { source: { subagent: { thread_spawn: { parent_thread_id: 't1', depth: 1, agent_role: 'reviewer' } } }, agent_role: 'reviewer', parent_thread_id: 't1' }),
    call(`${d}21Z`, 'exec_command', 'c7'),
    tokenCount(`${d}22Z`, usage(200, 0, 10), usage(200, 0, 10)),
  ]);

  // A legacy fork of t1: its copy of the parent is skipped; only what follows counts.
  write('sessions/2026/10/01/rollout-2026-10-01T10-00-40-t3.jsonl', [
    meta(`${d}40Z`, 't3', shop, { forked_from_id: 't1' }),
    meta(`${d}00Z`, 't1', join(shop, 'src')),
    call(`${d}04Z`, 'exec_command', 'c1'),
    tokenCount(`${d}14Z`, usage(300, 100, 20), usage(300, 100, 20)),
    line(`${d}41Z`, 'event_msg', { type: 'thread_settings_applied' }),
    call(`${d}42Z`, 'update_plan', 'c8'),
    tokenCount(`${d}43Z`, usage(500, 200, 40), usage(200, 100, 20)),
  ]);

  // Newer Codex: token_usage_record lines win over token_count, each response once.
  write('archived_sessions/rollout-2026-10-02T09-00-00-t4.jsonl', [
    meta('2026-10-02T09:00:00Z', 't4', shop),
    tokenCount('2026-10-02T09:00:01Z', usage(999, 0, 999), usage(999, 0, 999)),
    line('2026-10-02T09:00:02Z', 'token_usage_record', { thread_id: 't4', response_id: 'r1', usage: usage(100, 50, 10) }),
    line('2026-10-02T09:00:03Z', 'token_usage_record', { thread_id: 't4', response_id: 'r1', usage: usage(100, 50, 10) }),
    line('2026-10-02T09:00:04Z', 'token_usage_record', { thread_id: 't4', response_id: 'r2', usage: { ...usage(40, 0, 5), cache_write_input_tokens: 30 } }),
  ]);

  const old = write('sessions/2026/08/01/rollout-2026-08-01T10-00-00-t5.jsonl', [meta('2026-08-01T10:00:00Z', 't5', shop), call('2026-08-01T10:00:01Z', 'exec_command', 'c9')]);
  utimesSync(old, new Date('2026-08-01'), new Date('2026-08-01'));
  return { home, shop };
}

test('codex: tool calls, skills, MCP, subagents and tokens, with forks and subagent threads counted once', async () => {
  const { home, shop } = fixture();
  const { sessions, skipped } = await readCodex(home, new Date('2026-09-15T00:00:00Z'));
  assert.deepEqual(sessions.map((s) => s.id).sort(), ['t1', 't3', 't4'], 'the subagent thread folds into t1; the old one is outside the window');
  const t1 = sessions.find((s) => s.id === 't1')!;
  assert.equal(t1.agent, 'codex');
  assert.equal(t1.repo, shop);
  assert.deepEqual(Object.fromEntries(t1.tools), { exec_command: 2, apply_patch: 1, web_search: 1 }, 'its own exec_command and the subagent\'s');
  assert.deepEqual([...t1.skills], [['pdf-tools', 1]], 'the injected <skill> block, not the catalog');
  assert.deepEqual(Object.fromEntries(t1.mcp), { 'demo-srv/get_item': 1, 'my_srv/list': 1 }, 'the end event\'s real server name wins');
  assert.deepEqual(Object.fromEntries(t1.subagents), { reviewer: 1, default: 1 });
  assert.deepEqual([...t1.commands], [['/review', 1]]);
  // last_token_usage summed when the total changes: (1000/800/50) + (600/400/30) + (300/100/20) + subagent (200/0/10); the repeat, null and reset add nothing.
  assert.deepEqual(t1.tokens, { input: 200 + 200 + 200 + 200, cacheWrite: 0, cacheRead: 800 + 400 + 100, output: 50 + 30 + 20 + 10 });

  const t3 = sessions.find((s) => s.id === 't3')!;
  assert.deepEqual(Object.fromEntries(t3.tools), { update_plan: 1 }, 'the copied parent lines are skipped');
  assert.deepEqual(t3.tokens, { input: 100, cacheWrite: 0, cacheRead: 100, output: 20 });

  const t4 = sessions.find((s) => s.id === 't4')!;
  assert.deepEqual(t4.tokens, { input: 50 + 40, cacheWrite: 30, cacheRead: 50, output: 15 }, 'records win; each response once');
  assert.equal(skipped, 1);
  assert.ok(!JSON.stringify(sessions, (_k, v) => (v instanceof Map ? [...v] : v)).includes('SECRET'), 'no text, arguments, paths or URLs from the logs');
});

test('codex: no logs, no sessions', async () => {
  assert.deepEqual(await readCodex(mkdtempSync(join(tmpdir(), 'roost-codex-empty-'))), { sessions: [], skipped: 0 });
});
