import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { exportConfig, ExportConfigError, parseList, safeUrl } from '../src/export/config.js';
import { gitConfigValue, machineId, normaliseRemote, personId, repoRemote } from '../src/export/identity.js';
import { policyRows, rowId, usageRows } from '../src/export/rows.js';
import { otlpPayload } from '../src/export/otlp.js';
import { exportWindow, runExport, MAX_BACKFILL_DAYS } from '../src/export/run.js';
import { AGENTS } from '../src/usage/agents.js';
import { newSession } from '../src/usage/types.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const NOW = new Date('2026-10-15T10:00:00Z');

test('export config: the standard OTEL_* settings, and an explicit opt-in', () => {
  assert.deepEqual(parseList('Authorization=Basic%20abc%3D%3D, x-scope=team%2Fa ,bad,=x'), { Authorization: 'Basic abc==', 'x-scope': 'team/a' });
  const c = exportConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp-gateway.example.net/otlp/', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic%20abc', OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=prod', ROOST_TEAM: ' payments ' });
  assert.equal(c.logsUrl, 'https://otlp-gateway.example.net/otlp/v1/logs');
  assert.deepEqual([c.headers, c.resource, c.team, c.optedIn, c.person, c.repo], [{ Authorization: 'Basic abc' }, { 'deployment.environment': 'prod' }, 'payments', false, 'hashed', 'remote']);
  assert.ok(c.notes.some((n) => n.includes('ROOST_PERSON_SALT')));
  assert.equal(exportConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://a/otlp', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://b/logs' }).logsUrl, 'https://b/logs', 'the logs endpoint wins, as is');
  assert.equal(exportConfig({ ROOST_EXPORT: 'on' }).optedIn, true);
  assert.equal(exportConfig({}, { endpoint: 'http://localhost:4318' }).optedIn, true, '--endpoint is an explicit choice');
  assert.ok(exportConfig({}, { endpoint: 'http://collector.internal:4318' }).notes.some((n) => n.includes('unencrypted')));
  assert.throws(() => exportConfig({ OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }), ExportConfigError);
  assert.throws(() => exportConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'otlp.example.net' }), /must start with https/);
  assert.throws(() => exportConfig({ ROOST_PERSON: 'email' }), /hashed or none/);
  assert.equal(safeUrl('https://user:SECRET@host.example:8443/otlp/v1/logs?token=SECRET'), 'https://host.example:8443/otlp/v1/logs');
});

