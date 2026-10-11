import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClaudeCode, resolveRepo } from '../src/usage/claude-code.js';
import { aggregate } from '../src/usage/aggregate.js';
import { useColor } from '../src/report/style.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const env = { ...process.env, FORCE_COLOR: '', NO_COLOR: '' };
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
const runWith = (extra: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...env, ...extra } });

// Synthetic logs in Claude Code's shape. Every string a report must never show contains "SECRET".
const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 };
const user = (uuid: string, sessionId: string, cwd: string, timestamp: string, content: unknown) =>
  ({ type: 'user', uuid, sessionId, cwd, timestamp, message: { role: 'user', content } });
const assistant = (uuid: string, sessionId: string, cwd: string, timestamp: string, id: string, block: unknown) =>
  ({ type: 'assistant', uuid, sessionId, cwd, timestamp, requestId: `req-${id}`, message: { role: 'assistant', id, model: 'claude-x', usage, content: [block] } });
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'roost-usage-'));
  const shop = join(home, 'code', 'shop');
  const api = join(home, 'code', 'api');
  mkdirSync(join(shop, '.git'), { recursive: true });
  mkdirSync(join(api, '.git'), { recursive: true });
  const shopSrc = join(shop, 'src');
  const shopWorktree = join(shop, '.claude', 'worktrees', 'feature-x');
  const write = (rel: string, lines: unknown[]) => {
    const path = join(home, '.claude', 'projects', rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  };
  const t = '2026-10-01T10:00:00Z';

  write('-code-shop/s-a.jsonl', [
    user('u1', 's-a', shopSrc, t, '<command-name>/deploy</command-name><command-message>deploy</command-message><command-args>SECRET-COMMAND-ARGS</command-args>'),
    user('u2', 's-a', shopSrc, t, '<command-name>/model</command-name>'),
    user('u3', 's-a', shopSrc, t, [{ type: 'text', text: 'SECRET-PROMPT-TEXT, please review this' }]),
    // one response logged as three entries, each carrying the same usage: tokens count once
    assistant('a1', 's-a', shopSrc, t, 'm1', { type: 'thinking', thinking: 'SECRET-THINKING' }),
    assistant('a2', 's-a', shopSrc, t, 'm1', { type: 'text', text: 'SECRET-REPLY-TEXT' }),
    assistant('a3', 's-a', shopSrc, t, 'm1', toolUse('t1', 'Skill', { skill: 'code-review', args: 'SECRET-SKILL-ARGS' })),
    assistant('a4', 's-a', shopSrc, t, 'm2', toolUse('t2', 'Agent', { subagent_type: 'Explore', prompt: 'SECRET-SUBAGENT-PROMPT' })),
    assistant('a5', 's-a', shopSrc, t, 'm3', toolUse('t3', 'mcp__github__create_issue', { title: 'SECRET-ISSUE' })),
    assistant('a6', 's-a', shopSrc, t, 'm3', toolUse('t4', 'mcp__github__list_prs', {})),
    assistant('a7', 's-a', shopSrc, t, 'm3', toolUse('t5', 'Bash', { command: 'SECRET-SHELL-COMMAND' })),
    assistant('a7', 's-a', shopSrc, t, 'm3', toolUse('t5', 'Bash', { command: 'SECRET-SHELL-COMMAND' })), // copied line
    // a tool result that merely mentions a command tag is not a command
    user('u4', 's-a', shopSrc, t, [{ type: 'tool_result', tool_use_id: 't5', content: '<command-name>/fake</command-name> SECRET-RESULT' }]),
    { type: 'ai-title', sessionId: 's-a', aiTitle: 'SECRET-TITLE' },
    'this line is not json {',
    // older than the window
    assistant('a8', 's-a', shopSrc, '2026-08-01T10:00:00Z', 'm-old', toolUse('t-old', 'Skill', { skill: 'old-skill' })),
  ]);
  // a subagent's log, folded into its parent session
  write('-code-shop/s-a/subagents/agent-1.jsonl', [
    { ...assistant('b1', 's-a', shopSrc, t, 'm4', toolUse('t6', 'Skill', { skill: 'code-review' })), isSidechain: true },
    { ...assistant('b2', 's-a', shopSrc, t, 'm5', toolUse('t7', 'mcp__github__create_issue', {})), isSidechain: true },
  ]);
  // a session in a worktree of the same repo
  write('-code-shop--claude-worktrees-feature-x/s-c.jsonl', [
    assistant('c1', 's-c', shopWorktree, '2026-10-02T09:00:00Z', 'm6', toolUse('t8', 'Skill', { skill: 'pr-summary' })),
  ]);
  // another repo, with a skill name trying to smuggle in a terminal escape code
  write('-code-api/s-d.jsonl', [
    assistant('d1', 's-d', api, '2026-10-03T09:00:00Z', 'm7', toolUse('t9', 'Skill', { skill: '\u001b[31mred' })),
  ]);
  return { home, shop, api };
}

const SINCE = new Date('2026-09-01T00:00:00Z');

