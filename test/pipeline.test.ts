import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { runPipeline } from '../src/export/pipeline-run.js';
import { pipelineRunRow } from '../src/export/rows.js';
import { AGENTS } from '../src/usage/agents.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const baseEnv = { ...process.env, FORCE_COLOR: '', NO_COLOR: '' };
for (const k of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'CI_JOB_ID', 'BUILD_ID', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'ROOST_EXPORT']) delete (baseEnv as Record<string, string | undefined>)[k];
const run = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });

test('pipelineRunRow: one summary row per job, with the outcome and pr as labels', () => {
  const r = pipelineRunRow({ job: 'gh-1', agent: 'claude-code', outcome: 'merged', pr: '42', day: '2026-10-16', repo: 'github.com/acme/shop', tokens: 5502, skills: 1, mcpCalls: 0 });
  assert.equal(r.event, 'roost.run');
  assert.deepEqual(r.item, { key: 'job', value: 'gh-1' });
  assert.deepEqual(r.labels, { outcome: 'merged', pr: '42' });
  assert.deepEqual(r.values, { tokens: 5502, skills: 1, mcp_calls: 0 });
});

test('pipelineRunRow: no pr means no pr label', () => {
  const r = pipelineRunRow({ job: 'gh-1', agent: 'codex', outcome: 'failed', day: '2026-10-16', tokens: 10, skills: 0, mcpCalls: 0 });
  assert.deepEqual(r.labels, { outcome: 'failed' });
});

function fixtureHome(repo: string): string {
  const home = mkdtempSync(join(tmpdir(), 'roost-pipeline-home-'));
  const write = (rel: string, lines: unknown[]) => {
    const path = join(home, '.claude', 'projects', rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  const msg = (id: string, ts: string, toolName: string, input: unknown) => ({
    type: 'assistant', uuid: `u-${id}`, sessionId: 's1', cwd: repo, timestamp: ts,
    message: { role: 'assistant', id, model: 'x', usage: { input_tokens: 2, cache_creation_input_tokens: 2000, cache_read_input_tokens: 3000, output_tokens: 500 }, content: [{ type: 'tool_use', id: `t-${id}`, name: toolName, input }] },
  });
  write('-repo/s1.jsonl', [msg('m1', '2026-10-16T10:00:00Z', 'Skill', { skill: 'code-review' })]);
  return home;
}

const claudeCode = () => AGENTS.find((a) => a.id === 'claude-code')!;

test('runPipeline: no session under home fails clearly, nothing sent', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'roost-pipeline-empty-'));
  const r = await runPipeline({ home: empty, env: {}, agent: claudeCode(), job: 'j1', outcome: 'merged', send: false, format: 'terminal', color: false });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /no Claude Code session found/);
});

test('runPipeline: preview shows job, repo, outcome and tokens; sends nothing', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'roost-pipeline-repo-'));
  mkdirSync(join(repo, '.git'));
  const home = fixtureHome(repo);
  const r = await runPipeline({ home, env: {}, agent: claudeCode(), job: 'gh-123', outcome: 'merged', pr: '7', send: false, format: 'terminal', color: false, now: new Date('2026-10-16T12:00:00Z') });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /preview: nothing is sent/);
  assert.match(r.stdout, /gh-123/);
  assert.match(r.stdout, /merged.*pr 7/s);
  assert.doesNotMatch(r.stdout, /ROOST_PERSON_SALT/, 'pipeline rows carry no person id, so this note does not apply');
});

test('runPipeline --format json: the usual usage rows plus one roost.run row', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'roost-pipeline-repo-'));
  mkdirSync(join(repo, '.git'));
  const home = fixtureHome(repo);
  const r = await runPipeline({ home, env: {}, agent: claudeCode(), job: 'gh-123', outcome: 'retried', send: false, format: 'json', color: false });
  const json = JSON.parse(r.stdout);
  assert.equal(json.job, 'gh-123');
  const events = json.rows.map((row: { event: string }) => row.event);
  assert.deepEqual(events.sort(), ['roost.activity', 'roost.run', 'roost.skill_used'].sort());
  const runRow = json.rows.find((row: { event: string }) => row.event === 'roost.run');
  assert.equal(runRow.labels.outcome, 'retried');
  assert.equal(runRow.values.skills, 1);
});