test('export identity: repos as host/org/repo without credentials, people as salted hashes', () => {
  for (const [url, want] of [
    ['git@github.com:acme/shop.git', 'github.com/acme/shop'],
    ['git@github.com-work:acme/shop.git', 'github.com/acme/shop'],
    ['https://user:ghp_SECRET@github.com/acme/shop.git', 'github.com/acme/shop'],
    ['ssh://git@GitLab.example.com:2222/team/app.git', 'gitlab.example.com/team/app'],
    ['/srv/git/repo.git', undefined],
  ] as const) assert.equal(normaliseRemote(url), want, url);

  const root = mkdtempSync(join(tmpdir(), 'roost-export-'));
  const repo = join(root, 'code', 'shop');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'config'), '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:other/x.git\n[remote "origin"]\n\turl = https://bot:SECRET@github.com/acme/shop.git\n');
  assert.equal(repoRemote(repo), 'github.com/acme/shop', 'origin wins; credentials dropped');
  const wt = join(root, 'code', 'shop-wt');
  mkdirSync(join(repo, '.git', 'worktrees', 'shop-wt'), { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'shop-wt')}\n`);
  assert.equal(repoRemote(wt), 'github.com/acme/shop', 'a worktree reads its main repo\'s config');
  assert.equal(gitConfigValue('[user]\n  email = "dev@example.com"\n', 'user', 'email'), 'dev@example.com');

  writeFileSync(join(root, '.gitconfig'), '[user]\n\tname = Dev\n\temail = Dev@Example.com\n');
  assert.equal(personId('salt', root), personId('salt', root));
  assert.notEqual(personId('salt', root), personId('other', root), 'the company salt changes every id');
  assert.match(personId('salt', root), /^[0-9a-f]{16}$/);
  const m = machineId(root);
  assert.equal(machineId(root), m, 'kept in ~/.roost/instance-id');
});

test('export rows: daily counts per agent and repo, with stable ids', () => {
  const s1 = Object.assign(newSession('claude-code', 'a'), { day: '2026-10-14', repo: '/x/shop' });
  s1.tokens = { input: 10, cacheWrite: 1, cacheRead: 100, output: 5 };
  s1.skills.set('review', 2); s1.subagents.set('Explore', 1); s1.subagents.set('reviewer', 3);
  s1.commands.set('/model', 1); s1.commands.set('/deploy', 2); s1.mcp.set('github/list_prs', 3); s1.mcp.set('github/get_issue', 1);
  const s2 = Object.assign(newSession('claude-code', 'b'), { day: '2026-10-14', repo: '/x/shop' });
  s2.skills.set('review', 1);
  const rows = usageRows([s1, s2], { repoOf: (r) => (r ? r.split('/').pop() : undefined) });
  const find = (event: string, item?: string) => rows.find((r) => r.event === event && (!item || r.item?.value === item))!;
  assert.deepEqual(find('roost.activity').values, { sessions: 2, 'tokens.input': 10, 'tokens.cache_read': 100, 'tokens.cache_write': 1, 'tokens.output': 5, skill_runs: 3, mcp_calls: 4 });
  assert.deepEqual(find('roost.skill_used', 'review').values, { sessions: 2, runs: 3 });
  assert.deepEqual([find('roost.subagent_used', 'Explore').labels, find('roost.subagent_used', 'reviewer').labels], [{ builtin: 'true' }, { builtin: 'false' }]);
  assert.deepEqual([find('roost.command_used', '/model').labels, find('roost.command_used', '/deploy').values], [{ builtin: 'true' }, { sessions: 1, uses: 2 }]);
  assert.deepEqual(find('roost.mcp_used', 'github').values, { sessions: 1, calls: 4, tools: 2 });
  assert.equal(find('roost.activity').repo, 'shop');
  assert.equal(rowId(find('roost.activity'), 'p1'), rowId({ ...find('roost.activity'), values: {} }, 'p1'), 'the id ignores the counts');
  assert.notEqual(rowId(find('roost.activity'), 'p1'), rowId(find('roost.activity'), 'p2'));
});

test('export rows: rookery hook decisions, blocks and warnings per rule', () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-export-'));
  mkdirSync(join(home, 'decisions'));
  writeFileSync(join(home, 'decisions', '2026-10-14.jsonl'), [
    { ts: '2026-10-14T10:00:00Z', agent: 'claude-code', kind: 'shell', decision: 'deny', rule: 'RK-POL-006', key: 'files.read_secrets', subject: 'cat ~/.ssh/**', repo: 'shop' },
    { ts: '2026-10-14T11:00:00Z', agent: 'claude-code', kind: 'shell', decision: 'deny', rule: 'RK-POL-006', key: 'files.read_secrets', subject: 'x', repo: 'shop' },
    { ts: '2026-10-14T12:00:00Z', agent: 'gemini', kind: 'mcp', decision: 'warn', rule: 'RK-POL-004', key: 'mcp.unlisted', subject: 'y', repo: 'shop' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n');
  writeFileSync(join(home, 'decisions', '2026-10-01.jsonl'), JSON.stringify({ ts: '2026-10-01T10:00:00Z', agent: 'codex', decision: 'deny', key: 'shell.deny' }) + '\n');
  const { rows, skipped } = policyRows(home, new Set(['2026-10-14']));
  assert.equal(skipped, 1);
  assert.deepEqual(rows.map((r) => [r.agent, r.item!.value, r.labels.setting, r.values.blocked, r.values.warned]).sort(), [['claude-code', 'RK-POL-006', 'files.read_secrets', 2, 0], ['gemini-cli', 'RK-POL-004', 'mcp.unlisted', 0, 1]]);
  assert.ok(!JSON.stringify(rows).includes('ssh'), 'the subject never leaves');
});

test('export OTLP: one log record per row, ints as strings, one stream per person', () => {
  const row = { event: 'roost.skill_used' as const, day: '2026-10-14', agent: 'codex', repo: 'github.com/acme/shop', item: { key: 'skill', value: 'pdf' }, labels: {}, values: { runs: 3, sessions: 1 } };
  const p = otlpPayload([row], { team: 'payments', person: 'abc', instance: 'abc', resource: { 'deployment.environment': 'prod' }, now: NOW });
  const res = Object.fromEntries(p.resourceLogs[0].resource.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
  assert.deepEqual([res['service.name'], res['service.instance.id'], res['deployment.environment']], ['roost', 'abc', 'prod']);
  const rec = p.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(rec.timeUnixNano, String(Date.parse('2026-10-14T23:59:59.999Z')) + '000000');
  const attrs = Object.fromEntries(rec.attributes.map((a) => [a.key, a.value]));
  assert.deepEqual([attrs['event.name'], attrs['roost.skill'], attrs['roost.runs'], attrs['roost.team'], attrs['roost.person']], [{ stringValue: 'roost.skill_used' }, { stringValue: 'pdf' }, { intValue: '3' }, { stringValue: 'payments' }, { stringValue: 'abc' }]);
  assert.match((attrs['roost.row_id'] as { stringValue: string }).stringValue, /^[0-9a-f]{32}$/);
});

test('export window: whole days to yesterday, never older than a week by default', () => {
  assert.deepEqual(exportWindow(undefined, undefined, NOW), { from: '2026-10-08', to: '2026-10-14', label: '2026-10-08 → 2026-10-14', skippedBefore: undefined });
  assert.equal(exportWindow(undefined, '2026-10-12', NOW).from, '2026-10-13', 'the day after the last send');
  assert.equal(exportWindow(undefined, '2026-10-14', NOW).label, 'nothing new after 2026-10-14');
  const late = exportWindow(undefined, '2026-09-20', NOW);
  assert.deepEqual([late.from, late.skippedBefore], ['2026-10-08', '2026-09-21'], `a machine that was off: at most ${MAX_BACKFILL_DAYS} days back`);
  assert.equal(exportWindow('30d', '2026-10-14', NOW).from, '2026-09-15', '--since overrides the record');
  assert.equal(exportWindow('2026-09-01', undefined, NOW).from, '2026-09-01');
  assert.equal(exportWindow('all', undefined, NOW).from, undefined);
  assert.throws(() => exportWindow('last week', undefined, NOW), /--since/);
});

/** A home with two days of Claude Code logs in a repo with a credentialed remote, and a fake OTLP server. */
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'roost-export-'));
  const repo = join(home, 'code', 'shop');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://bot:SECRET-TOKEN@github.com/acme/shop.git\n');
  writeFileSync(join(home, '.gitconfig'), '[user]\n\temail = SECRET-dev@example.com\n');
  const log = join(home, '.claude', 'projects', '-code-shop', 's1.jsonl');
  mkdirSync(dirname(log), { recursive: true });
  const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 5 };
  const entry = (uuid: string, ts: string, block: unknown) => ({ type: 'assistant', uuid, sessionId: 's1', cwd: join(repo, 'src'), timestamp: ts, requestId: `r-${uuid}`, message: { role: 'assistant', id: `m-${uuid}`, usage, content: [block] } });
  writeFileSync(log, [
    entry('1', '2026-10-13T09:00:00Z', { type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'review', args: 'SECRET-ARGS' } }),
    entry('2', '2026-10-14T09:00:00Z', { type: 'text', text: 'SECRET-REPLY' }),
    entry('3', '2026-10-15T08:00:00Z', { type: 'tool_use', id: 't3', name: 'Skill', input: { skill: 'today' } }),   // today: not finished, not sent
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  const got: { url: string; headers: IncomingMessage['headers']; body: string }[] = [];
  let status = 200, reply = '{}';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { got.push({ url: req.url!, headers: req.headers, body }); res.writeHead(status, { 'content-type': 'application/json' }); res.end(reply); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/otlp`;
  const run = (env: NodeJS.ProcessEnv, extra: Partial<Parameters<typeof runExport>[0]> = {}) =>
    runExport({ home, env, agents: AGENTS, send: false, format: 'terminal', top: 10, color: false, now: NOW, ...extra });
  return { home, endpoint, got, run, setReply: (s: number, r: string) => { status = s; reply = r; }, close: () => server.close() };
}