test('counts skills, subagents, MCP tools, commands and built-in tools', async () => {
  const { home } = fixture();
  const { sessions, skipped } = await readClaudeCode(home, SINCE);
  const r = aggregate(sessions, skipped, SINCE);

  assert.equal(r.sessions, 3);
  assert.deepEqual(r.skills.map((s) => [s.name, s.count, s.sessions, s.repos]), [
    ['code-review', 2, 1, 1],
    ['?[31mred', 1, 1, 1],
    ['pr-summary', 1, 1, 1],
  ]);
  assert.deepEqual(r.subagents.map((s) => [s.name, s.count]), [['Explore', 1]]);
  assert.equal(r.mcp.length, 1);
  assert.equal(r.mcp[0].server, 'github');
  assert.equal(r.mcp[0].calls, 3);
  assert.deepEqual(r.mcp[0].tools.map((t) => [t.name, t.count]), [['create_issue', 2], ['list_prs', 1]]);
  assert.deepEqual(r.commands.map((c) => [c.name, c.count]), [['/deploy', 1], ['/model', 1]]);
  assert.deepEqual(r.tools.map((c) => [c.name, c.count]), [['Bash', 1]]);
  assert.equal(skipped, 1);
});

test('counts each response\'s tokens once, subagents included', async () => {
  const { home } = fixture();
  const { sessions } = await readClaudeCode(home, SINCE);
  const a = sessions.find((s) => s.id === 's-a');
  // m1, m2, m3 in the main log and m4, m5 in the subagent log: 5 responses
  assert.deepEqual(a?.tokens, { input: 50, cacheWrite: 500, cacheRead: 5000, output: 25 });
});

test('attributes sessions to repos, folding worktrees into their repo', async () => {
  const { home, shop, api } = fixture();
  const { sessions, skipped } = await readClaudeCode(home, SINCE);
  const r = aggregate(sessions, skipped, SINCE);
  assert.deepEqual(r.repos.map((p) => [p.repo, p.sessions]), [[shop, 2], [api, 1]]);
  assert.equal(resolveRepo(join(shop, 'src', 'deep')), shop);
});

test('--since all includes older entries', async () => {
  const { home } = fixture();
  const { sessions, skipped } = await readClaudeCode(home);
  const r = aggregate(sessions, skipped);
  assert.ok(r.skills.some((s) => s.name === 'old-skill'));
});

test('reports never contain message text, tool inputs or the home path', () => {
  const { home } = fixture();
  for (const format of ['json', 'terminal']) {
    const r = run('usage', '--home', home, '--since', '2026-09-01', '--format', format);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('SECRET'), `${format} output leaked text`);
    assert.ok(!r.stdout.includes(home), `${format} output leaked the home path`);
    assert.ok(!r.stdout.includes('\u001b'), `${format} output carries an escape code`);
  }
});

test('usage --format json shape', () => {
  const { home } = fixture();
  const out = JSON.parse(run('usage', '--home', home, '--since', '2026-09-01', '--format', 'json').stdout);
  assert.equal(out.agent, 'claude-code');
  assert.equal(out.window, 'since 2026-09-01');
  assert.equal(out.sessions, 3);
  assert.deepEqual(out.repos.map((p: { repo: string }) => p.repo), ['~/code/shop', '~/code/api']);
  assert.deepEqual(out.commands.map((c: { name: string; builtIn: boolean }) => [c.name, c.builtIn]), [['/deploy', false], ['/model', true]]);
});

test('usage terminal report and an empty window', () => {
  const { home } = fixture();
  const r = run('usage', '--home', home, '--since', '2026-09-01');
  assert.match(r.stdout, /roost\. v[\d.]+ {2}· {2}Claude Code {2}· {2}since 2026-09-01 {2}· {2}3 sessions in 2 repos/);
  assert.match(r.stdout, /SKILLS\s+4 runs of 3 skills/);
  assert.match(r.stdout, /MCP SERVERS\s+3 calls to 1 server/);
  assert.match(r.stdout, /Built in: \/model 1/);
  assert.match(r.stdout, /NEXT STEPS\n {2}→ 2 skills ran just once \(since 2026-09-01\): \?\[31mred, pr-summary\. Check they still earn their place\./);
  const empty = run('usage', '--home', mkdtempSync(join(tmpdir(), 'roost-empty-')));
  assert.match(empty.stdout, /Claude Code {2}· {2}last 30 days/);
  assert.match(empty.stdout, /No Claude Code sessions found\./);
});

test('usage option errors exit 2', () => {
  assert.equal(run('usage', '--since', 'yesterday').status, 2);
  assert.equal(run('usage', '--since', '0d').status, 2);
  assert.equal(run('usage', '--top', '0').status, 2);
});

test('colours only on a terminal or with FORCE_COLOR, never with NO_COLOR or --no-color', () => {
  const { home } = fixture();
  const args = ['usage', '--home', home, '--since', '2026-09-01'];
  assert.ok(!run(...args).stdout.includes('\x1b['), 'piped output stays plain');
  const forced = runWith({ FORCE_COLOR: '1' }, ...args).stdout;
  assert.ok(forced.includes('\x1b[38;5;214m'), 'FORCE_COLOR paints the amber accent');
  assert.ok(!forced.includes('\u001b[31mred'), 'a name\'s own escape code never survives, even in colour');
  assert.ok(!forced.includes('SECRET'));
  assert.ok(!runWith({ FORCE_COLOR: '1', NO_COLOR: '1' }, ...args).stdout.includes('\x1b['));
  assert.ok(!runWith({ FORCE_COLOR: '1' }, ...args, '--no-color').stdout.includes('\x1b['));
});

test('useColor follows --no-color, NO_COLOR, FORCE_COLOR and the terminal', () => {
  assert.equal(useColor(false, {}, true), true);
  assert.equal(useColor(false, {}, false), false);
  assert.equal(useColor(true, {}, true), false);
  assert.equal(useColor(false, { NO_COLOR: '1' }, true), false);
  assert.equal(useColor(false, { FORCE_COLOR: '1' }, false), true);
  assert.equal(useColor(false, { FORCE_COLOR: '0' }, false), false);
});
