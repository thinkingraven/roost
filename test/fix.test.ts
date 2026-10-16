import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planFix } from '../src/fix.js';
import { applyFix } from '../src/fix-apply.js';
import { judge, type RookeryArtifact, type RookeryReport } from '../src/verdicts.js';
import { newSession, type SessionUsage } from '../src/usage/types.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const env = { ...process.env, FORCE_COLOR: '', NO_COLOR: '' };
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, input: '' });
const runWithInput = (input: string, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, input });

const HOME = '/home/dev';
function session(repo: string | undefined, skills: Record<string, number> = {}): SessionUsage {
  const s = newSession('claude-code', Math.random().toString(36).slice(2));
  s.repo = repo;
  s.first = new Date('2026-10-01T09:00:00Z');
  s.last = new Date('2026-10-01T10:00:00Z');
  for (const [k, n] of Object.entries(skills)) s.skills.set(k, n);
  return s;
}
const art = (repoRoot: string, relPath: string, name: string, extra: Partial<RookeryArtifact> = {}): RookeryArtifact =>
  ({ id: `${repoRoot}:${relPath}`, repo: repoRoot === '~' ? '~' : repoRoot.split('/').pop()!, repoRoot, relPath, agent: 'claude-code', kind: 'skill', name, ...extra });
const report = (artifacts: RookeryArtifact[], extra: Partial<RookeryReport> = {}): RookeryReport =>
  ({ tool: { name: 'rookery', version: '0.7.2' }, scannedAt: '2026-10-16T00:00:00Z', artifacts, findings: [], clusters: [], ...extra });

test('planFix: retire and merge verdicts become file changes, grouped by resolved repo root', () => {
  const kept = art('~/code/shop', '.claude/skills/code-review/SKILL.md', 'code-review');
  const dup = art('~/code/shop', '.claude/skills/old-review/SKILL.md', 'old-review');
  const unused = art('~/code/shop', '.claude/skills/draft-notes/SKILL.md', 'draft-notes');
  const other = art('~/code/api', '.claude/skills/scratch/SKILL.md', 'scratch');
  const r = report([kept, dup, unused, other], { clusters: [{ members: [{ artifactId: kept.id }, { artifactId: dup.id }] }] });
  const sessions = [session(`${HOME}/code/shop`, { 'code-review': 3 }), session(`${HOME}/code/api`)];
  const verdicts = judge(r, sessions, HOME);

  // planFix resolves `~/` repo roots with node:path join, which normalises to the platform's own
  // separator (unlike judge()'s own forward-slash-only matching) — build expected paths the same way.
  const shopRoot = join(HOME, 'code', 'shop');
  const apiRoot = join(HOME, 'code', 'api');

  const plan = planFix(r, verdicts, HOME);
  assert.equal(plan.personalSkipped, 0);
  assert.deepEqual(plan.repos.map((x) => x.repoRoot).sort(), [apiRoot, shopRoot].sort());

  const shop = plan.repos.find((x) => x.repoRoot === shopRoot)!;
  assert.equal(shop.changes.length, 2);
  const dupChange = shop.changes.find((c) => c.name === 'old-review')!;
  assert.equal(dupChange.verdict, 'merge');
  assert.equal(dupChange.absolutePath, join(shopRoot, '.claude/skills/old-review/SKILL.md'));
  assert.match(dupChange.reason, /duplicate of .*code-review.*used 3× there/);
  const retireChange = shop.changes.find((c) => c.name === 'draft-notes')!;
  assert.equal(retireChange.verdict, 'retire');
  assert.match(retireChange.reason, /not used in 1 session it was available/);

  const api = plan.repos.find((x) => x.repoRoot === apiRoot)!;
  assert.equal(api.changes.length, 1);
  assert.equal(api.changes[0].absolutePath, join(apiRoot, '.claude/skills/scratch/SKILL.md'));
});