test('export: the preview never touches the network; --send needs a yes, then sends each finished day once', async () => {
  const t = await setup();
  const env = { OTEL_EXPORTER_OTLP_ENDPOINT: t.endpoint, OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20SECRET-LOGIN', ROOST_TEAM: 'payments', ROOST_PERSON_SALT: 's' };

  const preview = await t.run(env);
  assert.equal(preview.exitCode, 0);
  assert.match(preview.stdout, /2026-10-08 → 2026-10-14  ·  preview: nothing is sent/);
  assert.match(preview.stdout, /github\.com\/acme\/shop/);
  assert.match(preview.stdout, /Opt-in +no/);
  const json = JSON.parse((await t.run(env, { format: 'json' })).stdout);
  assert.deepEqual([...new Set(json.rows.map((r: { day: string }) => r.day))], ['2026-10-13', '2026-10-14'], 'today is not finished, so not included');
  assert.equal(t.got.length, 0, 'previews send nothing');

  const refused = await t.run(env, { send: true });
  assert.equal(refused.exitCode, 2);
  assert.match(refused.stderr, /ROOST_EXPORT=on/);
  assert.equal(t.got.length, 0);

  const sent = await t.run({ ...env, ROOST_EXPORT: 'on' }, { send: true });
  assert.equal(sent.exitCode, 0, sent.stderr);
  assert.match(sent.stdout, /Sent \d+ rows for 2026-10-08 → 2026-10-14/);
  assert.equal(t.got.length, 1);
  assert.equal(t.got[0].url, '/otlp/v1/logs');
  assert.equal(t.got[0].headers.authorization, 'Bearer SECRET-LOGIN');
  assert.equal(t.got[0].headers['content-type'], 'application/json');
  const body = JSON.parse(t.got[0].body);
  assert.ok(body.resourceLogs[0].scopeLogs[0].logRecords.length >= 3);
  const text = t.got[0].body;
  assert.ok(!text.includes('SECRET'), 'no prompts, arguments, replies, emails or credentials in what is sent');
  assert.ok(text.includes('github.com/acme/shop') && text.includes('"payments"'));
  assert.ok(existsSync(join(t.home, '.roost', 'export-state.json')));

  const again = await t.run({ ...env, ROOST_EXPORT: 'on' }, { send: true });
  assert.match(again.stdout, /Up to date/);
  assert.equal(t.got.length, 1, 'each day goes once');
  t.close();
});

test('export: a failed send names the problem, hides the login, and is retried next time', async () => {
  const t = await setup();
  const env = { OTEL_EXPORTER_OTLP_ENDPOINT: t.endpoint, OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic%20SECRET', ROOST_EXPORT: 'on' };
  t.setReply(401, '{"message":"invalid token"}');
  const r = await t.run(env, { send: true });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /answered 401.*Check the login/);
  assert.ok(!r.stderr.includes('SECRET'));
  assert.ok(!existsSync(join(t.home, '.roost', 'export-state.json')), 'nothing marked as sent');

  t.setReply(200, '{"partialSuccess":{"rejectedLogRecords":"2","errorMessage":"too old"}}');
  const partial = await t.run(env, { send: true });
  assert.equal(partial.exitCode, 1);
  assert.match(partial.stdout, /2 rejected/);
  t.close();
});

test('CLI: export --format otlp prints the exact payload; export options are export\'s only', () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-export-'));
  const env = { ...process.env, ROOKERY_HOME: join(home, '.rookery'), OTEL_EXPORTER_OTLP_ENDPOINT: '', ROOST_EXPORT: '' };
  const out = spawnSync(process.execPath, [CLI, 'export', '--home', home, '--format', 'otlp'], { encoding: 'utf8', env });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).resourceLogs[0].scopeLogs[0].logRecords, []);
  assert.equal(spawnSync(process.execPath, [CLI, 'usage', '--send'], { encoding: 'utf8', env }).status, 2);
  assert.equal(spawnSync(process.execPath, [CLI, 'usage', '--format', 'otlp'], { encoding: 'utf8', env }).status, 2);
  assert.ok(!readFileSync(fileURLToPath(new URL('../../dashboards/grafana/roost.json', import.meta.url)), 'utf8').includes('SECRET'));
});

