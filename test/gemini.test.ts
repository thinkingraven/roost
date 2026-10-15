import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readGemini } from '../src/usage/gemini.js';

// Synthetic Gemini CLI data in the shapes of v0.22 (.json) and current versions (.jsonl). Every text a report must never show contains "SECRET".
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const tokens = (input: number, cached: number, output: number, thoughts = 0, tool = 0) => ({ input, output, cached, thoughts, tool, total: input + output + thoughts + tool });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'roost-gemini-'));
  const demo = join(home, 'code', 'demo');
  const legacy = join(home, 'code', 'legacy');
  mkdirSync(join(demo, '.git'), { recursive: true });
  mkdirSync(join(legacy, '.git'), { recursive: true });
  const write = (rel: string, data: unknown) => {
    const path = join(home, '.gemini', rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data));
    return path;
  };

  // A: v0.22 session in a hash folder, its root known from projects.json; also copied into the slug folder by a migration.
  const a = {
    sessionId: 'aaaa1111', projectHash: sha(legacy), startTime: '2026-10-01T10:00:00.000Z', lastUpdated: '2026-10-01T10:05:00.000Z',
    messages: [
      { id: 'm1', timestamp: '2026-10-01T10:00:05Z', type: 'user', content: 'SECRET-PROMPT' },
      { id: 'm2', timestamp: '2026-10-01T10:00:09Z', type: 'gemini', content: 'SECRET-REPLY', model: 'gemini-2.5-flash', thoughts: [{ subject: 'SECRET-THOUGHT', description: 'SECRET' }], tokens: tokens(1200, 1000, 40, 30), toolCalls: [
        { id: 'search_file_content-1-a', name: 'search_file_content', args: { pattern: 'SECRET-ARG' }, status: 'success', timestamp: '2026-10-01T10:00:09Z', displayName: 'SearchText', result: [{ functionResponse: { response: { output: 'SECRET-RESULT' } } }] },
        { id: 'create_issue-2-b', name: 'create_issue', args: { title: 'SECRET' }, status: 'success', timestamp: '2026-10-01T10:00:09Z', displayName: 'create_issue (github MCP Server)' },
        { id: 'delegate_to_agent-3-c', name: 'delegate_to_agent', args: { agent_name: 'codebase_investigator', objective: 'SECRET' }, status: 'success', timestamp: '2026-10-01T10:00:09Z' },
      ] },
      { id: 'm3', timestamp: '2026-10-01T10:01:00Z', type: 'info', content: 'SECRET-INFO' },
    ],
  };
  write(`tmp/${sha(legacy)}/chats/session-2026-10-01T10-00-aaaa1111.json`, a);
  write('tmp/legacy/chats/session-2026-10-01T10-00-aaaa1111.json', a);
  write('tmp/legacy/.project_root', legacy);
  write('projects.json', { projects: { [legacy]: 'legacy', [demo]: 'demo' } });

  // B: a current .jsonl session: the same message appended again with tokens, $set and $rewindTo lines, a skill, MCP and a subagent.
  const call = (id: string, name: string, args: unknown, extra: object = {}) => ({ id, name, args, status: 'success', timestamp: '2026-10-02T09:00:10Z', ...extra });
  const g1 = (withTokens: boolean) => ({
    id: 'g1', timestamp: '2026-10-02T09:00:10Z', type: 'gemini', content: 'SECRET-REPLY', model: 'gemini-3-pro', tokens: withTokens ? tokens(900, 600, 20, 10) : null,
    toolCalls: [
      call('mcp_gh_list_prs__x', 'mcp_gh_list_prs', { q: 'SECRET' }, { displayName: 'list_prs (gh_tools MCP Server)' }),
      ...(withTokens ? [call('activate_skill__y', 'activate_skill', { name: 'pdf' }), call('invoke_agent__z', 'invoke_agent', { agent_name: 'reviewer', prompt: 'SECRET-SUBAGENT-PROMPT' }, { agentId: 'cccc3333' })] : []),
    ],
  });
  write('tmp/demo/chats/session-2026-10-02T09-00-bbbb2222.jsonl', [
    { sessionId: 'bbbb2222', projectHash: sha(demo), startTime: '2026-10-02T09:00:00Z', lastUpdated: '2026-10-02T09:00:00Z' },
    { id: 'u1', timestamp: '2026-10-02T09:00:01Z', type: 'user', content: [{ text: 'SECRET-EXPANDED-PROMPT' }], displayContent: [{ text: '/git:commit SECRET-ARGS' }] },
    g1(false),
    g1(true),
    { $set: { lastUpdated: '2026-10-02T09:03:00Z' } },
    { $rewindTo: 'g1' },
    'not json {',
  ].map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  write('tmp/demo/.project_root', demo);

  // C: the subagent's transcript, counted into its parent session.
  write('tmp/demo/chats/bbbb2222/cccc3333.jsonl', [
    { sessionId: 'cccc3333', projectHash: sha(demo), startTime: '2026-10-02T09:00:11Z', lastUpdated: '2026-10-02T09:00:20Z', kind: 'subagent', directories: [demo] },
    { id: 's1', timestamp: '2026-10-02T09:00:15Z', type: 'gemini', content: 'SECRET-SUB-REPLY', model: 'gemini-3-flash', tokens: tokens(300, 0, 15), toolCalls: [call('glob__q', 'glob', { pattern: 'SECRET' })] },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  // D: raw input: only the first word, and only if it's a command, is kept.
  write('tmp/demo/logs.json', [
    { sessionId: 'bbbb2222', messageId: 0, timestamp: '2026-10-02T09:00:00Z', type: 'user', message: '/stats' },
    { sessionId: 'bbbb2222', messageId: 1, timestamp: '2026-10-02T09:00:01Z', type: 'user', message: '/git:commit SECRET-ARGS' },
    { sessionId: 'bbbb2222', messageId: 1, timestamp: '2026-10-02T09:00:01Z', type: 'user', message: '/git:commit SECRET-ARGS' },
    { sessionId: 'bbbb2222', messageId: 2, timestamp: '2026-10-02T09:00:02Z', type: 'user', message: '/Users/x/SECRET.ts explain' },
    { sessionId: 'bbbb2222', messageId: 3, timestamp: '2026-10-02T09:00:03Z', type: 'user', message: 'SECRET-PLAIN-PROMPT' },
  ]);

  // Not sessions: checkpoints, shell history, devtools logs, another product's data.
  write('tmp/demo/checkpoint-x.json', { messages: [{ id: 'q', type: 'gemini', content: 'SECRET' }] });
  write('tmp/demo/shell_history', 'SECRET-SHELL\n');
  write('antigravity/SECRET.pb', 'SECRET');

  // E: an old session outside the window.
  const old = write(`tmp/${sha(legacy)}/chats/session-2026-08-01T10-00-dddd4444.json`, { sessionId: 'dddd4444', projectHash: sha(legacy), startTime: '2026-08-01T10:00:00Z', lastUpdated: '2026-08-01T10:00:00Z', messages: [{ id: 'o1', timestamp: '2026-08-01T10:00:00Z', type: 'gemini', tokens: tokens(5, 0, 5), toolCalls: [{ id: 'o', name: 'read_file', args: {} }] }] });
  utimesSync(old, new Date('2026-08-01'), new Date('2026-08-01'));
  return { home, demo, legacy };
}

test('gemini: legacy and current sessions, united across a migration copy, with subagents counted in', async () => {
  const { home, demo, legacy } = fixture();
  const { sessions, skipped } = await readGemini(home, new Date('2026-09-15T00:00:00Z'));
  assert.equal(sessions.length, 2, 'the migration copy and the subagent file are not sessions of their own');
  const a = sessions.find((s) => s.id === 'aaaa1111')!;
  const b = sessions.find((s) => s.id === 'bbbb2222')!;
  assert.equal(a.repo, legacy, 'hash folder → projects.json');
  assert.equal(b.repo, demo, '.project_root');
  assert.equal(b.agent, 'gemini-cli');

  assert.deepEqual(a.tokens, { input: 200, cacheWrite: 0, cacheRead: 1000, output: 70 }, 'input excludes cached; thoughts count as output; counted once despite the copy');
  assert.deepEqual(a.preload, a.tokens, 'its only message is also its first');
  assert.deepEqual([...a.tools], [['search_file_content', 1]]);
  assert.deepEqual([...a.mcp], [['github/create_issue', 1]]);
  assert.deepEqual([...a.subagents], [['codebase_investigator', 1]]);

  assert.deepEqual(b.tokens, { input: 300 + 300, cacheWrite: 0, cacheRead: 600, output: 30 + 15 }, 'the last copy of g1 wins; the subagent adds its tokens');
  assert.deepEqual(b.preload, { input: 300, cacheWrite: 0, cacheRead: 600, output: 30 }, 'g1 alone: the subagent\'s own first turn never counts as preload');
  assert.deepEqual([...b.mcp], [['gh_tools/list_prs', 1]], 'server from displayName, even with an underscore');
  assert.deepEqual([...b.skills], [['pdf', 1]]);
  assert.deepEqual([...b.subagents], [['reviewer', 1]]);
  assert.deepEqual([...b.tools], [['glob', 1]], 'the subagent\'s own tool calls');
  assert.deepEqual([...b.commands].sort(), [['/git:commit', 1], ['/stats', 1]], 'first word only, deduped, paths and prompts ignored');
  assert.deepEqual([b.first?.toISOString(), b.last?.toISOString()], ['2026-10-02T09:00:01.000Z', '2026-10-02T09:00:15.000Z']);
  assert.equal(skipped, 1, 'the broken line is counted, not guessed at');
  assert.ok(!JSON.stringify(sessions, (_k, v) => (v instanceof Map ? [...v] : v)).includes('SECRET'), 'no text, arguments or paths from the logs');
});

test('gemini: all time includes old sessions; no data means no sessions', async () => {
  const { home } = fixture();
  const all = await readGemini(home);
  assert.equal(all.sessions.length, 3);
  const empty = mkdtempSync(join(tmpdir(), 'roost-gemini-empty-'));
  assert.deepEqual(await readGemini(empty), { sessions: [], skipped: 0 });
});

test('gemini: preload is the earliest message by timestamp, not by insertion order', async () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-gemini-'));
  const dir = join(home, '.gemini', 'tmp', 'solo', 'chats');
  mkdirSync(dir, { recursive: true });
  // Written out of chronological order: m2 (later) appears in the file before m1 (earlier).
  writeFileSync(join(dir, 'session-2026-10-05T10-00-ffff6666.jsonl'), [
    { sessionId: 'ffff6666', projectHash: '0'.repeat(64), startTime: '2026-10-05T10:00:00Z', lastUpdated: '2026-10-05T10:05:00Z' },
    { id: 'm2', timestamp: '2026-10-05T10:05:00Z', type: 'gemini', tokens: tokens(5, 0, 5) },
    { id: 'm1', timestamp: '2026-10-05T10:00:00Z', type: 'gemini', tokens: tokens(900, 600, 20, 10) },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  // A subagent transcript that starts even earlier than m1: it must still not win preload.
  mkdirSync(join(dir, 'ffff6666'), { recursive: true });
  writeFileSync(join(dir, 'ffff6666', 'sub.jsonl'), [
    { sessionId: 'sub', projectHash: '0'.repeat(64), startTime: '2026-10-05T09:00:00Z', lastUpdated: '2026-10-05T09:01:00Z', kind: 'subagent' },
    { id: 's1', timestamp: '2026-10-05T09:00:30Z', type: 'gemini', tokens: tokens(1, 0, 1) },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  const { sessions } = await readGemini(home);
  const s = sessions.find((x) => x.id === 'ffff6666')!;
  assert.deepEqual(s.preload, { input: 300, cacheWrite: 0, cacheRead: 600, output: 30 }, 'm1 (300/600/30), not m2 or the subagent');
});

test('gemini: a hash folder nobody can map back keeps its sessions, without a repo', async () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-gemini-'));
  const dir = join(home, '.gemini', 'tmp', 'f'.repeat(64), 'chats');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session-2026-10-03T10-00-eeee5555.json'), JSON.stringify({ sessionId: 'eeee5555', projectHash: 'f'.repeat(64), startTime: '2026-10-03T10:00:00Z', lastUpdated: '2026-10-03T10:00:00Z', messages: [{ id: 'x', timestamp: '2026-10-03T10:00:00Z', type: 'gemini', tokens: null, toolCalls: [] }] }));
  const { sessions } = await readGemini(home);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].repo, undefined);
});