test('planFix: carries each change\'s preloadTokens and sums them as tokensSavable', () => {
  const kept = art('~/code/shop', '.claude/skills/code-review/SKILL.md', 'code-review', { preloadTokens: 40 });
  const dup = art('~/code/shop', '.claude/skills/old-review/SKILL.md', 'old-review', { preloadTokens: 60 });
  const unused = art('~/code/shop', '.claude/skills/draft-notes/SKILL.md', 'draft-notes', { preloadTokens: 25 });
  const r = report([kept, dup, unused], { clusters: [{ members: [{ artifactId: kept.id }, { artifactId: dup.id }] }] });
  const verdicts = judge(r, [session(`${HOME}/code/shop`, { 'code-review': 3 })], HOME);
  const plan = planFix(r, verdicts, HOME);
  const shop = plan.repos[0];
  assert.equal(shop.changes.find((c) => c.name === 'old-review')!.preloadTokens, 60);
  assert.equal(shop.changes.find((c) => c.name === 'draft-notes')!.preloadTokens, 25);
  assert.equal(plan.tokensSavable, 85, 'the two removed files, not the kept winner');
});

test('planFix: a rookery scan with no preloadTokens leaves it undefined and tokensSavable at 0', () => {
  const unused = art('~/code/shop', '.claude/skills/draft-notes/SKILL.md', 'draft-notes');
  const r = report([unused]);
  const verdicts = judge(r, [session(`${HOME}/code/shop`)], HOME);
  const plan = planFix(r, verdicts, HOME);
  assert.equal(plan.repos[0].changes[0].preloadTokens, undefined);
  assert.equal(plan.tokensSavable, 0);
});

test('planFix: personal skills are counted, never planned for removal', () => {
  const personal = art('~', '.claude/skills/my-thing/SKILL.md', 'my-thing');
  const r = report([personal]);
  // A personal skill is in scope for every session of its agent, so one unrelated session is
  // enough to give it a real "retire" verdict (scopeSessions > 0, never used) rather than "no-data".
  const verdicts = judge(r, [session(`${HOME}/code/shop`)], HOME);
  assert.equal(verdictOf(verdicts, 'my-thing').verdict, 'retire');
  const plan = planFix(r, verdicts, HOME);
  assert.deepEqual(plan.repos, []);
  assert.equal(plan.personalSkipped, 1);
});

test('planFix: keep and improve verdicts are left out of the plan entirely', () => {
  const kept = art('~/code/shop', '.claude/skills/code-review/SKILL.md', 'code-review');
  const r = report([kept]);
  const verdicts = judge(r, [session(`${HOME}/code/shop`, { 'code-review': 1 })], HOME);
  assert.equal(verdictOf(verdicts, 'code-review').verdict, 'keep');
  assert.deepEqual(planFix(r, verdicts, HOME).repos, []);
});

function verdictOf(r: ReturnType<typeof judge>, name: string) {
  return r.judged.find((j) => j.name === name)!;
}

// ---------- applyFix: real temp git repos ----------

function gitRepo(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), 'roost-fix-repo-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  for (const [rel, content] of Object.entries(files)) {
    const path = join(repo, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return repo;
}
function currentBranch(repo: string): string {
  return execFileSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
}

test('applyFix: creates a branch, removes the planned files, and commits — never pushes', () => {
  const repo = gitRepo({
    '.claude/skills/code-review/SKILL.md': 'keep',
    '.claude/skills/old-review/SKILL.md': 'dup',
    '.claude/skills/draft-notes/SKILL.md': 'unused',
  });
  const plan = {
    personalSkipped: 0,
    tokensSavable: 0,
    repos: [{
      repoRoot: repo,
      changes: [
        { verdict: 'merge' as const, name: 'old-review', kind: 'skill', relPath: '.claude/skills/old-review/SKILL.md', absolutePath: join(repo, '.claude/skills/old-review/SKILL.md'), reason: 'duplicate of .claude/skills/code-review/SKILL.md, used 3× there' },
        { verdict: 'retire' as const, name: 'draft-notes', kind: 'skill', relPath: '.claude/skills/draft-notes/SKILL.md', absolutePath: join(repo, '.claude/skills/draft-notes/SKILL.md'), reason: 'not used in 1 session it was available' },
      ],
    }],
  };
  const result = applyFix(plan);
  assert.equal(result.repos.length, 1);
  const r = result.repos[0];
  assert.equal(r.applied.length, 2);
  assert.equal(r.skipped.length, 0);
  assert.match(r.branch!, /^roost\/retire-skills-\d{4}-\d{2}-\d{2}$/);
  assert.equal(currentBranch(repo), r.branch);
  const log = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%B'], { encoding: 'utf8' });
  assert.match(log, /retire or merge 2 skills/);
  assert.match(log, /old-review\/SKILL\.md: duplicate of/);
  assert.match(log, /Never pushed; nothing opened/);
  const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.equal(status, '', 'working tree is clean after the commit');
  assert.ok(!execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).includes('old-review'));
});