async function setup() {
  const repo = mkdtempSync(join(tmpdir(), 'roost-pipeline-repo-'));
  mkdirSync(join(repo, '.git'));
  writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/shop.git\n');
  const home = fixtureHome(repo);

  const got: { headers: IncomingMessage['headers']; body: string }[] = [];
  let status = 200, reply = '{}';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { got.push({ headers: req.headers, body }); res.writeHead(status, { 'content-type': 'application/json' }); res.end(reply); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/otlp`;
  return { home, endpoint, got, setReply: (s: number, r: string) => { status = s; reply = r; }, close: () => server.close() };
}

test('runPipeline --send: refused without ROOST_EXPORT=on, then sends exactly one request', async () => {
  const t = await setup();
  try {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: t.endpoint };
    const refused = await runPipeline({ home: t.home, env, agent: claudeCode(), job: 'gh-1', outcome: 'merged', send: true, format: 'terminal', color: false });
    assert.equal(refused.exitCode, 2);
    assert.match(refused.stderr, /ROOST_EXPORT=on/);
    assert.equal(t.got.length, 0);

    const sent = await runPipeline({ home: t.home, env: { ...env, ROOST_EXPORT: 'on' }, agent: claudeCode(), job: 'gh-1', outcome: 'merged', send: true, format: 'terminal', color: false });
    assert.equal(sent.exitCode, 0, sent.stderr);
    assert.match(sent.stdout, /Sent 3 rows for job gh-1/);
    assert.equal(t.got.length, 1);
    const payload = JSON.parse(t.got[0].body);
    const bodies = payload.resourceLogs[0].scopeLogs[0].logRecords.map((r: { body: { stringValue: string } }) => r.body.stringValue);
    assert.ok(bodies.includes('roost.run'));
  } finally {
    t.close();
  }
});

test('cli: roost pipeline requires exactly one --agent and a valid --outcome', () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-pipeline-empty-'));
  const noAgent = run(baseEnv, 'pipeline', '--home', home, '--outcome', 'merged');
  assert.equal(noAgent.status, 2);
  assert.match(noAgent.stderr, /pipeline needs exactly one --agent/);

  const allAgent = run(baseEnv, 'pipeline', '--home', home, '--agent', 'all', '--outcome', 'merged');
  assert.equal(allAgent.status, 2);
  assert.match(allAgent.stderr, /pipeline needs exactly one --agent/);

  const noOutcome = run(baseEnv, 'pipeline', '--home', home, '--agent', 'claude-code');
  assert.equal(noOutcome.status, 2);
  assert.match(noOutcome.stderr, /--outcome merged, failed or retried/);

  const badOutcome = run(baseEnv, 'pipeline', '--home', home, '--agent', 'claude-code', '--outcome', 'done');
  assert.equal(badOutcome.status, 2);
  assert.match(badOutcome.stderr, /--outcome must be merged, failed or retried/);
});

test('cli: --job/--outcome/--pr are pipeline-only; infers the job id from GITHUB_RUN_ID', () => {
  const wrongCommand = run(baseEnv, 'usage', '--outcome', 'merged');
  assert.equal(wrongCommand.status, 2);
  assert.match(wrongCommand.stderr, /--job, --outcome and --pr are options of roost pipeline/);

  const repo = mkdtempSync(join(tmpdir(), 'roost-pipeline-repo-'));
  mkdirSync(join(repo, '.git'));
  const home = fixtureHome(repo);
  const withRunId = run({ ...baseEnv, GITHUB_RUN_ID: '555', GITHUB_RUN_ATTEMPT: '2' }, 'pipeline', '--home', home, '--agent', 'claude-code', '--outcome', 'merged', '--format', 'json');
  assert.equal(withRunId.status, 0, withRunId.stderr);
  assert.equal(JSON.parse(withRunId.stdout).job, 'gh-555-2');
});