test('dashboard: every field it queries is one roost export sends', () => {
  const dash = JSON.parse(readFileSync(fileURLToPath(new URL('../../dashboards/grafana/roost.json', import.meta.url)), 'utf8'));
  const exprs: string[] = dash.panels.flatMap((p: { targets?: { expr: string }[] }) => (p.targets ?? []).map((t) => t.expr));
  assert.ok(exprs.length >= 20);
  const sent = new Set(['roost_day', 'roost_agent', 'roost_repo', 'roost_team', 'roost_person', 'roost_row_id', 'roost_skill', 'roost_subagent', 'roost_command', 'roost_mcp_server', 'roost_rule', 'roost_setting', 'roost_builtin', 'roost_verdict',
    'roost_sessions', 'roost_runs', 'roost_uses', 'roost_calls', 'roost_tools', 'roost_blocked', 'roost_warned', 'roost_issues', 'roost_scope_sessions',
    'roost_tokens_input', 'roost_tokens_cache_read', 'roost_tokens_cache_write', 'roost_tokens_output', 'roost_skill_runs', 'roost_mcp_calls',
    'roost_outcome', 'roost_tokens']);
  const used = new Set(exprs.flatMap((e) => e.match(/roost_[a-z_]+/g) ?? []));
  assert.deepEqual([...used].filter((f) => !sent.has(f)), []);
  const events = new Set(exprs.flatMap((e) => [...e.matchAll(/event_name="([^"]+)"/g)].map((m) => m[1])));
  assert.deepEqual([...events].filter((e) => !['roost.activity', 'roost.skill_used', 'roost.subagent_used', 'roost.command_used', 'roost.mcp_used', 'roost.verdict', 'rookery.policy', 'roost.run'].includes(e)), []);
});
