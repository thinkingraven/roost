import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge, parseRookery, InputError, type RookeryArtifact, type RookeryReport } from '../src/verdicts.js';
import { newSession, type SessionUsage } from '../src/usage/types.js';
import { renderVerdictsTerminal } from '../src/report/verdicts.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const HOME = '/home/dev';
const SHOP = `${HOME}/code/shop`;
const API = `${HOME}/code/api`;

function session(repo: string | undefined, used: { skills?: Record<string, number>; commands?: Record<string, number>; subagents?: Record<string, number> } = {}, day = '2026-10-01'): SessionUsage {
  const s = newSession('claude-code', Math.random().toString(36).slice(2));
  s.repo = repo;
  s.first = new Date(`${day}T09:00:00Z`);
  s.last = new Date(`${day}T10:00:00Z`);
  for (const [k, n] of Object.entries(used.skills ?? {})) s.skills.set(k, n);
  for (const [k, n] of Object.entries(used.commands ?? {})) s.commands.set(k, n);
  for (const [k, n] of Object.entries(used.subagents ?? {})) s.subagents.set(k, n);
  return s;
}
const art = (repo: string, relPath: string, name: string, kind = 'skill', extra: Partial<RookeryArtifact> = {}): RookeryArtifact => {
  const repoRoot = repo === '~' ? '~' : `~/code/${repo}`;
  return { id: `${repo}:${relPath}`, repo, repoRoot, relPath, agent: 'claude-code', kind, name, ...extra };
};
const report = (artifacts: RookeryArtifact[], extra: Partial<RookeryReport> = {}): RookeryReport =>
  ({ tool: { name: 'rookery', version: '0.7.2' }, scannedAt: '2026-10-14T00:00:00Z', artifacts, findings: [], clusters: [], ...extra });
const verdictOf = (r: ReturnType<typeof judge>, name: string) => r.judged.find((j) => j.name === name)!;

test('verdicts: keep what runs, retire what never does, and say when there is no data', () => {
  const r = judge(report([
    art('shop', '.claude/skills/code-review/SKILL.md', 'code-review'),
    art('shop', '.claude/skills/old-lint/SKILL.md', 'old-lint'),
    art('api', '.claude/skills/api-docs/SKILL.md', 'api-docs'),
  ]), [session(SHOP, { skills: { 'code-review': 3 } }), session(SHOP), session(`${HOME}/code/web`, { skills: { 'api-docs': 9 } })], HOME);
  assert.deepEqual([verdictOf(r, 'code-review').verdict, verdictOf(r, 'code-review').uses, verdictOf(r, 'code-review').sessions], ['keep', 3, 1]);
  assert.deepEqual([verdictOf(r, 'old-lint').verdict, verdictOf(r, 'old-lint').scopeSessions], ['retire', 2]);
  assert.equal(verdictOf(r, 'api-docs').verdict, 'no-data', 'a run in another repo does not count, and no session ran in api');
  assert.deepEqual(r.judged.map((j) => j.verdict), ['retire', 'keep', 'no-data'], 'ordered by what to do first');
});

test('verdicts: a skill runs by name, by folder name, or as a slash command; commands and subagents too', () => {
  const r = judge(report([
    art('shop', '.claude/skills/deploy-staging/SKILL.md', 'deploy'),
    art('shop', '.claude/skills/release/SKILL.md', 'release'),
    art('shop', '.claude/commands/frontend/component.md', 'component', 'command'),
    art('shop', '.claude/agents/reviewer.md', 'reviewer', 'subagent'),
  ]), [session(SHOP, { skills: { 'deploy-staging': 1, Release: 1 }, commands: { '/deploy': 2, '/frontend:component': 4, '/model': 1 }, subagents: { reviewer: 2, Explore: 5 } })], HOME);
  assert.equal(verdictOf(r, 'deploy').uses, 3, 'folder name and /name');
  assert.equal(verdictOf(r, 'release').uses, 1, 'names match regardless of case');
  assert.equal(verdictOf(r, 'component').uses, 4, 'commands in subfolders are /folder:name');
  assert.equal(verdictOf(r, 'reviewer').uses, 2);
  assert.deepEqual(r.unmatched, [], 'built-in commands and subagents are not "missing from the scan"');
});