test('applyFix: a dirty working tree is skipped, not force-committed into', () => {
  const repo = gitRepo({ '.claude/skills/x/SKILL.md': 'x' });
  writeFileSync(join(repo, 'untracked.txt'), 'wip');
  const plan = { personalSkipped: 0, tokensSavable: 0, repos: [{ repoRoot: repo, changes: [{ verdict: 'retire' as const, name: 'x', kind: 'skill', relPath: '.claude/skills/x/SKILL.md', absolutePath: join(repo, '.claude/skills/x/SKILL.md'), reason: 'not used in 1 session it was available' }] }] };
  const result = applyFix(plan);
  assert.equal(result.repos[0].repoSkipReason, 'uncommitted changes — commit or stash first');
  assert.equal(result.repos[0].applied.length, 0);
  assert.equal(currentBranch(repo), 'main', 'never left on a half-made branch');
});

test('applyFix: not a git repository is skipped cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-fix-notgit-'));
  mkdirSync(join(dir, '.claude/skills/x'), { recursive: true });
  writeFileSync(join(dir, '.claude/skills/x/SKILL.md'), 'x');
  const plan = { personalSkipped: 0, tokensSavable: 0, repos: [{ repoRoot: dir, changes: [{ verdict: 'retire' as const, name: 'x', kind: 'skill', relPath: '.claude/skills/x/SKILL.md', absolutePath: join(dir, '.claude/skills/x/SKILL.md'), reason: 'r' }] }] };
  const result = applyFix(plan);
  assert.equal(result.repos[0].repoSkipReason, 'not a git repository');
});

test('applyFix: a file already gone is skipped by name, without touching the repo', () => {
  const repo = gitRepo({ '.claude/skills/x/SKILL.md': 'x' });
  const plan = { personalSkipped: 0, tokensSavable: 0, repos: [{ repoRoot: repo, changes: [{ verdict: 'retire' as const, name: 'ghost', kind: 'skill', relPath: '.claude/skills/ghost/SKILL.md', absolutePath: join(repo, '.claude/skills/ghost/SKILL.md'), reason: 'r' }] }] };
  const result = applyFix(plan);
  assert.equal(result.repos[0].applied.length, 0);
  assert.equal(result.repos[0].skipped.length, 1);
  assert.equal(result.repos[0].skipped[0].reason, 'file no longer exists');
  assert.equal(currentBranch(repo), 'main');
});

test('applyFix: a second run picks a free branch name instead of colliding', () => {
  const repo = gitRepo({ '.claude/skills/a/SKILL.md': 'a', '.claude/skills/b/SKILL.md': 'b' });
  const changeFor = (name: string) => ({ verdict: 'retire' as const, name, kind: 'skill', relPath: `.claude/skills/${name}/SKILL.md`, absolutePath: join(repo, `.claude/skills/${name}/SKILL.md`), reason: 'r' });
  const first = applyFix({ personalSkipped: 0, tokensSavable: 0, repos: [{ repoRoot: repo, changes: [changeFor('a')] }] });
  execFileSync('git', ['-C', repo, 'checkout', 'main', '-q']);
  const second = applyFix({ personalSkipped: 0, tokensSavable: 0, repos: [{ repoRoot: repo, changes: [changeFor('b')] }] });
  assert.notEqual(first.repos[0].branch, second.repos[0].branch);
  assert.match(second.repos[0].branch!, /-2$/);
});

// ---------- CLI: verdicts --fix / --fix --write, end to end ----------

