#!/usr/bin/env node
// Writes a fictional "acme" team's agent logs under <dir>, in each agent's real layout, for screenshots
// and for trying roost without your own logs:
//
//   node scripts/demo-home.mjs /tmp/acme
//   node dist/src/cli.js usage --home /tmp/acme --since all
//   node scripts/demo-home.mjs /tmp/acme-2 7        (a second teammate, from another seed)
//
// Everything is made up and deterministic (seeded) other than the dates, which span the ~28 days
// up to yesterday, recomputed every run: most log stores (Loki among them, including Grafana
// Cloud's) reject entries more than about a week old, so `roost export --send` needs fresh dates
// to actually land anywhere outside a local, relaxed test instance.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: node scripts/demo-home.mjs <dir>\n');
  process.exit(2);
}

// mulberry32: 32-bit integer maths only, so the sequence never loses precision
let seed = Number(process.argv[3] ?? 20261011);   // another seed makes another made-up teammate
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** Write a file and date it like the agent would have (its last entry). */
const writeDated = (path, body, at) => {
  writeFileSync(path, body);
  utimesSync(path, new Date(at), new Date(at));
};
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (list) => list[Math.floor(rand() * list.length)];
const hex = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

// The same ~28.4 day span this demo has always covered, ending yesterday at 18:00 UTC — recomputed
// every run, so the dates are never more than a day stale.
const SPAN = Date.UTC(2026, 9, 10, 18) - Date.UTC(2026, 8, 12, 8);
const now = new Date();
const END = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 18);
const START = END - SPAN;

// Sessions per repo, then what the team ran: name → [total, repos it runs in].
const REPOS = { shop: 14, api: 10, payments: 7, mobile: 5, data: 3, infra: 2 };
const ALL = Object.keys(REPOS);
const SKILLS = {
  'code-review': [31, ['shop', 'api', 'payments', 'mobile']],
  'pr-summary': [14, ['shop', 'api', 'payments']],
  'write-tests': [9, ['shop', 'api']],
  'release-notes': [6, ['mobile']],
  'commit-message': [5, ['shop', 'data']],
  'db-migration': [3, ['data', 'api']],
  'deploy-check': [2, ['infra']],
  changelog: [1, ['payments']],
};
const SUBAGENTS = {
  Explore: [12, ALL],
  'general-purpose': [7, ['shop', 'api', 'payments']],
  'code-reviewer': [4, ['shop', 'payments']],
  'test-runner': [2, ['api']],
};
const MCP = {
  github: [{ get_file_contents: 71, create_pull_request: 64, list_issues: 52, create_issue: 31, search_code: 29, get_pull_request: 24, add_issue_comment: 9, list_commits: 6, merge_pull_request: 2 }, ['shop', 'api', 'payments', 'mobile']],
  linear: [{ list_issues: 38, create_issue: 27, update_issue: 21, get_issue: 8, add_comment: 2 }, ['shop', 'api']],
  sentry: [{ get_issue: 12, search_events: 6 }, ['payments']],
};
const COMMANDS = {
  '/deploy': [15, ['shop']],
  '/triage': [8, ['api', 'shop']],
  '/model': [9, ALL],
  '/clear': [6, ALL],
  '/compact': [4, ALL],
};
const TOOLS = { Bash: 3912, Edit: 1204, Read: 966, Write: 412, Grep: 380, Glob: 211, WebFetch: 74, TodoWrite: 58 };

// Sessions, each with a queue of things that happen in it.
const sessions = [];
for (const [repo, n] of Object.entries(REPOS)) {
  const root = join(dir, 'acme', repo);
  mkdirSync(join(root, '.git'), { recursive: true });
  for (let i = 0; i < n; i++) {
    sessions.push({ id: uuid(), repo, cwd: rand() < 0.3 ? join(root, 'src') : root, start: START + rand() * (END - START), events: [] });
  }
}
sessions.sort((a, b) => a.start - b.start);
const inRepos = (repos) => sessions.filter((s) => repos.includes(s.repo));
const spread = (total, repos, make) => {
  const pool = inRepos(repos);
  for (let i = 0; i < total; i++) pick(pool).events.push(make());
};

for (const [name, [total, repos]] of Object.entries(SKILLS)) spread(total, repos, () => ({ tool: 'Skill', input: { skill: name, args: 'demo' } }));
for (const [type, [total, repos]] of Object.entries(SUBAGENTS)) spread(total, repos, () => ({ tool: 'Agent', input: { subagent_type: type, description: 'demo', prompt: 'Demo task.' } }));
for (const [server, [tools, repos]] of Object.entries(MCP)) {
  for (const [tool, total] of Object.entries(tools)) spread(total, repos, () => ({ tool: `mcp__${server}__${tool}`, input: {} }));
}
for (const [command, [total, repos]] of Object.entries(COMMANDS)) spread(total, repos, () => ({ command }));
for (const [tool, total] of Object.entries(TOOLS)) spread(total, ALL, () => ({ tool, input: {} }));