test('verdicts: fix first when a used skill has quality or serious security findings', () => {
  const a = art('shop', '.claude/skills/fmt/SKILL.md', 'fmt');
  const b = art('shop', '.claude/skills/ship/SKILL.md', 'ship');
  const c = art('shop', '.claude/skills/docs/SKILL.md', 'docs');
  const findings = [
    { ruleId: 'RK-QLT-007', severity: 'low', title: 'Skill description is too short to match on', artifactId: a.id, confidence: 'high' },
    { ruleId: 'RK-QLT-008', severity: 'low', title: 'Frontmatter field looks misspelled', artifactId: a.id, confidence: 'high' },
    { ruleId: 'RK-EXE-004', severity: 'high', title: 'Agent permission checks bypassed', artifactId: b.id, confidence: 'high' },
    { ruleId: 'RK-EXE-001', severity: 'high', title: 'Pipes a download into a shell', artifactId: c.id, confidence: 'low' },
    { ruleId: 'RK-QLT-002', severity: 'info', title: 'Very large agent file', artifactId: c.id, confidence: 'high' },
    { ruleId: 'RK-SUP-002', severity: 'low', title: 'Global or unpinned package install', artifactId: c.id, confidence: 'high' },
  ];
  const r = judge(report([a, b, c], { findings }), [session(SHOP, { skills: { fmt: 1, ship: 1, docs: 1 } })], HOME);
  assert.deepEqual(verdictOf(r, 'fmt').issues, ['Skill description is too short to match on', 'Frontmatter field looks misspelled']);
  assert.equal(verdictOf(r, 'ship').verdict, 'improve');
  assert.equal(verdictOf(r, 'docs').verdict, 'keep', 'low-confidence, info-size and low security findings are not blockers');
});

test('verdicts: duplicates merge into the copy people use; installed copies are left alone', () => {
  const a = art('shop', '.claude/skills/review/SKILL.md', 'review');
  const b = art('shop', '.claude/skills/review-v2/SKILL.md', 'review-v2');
  const c = art('api', '.claude/skills/review/SKILL.md', 'review');
  const d = art('shop', '.claude/skills/pdf/SKILL.md', 'pdf');
  const e = art('api', '.claude/skills/pdf/SKILL.md', 'pdf');
  const clusters = [{ members: [a, b, c].map((x) => ({ artifactId: x.id })) }, { members: [d, e].map((x) => ({ artifactId: x.id })), syncedFrom: 'github.com/x/skills' }];
  const r = judge(report([a, b, c, d, e], { clusters }), [session(SHOP, { skills: { 'review-v2': 4, review: 1 } }), session(API)], HOME);
  const merged = r.judged.filter((j) => j.verdict === 'merge');
  assert.deepEqual(merged.map((j) => [j.repo, j.relPath, j.mergeInto!.relPath, j.mergeInto!.uses]).sort(), [
    ['~/code/api', '.claude/skills/review/SKILL.md', '.claude/skills/review-v2/SKILL.md', 4],
    ['~/code/shop', '.claude/skills/review/SKILL.md', '.claude/skills/review-v2/SKILL.md', 4],
  ]);
  assert.equal(r.judged.find((j) => j.name === 'review-v2')!.verdict, 'keep');
  assert.ok(!r.judged.some((j) => j.name === 'pdf' && j.verdict === 'merge'), 'synced installs are not team duplicates');
});