function fixtureHome(repo: string): string {
  const home = mkdtempSync(join(tmpdir(), 'roost-fix-home-'));
  const write = (rel: string, lines: unknown[]) => {
    const path = join(home, '.claude', 'projects', rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  const msg = (id: string, toolName: string, input: unknown) => ({
    type: 'assistant', uuid: `u-${id}`, sessionId: 's1', cwd: repo, timestamp: '2026-10-01T10:00:00Z',
    message: { role: 'assistant', id, model: 'x', usage: { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: `t-${id}`, name: toolName, input }] },
  });
  write('-repo/s1.jsonl', [msg('m1', 'Skill', { skill: 'code-review' })]);
  return home;
}

test('cli: roost verdicts --fix previews without touching the repo; --write applies it', () => {
  const repo = gitRepo({
    '.claude/skills/code-review/SKILL.md': 'keep',
    '.claude/skills/old-review/SKILL.md': 'dup',
  });
  const home = fixtureHome(repo);
  const rookery = JSON.stringify({
    tool: { name: 'rookery', version: '0.7.2' }, scannedAt: '2026-10-16T00:00:00Z',
    artifacts: [
      { id: 'a1', repo: 'r', repoRoot: repo, relPath: '.claude/skills/code-review/SKILL.md', agent: 'claude-code', kind: 'skill', name: 'code-review' },
      { id: 'a2', repo: 'r', repoRoot: repo, relPath: '.claude/skills/old-review/SKILL.md', agent: 'claude-code', kind: 'skill', name: 'old-review' },
    ],
    findings: [],
    clusters: [{ members: [{ artifactId: 'a1' }, { artifactId: 'a2' }] }],
  });

  const preview = runWithInput(rookery, 'verdicts', '--home', home, '--since', 'all', '--fix');
  assert.equal(preview.status, 0);
  assert.match(preview.stdout, /preview: nothing changed/);
  assert.match(preview.stdout, /old-review\/SKILL\.md/);
  assert.equal(currentBranch(repo), 'main', 'preview never touches git');

  const applied = runWithInput(rookery, 'verdicts', '--home', home, '--since', 'all', '--fix', '--write');
  assert.equal(applied.status, 0);
  assert.match(applied.stdout, /branch roost\/retire-skills-\d{4}-\d{2}-\d{2}, 1 file removed and committed/);
  assert.match(applied.stdout, /git push -u origin.*&&\s*gh pr create/, 'suggests the command; fix-apply.ts never shells out to anything but git');
  assert.notEqual(currentBranch(repo), 'main');
  assert.ok(!execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).includes('old-review'));
});

test('cli: roost verdicts --fix previews and --write applies report the tokens rookery\'s preloadTokens says this would save', () => {
  const repo = gitRepo({
    '.claude/skills/code-review/SKILL.md': 'keep',
    '.claude/skills/old-review/SKILL.md': 'dup',
  });
  const home = fixtureHome(repo);
  const rookery = JSON.stringify({
    tool: { name: 'rookery', version: '0.8.0' }, scannedAt: '2026-10-16T00:00:00Z',
    artifacts: [
      { id: 'a1', repo: 'r', repoRoot: repo, relPath: '.claude/skills/code-review/SKILL.md', agent: 'claude-code', kind: 'skill', name: 'code-review', preloadTokens: 40 },
      { id: 'a2', repo: 'r', repoRoot: repo, relPath: '.claude/skills/old-review/SKILL.md', agent: 'claude-code', kind: 'skill', name: 'old-review', preloadTokens: 70 },
    ],
    findings: [],
    clusters: [{ members: [{ artifactId: 'a1' }, { artifactId: 'a2' }] }],
  });

  const preview = runWithInput(rookery, 'verdicts', '--home', home, '--since', 'all', '--fix');
  assert.equal(preview.status, 0);
  assert.match(preview.stdout, /ready to branch\s+·\s+70 tokens\/session/);
  assert.match(preview.stdout, /old-review\/SKILL\.md.*\(70 tokens\/session\)/);

  const applied = runWithInput(rookery, 'verdicts', '--home', home, '--since', 'all', '--fix', '--write');
  assert.equal(applied.status, 0);
  assert.match(applied.stdout, /1 file removed and committed\s+·\s+70 tokens\/session/);
  assert.match(applied.stdout, /1 of 1 repo updated, 70 tokens\/session saved\. Nothing was pushed\./);
  const log = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%B'], { encoding: 'utf8' });
  assert.match(log, /saves ~70 tokens\/session/);
});

test('cli: --write without --fix, and --fix on a command other than verdicts, both fail', () => {
  assert.equal(run('verdicts', '--write').status, 2);
  assert.match(run('verdicts', '--write').stderr, /--write needs --fix/);
  assert.equal(run('usage', '--fix').status, 2);
  assert.match(run('usage', '--fix').stderr, /--fix and --write are options of roost verdicts/);
});