let responses = 0;
const usage = (turn) => ({
  input_tokens: int(3, 40),
  cache_creation_input_tokens: int(400, 5200),
  cache_read_input_tokens: Math.min(180000, 22000 + turn * int(120, 900)),
  output_tokens: int(60, 1600),
});
const base = (s, at) => ({ sessionId: s.id, cwd: s.cwd, gitBranch: 'main', version: '2.1.0', userType: 'external', timestamp: new Date(at).toISOString(), uuid: uuid() });

let files = 0;
for (const s of sessions) {
  // shuffle so tool calls, commands and skills interleave
  for (let i = s.events.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [s.events[i], s.events[j]] = [s.events[j], s.events[i]];
  }
  const lines = [];
  const subagentLines = [];
  let at = s.start;
  lines.push({ ...base(s, at), type: 'user', message: { role: 'user', content: 'Demo prompt for the acme team.' } });
  s.events.forEach((e, turn) => {
    at += int(4, 70) * 1000;
    if (e.command) {
      lines.push({ ...base(s, at), type: 'user', message: { role: 'user', content: `<command-name>${e.command}</command-name><command-message>${e.command.slice(1)}</command-message><command-args></command-args>` } });
      return;
    }
    // Claude Code logs one response once per content block, each copy with the same usage
    const id = `msg_demo_${String(++responses).padStart(6, '0')}`;
    const u = usage(turn);
    const reply = { role: 'assistant', id, model: 'claude-demo', usage: u };
    lines.push({ ...base(s, at), type: 'assistant', requestId: `req_${id}`, message: { ...reply, content: [{ type: 'thinking', thinking: 'Demo.' }] } });
    const callId = `toolu_demo_${responses}`;
    lines.push({ ...base(s, at), type: 'assistant', requestId: `req_${id}`, message: { ...reply, content: [{ type: 'tool_use', id: callId, name: e.tool, input: e.input }] } });
    lines.push({ ...base(s, at + 800), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: 'Demo result.' }] } });
    if (e.tool === 'Agent') {
      // the subagent's own log: a couple of reads under the same session
      for (let k = 0; k < 2; k++) {
        const sid = `msg_demo_${String(++responses).padStart(6, '0')}`;
        subagentLines.push({ ...base(s, at + 1000 * (k + 1)), type: 'assistant', isSidechain: true, requestId: `req_${sid}`, message: { role: 'assistant', id: sid, model: 'claude-demo', usage: usage(k), content: [{ type: 'tool_use', id: `toolu_demo_${responses}`, name: pick(['Read', 'Grep', 'Glob']), input: {} }] } });
      }
    }
  });
  const project = join(dir, '.claude', 'projects', `-acme-${s.repo}`);
  mkdirSync(project, { recursive: true });
  writeDated(join(project, `${s.id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', at);
  files++;
  if (subagentLines.length) {
    const sub = join(project, s.id, 'subagents');
    mkdirSync(sub, { recursive: true });
    writeDated(join(sub, `agent-${hex(16)}.jsonl`), subagentLines.map((l) => JSON.stringify(l)).join('\n') + '\n', at);
  }
}

// A few Codex and Gemini CLI sessions, so `roost sources` finds all three agents.
for (let i = 0; i < 6; i++) {
  const d = new Date(START + rand() * (END - START));
  const [y, m, dd] = [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')];
  const folder = join(dir, '.codex', 'sessions', String(y), m, dd);
  mkdirSync(folder, { recursive: true });
  writeDated(join(folder, `rollout-${d.toISOString().slice(0, 19).replace(/:/g, '-')}-${uuid()}.jsonl`), JSON.stringify({ timestamp: d.toISOString(), type: 'session_meta', payload: { cwd: join(dir, 'acme', 'api') } }) + '\n', d);
}
for (let i = 0; i < 2; i++) {
  const d = new Date(END - (i + 1) * 86_400_000);
  const stamp = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T09-00`;
  const chats = join(dir, '.gemini', 'tmp', hex(16), 'chats');
  mkdirSync(chats, { recursive: true });
  writeDated(join(chats, `session-${stamp}-${hex(4)}.json`), JSON.stringify({ sessionId: uuid(), messages: [] }) + '\n', d);
}

process.stdout.write(`Wrote ${files} demo Claude Code sessions for ${ALL.length} acme repos, plus Codex and Gemini CLI sessions, under ${dir}\n`);