test('verdicts: personal skills win over project ones, linked installs count, and a used claude.ai copy is noted', () => {
  const r = judge(report([
    art('~', '.claude/skills/deploy/SKILL.md', 'deploy'),
    art('shop', '.claude/skills/deploy/SKILL.md', 'deploy'),
    art('~', '.agents/skills/find-docs/SKILL.md', 'find-docs', 'skill', { agent: 'agent-skills', links: [{ relPath: '.claude/skills/find-docs/SKILL.md', agent: 'claude-code' }] }),
    art('~', '.agents/skills/shared-skill/SKILL.md', 'shared-skill', 'skill', { agent: 'agent-skills' }),
    art('shop', '.cursor/skills/cursor-only/SKILL.md', 'cursor-only', 'skill', { agent: 'cursor' }),
    art('~', '.claude/skills/event-tagging/SKILL.md', 'event-tagging'),
    art('shop', '.cursor/rules/style.mdc', 'style', 'rules', { agent: 'cursor' }),
    art('shop', '.gemini/commands/x.toml', 'x', 'command', { agent: 'gemini' }),
  ]), [session(SHOP, { skills: { deploy: 2, 'find-docs': 1, 'anthropic-skills:event-tagging': 3, 'my-plugin:lint': 1 } })], HOME);
  const deploys = r.judged.filter((j) => j.name === 'deploy');
  assert.deepEqual(deploys.map((j) => [j.repo, j.uses]).sort(), [['~', 2], ['~/code/shop', 0]]);
  assert.equal(verdictOf(r, 'find-docs').verdict, 'keep', 'linked into ~/.claude/skills');
  assert.deepEqual([verdictOf(r, 'shared-skill').agents, verdictOf(r, 'shared-skill').verdict], [['codex', 'gemini-cli'], 'no-data'], '.agents/skills is Codex and Gemini CLI, and only Claude sessions ran');
  assert.ok(!r.judged.some((j) => j.name === 'cursor-only'));
  assert.deepEqual(verdictOf(r, 'event-tagging').copyUsed, { name: 'anthropic-skills:event-tagging', uses: 3 });
  assert.deepEqual(r.notJudged, { cursor: 1 }, 'rules files are not judged; agents roost can\'t read are counted');
  assert.equal(verdictOf(r, 'x').agents[0], 'gemini-cli', 'a Gemini command is judged against Gemini sessions');
  assert.deepEqual(r.unmatched.map((u) => u.name), ['anthropic-skills:event-tagging', 'my-plugin:lint']);
});

test('verdicts: each agent\'s sessions count only for what that agent loads', () => {
  const s = (agent: 'codex' | 'gemini-cli', used: Parameters<typeof session>[1]) => ({ ...session(SHOP, used), agent });
  const r = judge(report([
    art('shop', '.codex/skills/pdf/SKILL.md', 'pdf', 'skill', { agent: 'codex' }),
    art('shop', '.claude/skills/pdf/SKILL.md', 'pdf'),
    art('~', '.agents/skills/lint/SKILL.md', 'lint', 'skill', { agent: 'agent-skills' }),
    art('shop', '.gemini/commands/git/commit.toml', 'commit', 'command', { agent: 'gemini' }),
    art('shop', '.codex/prompts/fix.md', 'fix', 'command', { agent: 'codex' }),
  ]), [s('codex', { skills: { pdf: 2, lint: 1 }, commands: { '/prompts:fix': 1, '/review': 1 } }), s('gemini-cli', { skills: { lint: 3 }, commands: { '/git:commit': 4, '/stats': 1 }, subagents: { codebase_investigator: 1 } }), session(SHOP)], HOME);
  const pdf = r.judged.filter((j) => j.name === 'pdf').map((j) => [j.relPath, j.verdict, j.uses]).sort();
  assert.deepEqual(pdf, [['.claude/skills/pdf/SKILL.md', 'retire', 0], ['.codex/skills/pdf/SKILL.md', 'keep', 2]], 'Codex runs don\'t count for the Claude Code copy');
  assert.deepEqual([verdictOf(r, 'lint').uses, verdictOf(r, 'lint').sessions], [4, 2], 'a shared .agents skill counts in Codex and Gemini CLI');
  assert.equal(verdictOf(r, 'commit').uses, 4, '.gemini/commands/git/commit.toml is /git:commit');
  assert.equal(verdictOf(r, 'fix').uses, 1, 'Codex custom prompts are /prompts:name');
  assert.deepEqual(r.unmatched, [], 'each agent\'s built-in commands and subagents are left out');
});

test('verdicts: reports from rookery before 0.7.2 match repos by folder name', () => {
  const old = art('shop', '.claude/skills/fmt/SKILL.md', 'fmt');
  delete old.repoRoot;
  const r = judge(report([old]), [session(SHOP, { skills: { fmt: 1 } })], HOME);
  assert.equal(r.matchedByName, true);
  assert.equal(verdictOf(r, 'fmt').verdict, 'keep');
  assert.match(renderVerdictsTerminal({ report: r, window: 'last 30 days', sessions: 1, agents: [{ id: 'claude-code', sessions: 1 }], first: null, last: null, rookery: { version: '0.7.1' }, top: 10 }), /matched by folder name/);
});

test('verdicts: repo paths compare the same on every OS', async () => {
  const { samePath } = await import('../src/verdicts.js');
  assert.equal(samePath('C:\\Users\\dev\\code\\Shop\\', 'win32'), 'c:/users/dev/code/shop');
  assert.equal(samePath('/home/dev/code/Shop/', 'linux'), '/home/dev/code/Shop');
  const r = judge(report([art('shop', '.claude/skills/fmt/SKILL.md', 'fmt')]), [session('C:\\Users\\dev\\code\\shop', { skills: { fmt: 1 } })], 'C:\\Users\\dev');
  assert.equal(verdictOf(r, 'fmt').verdict, 'keep', 'a Windows session path matches a ~/ repo root');
});

test('verdicts: only a rookery JSON report is accepted', () => {
  assert.throws(() => parseRookery('not json'), InputError);
  assert.throws(() => parseRookery('{"tool":{"name":"other"},"artifacts":[]}'), /not a rookery report/);
  assert.equal(parseRookery(JSON.stringify(report([]))).artifacts.length, 0);
});

test('CLI: verdicts from piped rookery JSON and real-shaped logs, with nothing private in the output', () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-verdicts-'));
  const shop = join(home, 'code', 'shop');
  mkdirSync(join(shop, '.git'), { recursive: true });
  const log = join(home, '.claude', 'projects', '-code-shop', 's-1.jsonl');
  mkdirSync(dirname(log), { recursive: true });
  const t = new Date(Date.now() - 86_400_000).toISOString();
  const lines = [
    { type: 'user', uuid: 'u1', sessionId: 's-1', cwd: shop, timestamp: t, message: { role: 'user', content: '<command-name>/ship</command-name><command-args>SECRET-ARGS</command-args>' } },
    { type: 'assistant', uuid: 'a1', sessionId: 's-1', cwd: shop, timestamp: t, requestId: 'r1', message: { role: 'assistant', id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'fmt', args: 'SECRET-SKILL-ARGS' } }] } },
    { type: 'assistant', uuid: 'a2', sessionId: 's-1', cwd: shop, timestamp: t, requestId: 'r2', message: { role: 'assistant', id: 'm2', content: [{ type: 'text', text: 'SECRET-REPLY' }] } },
  ];
  writeFileSync(log, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const rk = report([art('shop', '.claude/skills/fmt/SKILL.md', 'fmt'), art('shop', '.claude/skills/ship/SKILL.md', 'ship'), art('shop', '.claude/skills/unused/SKILL.md', 'unused')], {
    findings: [{ ruleId: 'RK-QLT-007', severity: 'low', title: 'Skill description is too short to match on', artifactId: 'shop:.claude/skills/ship/SKILL.md', confidence: 'high' }],
  });
  const env = { ...process.env, FORCE_COLOR: '', NO_COLOR: '' };
  const out = spawnSync(process.execPath, [CLI, 'verdicts', '--home', home, '--no-color'], { input: JSON.stringify(rk), encoding: 'utf8', env });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /FIX FIRST 1[\s\S]*ship\s+~\/code\/shop\s+used 1× · Skill description is too short/);
  assert.match(out.stdout, /RETIRE 1[\s\S]*unused\s+~\/code\/shop\s+not used in 1 session/);
  assert.match(out.stdout, /KEEP 1[\s\S]*fmt/);
  assert.ok(!out.stdout.includes('SECRET') && !out.stdout.includes(home), 'no message text, arguments or home path');

  const file = join(home, 'rookery.json');
  writeFileSync(file, JSON.stringify(rk));
  const json = JSON.parse(spawnSync(process.execPath, [CLI, 'verdicts', '--home', home, '--rookery', file, '--format', 'json'], { encoding: 'utf8', env }).stdout);
  assert.deepEqual(json.verdicts.map((v: { name: string; verdict: string }) => [v.name, v.verdict]), [['ship', 'improve'], ['unused', 'retire'], ['fmt', 'keep']]);
  assert.ok(!JSON.stringify(json).includes('SECRET'));

  const bad = spawnSync(process.execPath, [CLI, 'verdicts', '--home', home, '--rookery', join(home, 'missing.json')], { encoding: 'utf8', env });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /can't read/);
});
