#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { findSources } from './sources.js';
import { renderSourcesJson, renderSourcesTerminal } from './report/sources.js';
import { renderUsageJson, renderUsageTerminal, type UsageView } from './report/usage.js';
import { useColor } from './report/style.js';
import { aggregate } from './usage/aggregate.js';
import { AGENTS, type AgentDef } from './usage/agents.js';
import { renderVerdictsJson, renderVerdictsTerminal } from './report/verdicts.js';
import { InputError, judge, parseRookery } from './verdicts.js';
import { planFix } from './fix.js';
import { applyFix } from './fix-apply.js';
import { renderFixApplyJson, renderFixApplyTerminal, renderFixPreviewJson, renderFixPreviewTerminal } from './report/fix.js';
import { aggregateDecisions, readDecisions } from './decisions.js';
import { renderDecisionsJson, renderDecisionsTerminal } from './report/decisions.js';
import { aggregateContext } from './context.js';
import { renderContextJson, renderContextTerminal } from './report/context.js';
import { runExport } from './export/run.js';
import { runPipeline } from './export/pipeline-run.js';
import type { PipelineOutcome } from './export/rows.js';
import { VERSION } from './version.js';

const HELP = `roost v${VERSION}: see what your AI agents actually use.

Usage
  roost usage                    Skills, subagents, MCP servers and commands your agents
                                 actually ran, with token use, per repo (Claude Code, Codex, Gemini CLI)
  roost verdicts                 Keep, fix, merge or retire each skill: rookery's inventory joined
                                 with what your agents actually ran. Pipe rookery's JSON in:
                                   rookery scan ~/code --local --format json | roost verdicts
  roost verdicts --fix           Preview: a branch and commit, per repo, removing the retire/merge
                                 verdicts above (--write applies it; never pushes, never opens a PR)
  roost export                   Preview the daily, counts-only summaries roost can send to your
                                 company's OpenTelemetry backend (Grafana, Loki, OpenObserve, a Collector)
  roost export --send            Send the finished days not sent yet. Needs ROOST_EXPORT=on and
                                 OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_HEADERS
  roost decisions                What rookery's runtime hook denied or warned about, by rule, agent and repo
  roost context                  Context tax: tokens loaded before anyone types a real prompt, per session
  roost pipeline --agent <a> --outcome <merged|failed|retried>
                                 One CI job's agent run: cost, skills used and the outcome.
                                 Call it once, at the end of the job. Preview by default; --send
                                 posts it the same way roost export does (ROOST_EXPORT=on)
  roost sources                  Find each agent's session logs on this machine

Options
  --since <30d|YYYY-MM-DD|all>   Time window (default: 30d; for export, the days not sent yet, or 7d)
                                 (decisions reads ~/.rookery/decisions, not agent session logs)
  --agent <name>                 claude-code, codex, gemini or all (default: all with sessions;
                                 pipeline needs exactly one, not all)
  --rookery <file>               rookery's JSON report for verdicts (or pipe it in; - reads stdin)
  --fix                          verdicts: preview removing retire/merge verdicts, repo by repo
  --write                        verdicts --fix: actually branch, remove and commit (git only)
  --job <id>                     pipeline: a job id (default: inferred from GITHUB_RUN_ID etc.)
  --outcome <merged|failed|retried>
                                 pipeline: what happened to the change the agent made (required)
  --pr <id>                      pipeline: the pull request or ticket id, if there is one
  --top <n>                      Rows per section in the terminal report (default: 10)
  --format <terminal|json>       Output format (default: terminal); export and pipeline also take otlp
  --send                         export, pipeline: send to the configured endpoint (the only network use)
  --endpoint <url>               export, pipeline: OTLP/HTTP base URL instead of OTEL_EXPORTER_OTLP_ENDPOINT
  --team <name>                  export, pipeline: team label (or ROOST_TEAM)
  --home <dir>                   Look in this home folder instead of yours
  --no-color                     Disable colours (also respects NO_COLOR; FORCE_COLOR forces them)
  -v, --version                  Print the version
  -h, --help                     Show this help

roost runs locally. Only \`--send\` (export or pipeline) uses the network, to the endpoint you configure.
Everything roost reports or sends carries names, counts and dates only.
`;

function fail(msg: string): never {
  process.stderr.write(`roost: ${msg}\n\nRun \`roost --help\` for usage.\n`);
  process.exit(2);
}

/** "30d", "2026-09-01" or "all" → a start date (undefined = all time) and a label for the report. */
export function parseSince(value: string, now = new Date()): { since?: Date; window: string } {
  if (value === 'all') return { window: 'all time' };
  const days = /^(\d+)d$/.exec(value);
  if (days) {
    const n = Number(days[1]);
    if (n < 1) fail('--since needs at least 1d');
    return { since: new Date(now.getTime() - n * 86_400_000), window: n === 1 ? 'last day' : `last ${n} days` };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const since = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(since.getTime())) return { since, window: `since ${value}` };
  }
  fail(`--since must look like 30d, 2026-09-01 or all, not "${value}"`);
}

/** A job id from the CI env vars roost knows, or undefined if none are set. */
function inferJob(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GITHUB_RUN_ID) return `gh-${env.GITHUB_RUN_ID}${env.GITHUB_RUN_ATTEMPT && env.GITHUB_RUN_ATTEMPT !== '1' ? `-${env.GITHUB_RUN_ATTEMPT}` : ''}`;
  if (env.CI_JOB_ID) return `gl-${env.CI_JOB_ID}`;
  if (env.BUILD_ID) return `build-${env.BUILD_ID}`;
  return undefined;
}

/** All of stdin (async: a synchronous read of a non-blocking pipe can fail with EAGAIN). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        since: { type: 'string' },
        send: { type: 'boolean', default: false },
        endpoint: { type: 'string' },
        team: { type: 'string' },
        top: { type: 'string', default: '10' },
        format: { type: 'string', default: 'terminal' },
        home: { type: 'string' },
        rookery: { type: 'string' },
        fix: { type: 'boolean', default: false },
        write: { type: 'boolean', default: false },
        job: { type: 'string' },
        outcome: { type: 'string' },
        pr: { type: 'string' },
        agent: { type: 'string', default: 'all' },
        'no-color': { type: 'boolean', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    fail((err as Error).message);
  }
  const { values: o, positionals } = parsed;
  if (o.help) { process.stdout.write(HELP); return 0; }
  if (o.version) { process.stdout.write(`${VERSION}\n`); return 0; }
  if (positionals.length === 0) { process.stdout.write(HELP); return 0; }

  const [command, ...rest] = positionals;
  if (!['sources', 'usage', 'verdicts', 'export', 'decisions', 'context', 'pipeline'].includes(command)) fail(`unknown command "${command}"`);
  if (rest.length) fail(`unexpected argument "${rest[0]}"`);
  const otlpOk = command === 'export' || command === 'pipeline';
  if (o.format !== 'terminal' && o.format !== 'json' && !(otlpOk && o.format === 'otlp')) fail(`--format must be terminal or json${otlpOk ? ' or otlp' : ''}, not "${o.format}"`);
  if (!otlpOk && (o.send || o.endpoint || o.team)) fail('--send, --endpoint and --team are options of roost export and roost pipeline');
  if (command !== 'pipeline' && (o.job || o.outcome || o.pr)) fail('--job, --outcome and --pr are options of roost pipeline');
  if (command !== 'verdicts' && (o.fix || o.write)) fail('--fix and --write are options of roost verdicts');
  if (o.write && !o.fix) fail('--write needs --fix');
  const home = o.home ? resolve(o.home) : homedir();
  const color = useColor(o['no-color']);

  if (command === 'sources') {
    const sources = findSources(home);
    process.stdout.write(o.format === 'json' ? renderSourcesJson(sources, home) : renderSourcesTerminal(sources, home, color));
    return 0;
  }

  if (command === 'decisions') {
    if (o.agent !== 'all') fail('--agent is not an option of roost decisions: its own log names agents (claude-code, codex, gemini, cursor, copilot, windsurf)');
    const top = Number(o.top);
    if (!Number.isInteger(top) || top < 1) fail(`--top must be a whole number of 1 or more, not "${o.top}"`);
    const { since, window } = parseSince(o.since ?? '30d');
    const rookeryHome = process.env.ROOKERY_HOME ?? join(home, '.rookery');
    const { decisions, skipped, found } = await readDecisions(rookeryHome, since);
    const view = { report: aggregateDecisions(decisions, skipped), found, window, top, color };
    process.stdout.write(o.format === 'json' ? renderDecisionsJson(view) : renderDecisionsTerminal(view));
    return 0;
  }

  if (command === 'pipeline') {
    const def = AGENTS.find((a) => a.flag === o.agent);
    if (!def) fail(`pipeline needs exactly one --agent (${AGENTS.map((a) => a.flag).join(', ')}), not "${o.agent}"`);
    if (!o.outcome) fail('pipeline needs --outcome merged, failed or retried');
    if (o.outcome !== 'merged' && o.outcome !== 'failed' && o.outcome !== 'retried') fail(`--outcome must be merged, failed or retried, not "${o.outcome}"`);
    const job = o.job ?? inferJob(process.env) ?? `job-${Date.now()}`;
    const r = await runPipeline({
      home, env: process.env, agent: def, job, outcome: o.outcome as PipelineOutcome, pr: o.pr,
      send: o.send as boolean, format: o.format as 'terminal' | 'json' | 'otlp', endpoint: o.endpoint, team: o.team, color,
    });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    return r.exitCode;
  }

  const flags = ['all', ...AGENTS.map((a) => a.flag)];
  if (!flags.includes(o.agent as string)) fail(`--agent must be ${flags.slice(1).join(', ')} or all, not "${o.agent}"`);
  const chosen: readonly AgentDef[] = o.agent === 'all' ? AGENTS : AGENTS.filter((a) => a.flag === o.agent);
  const top = Number(o.top);
  if (!Number.isInteger(top) || top < 1) fail(`--top must be a whole number of 1 or more, not "${o.top}"`);
  if (command === 'export') {
    let rookery;
    if (o.rookery) {
      try { rookery = parseRookery(o.rookery === '-' ? await readStdin() : readFileSync(o.rookery, 'utf8')); } catch (err) {
        if (err instanceof InputError) fail(err.message);
        fail(`can't read ${o.rookery}: ${(err as Error).message}`);
      }
    }
    const r = await runExport({
      home, env: process.env, agents: chosen, since: o.since, send: o.send as boolean, format: o.format as 'terminal' | 'json' | 'otlp',
      endpoint: o.endpoint, team: o.team, rookery, top, color,
    });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    return r.exitCode;
  }
  const { since, window } = parseSince(o.since ?? '30d');
  if (command === 'verdicts') {
    const source = o.rookery ?? (process.stdin.isTTY ? undefined : '-');
    if (!source) fail('verdicts needs rookery\'s JSON report. Pipe it in:\n  rookery scan ~/code --local --format json | roost verdicts\nor save it and pass --rookery report.json');
    let rookery;
    try {
      rookery = parseRookery(source === '-' ? await readStdin() : readFileSync(source, 'utf8'));
    } catch (err) {
      if (err instanceof InputError) fail(err.message);
      fail(`can't read ${source === '-' ? 'stdin' : source}: ${(err as Error).message}`);
    }
    const read = await Promise.all(chosen.map(async (def) => ({ def, ...(await def.read(home, since)) })));
    const sessions = read.flatMap((r) => r.sessions);
    let first: Date | null = null, last: Date | null = null;
    for (const s of sessions) {
      if (s.first && (!first || s.first < first)) first = s.first;
      if (s.last && (!last || s.last > last)) last = s.last;
    }
    const report = judge(rookery, sessions, home);
    if (o.fix) {
      const plan = planFix(rookery, report, home);
      if (o.write) {
        const result = applyFix(plan);
        process.stdout.write(o.format === 'json' ? renderFixApplyJson(result, home) : renderFixApplyTerminal(result, home, color));
      } else {
        process.stdout.write(o.format === 'json' ? renderFixPreviewJson({ plan, home, color }) : renderFixPreviewTerminal({ plan, home, color }));
      }
      return 0;
    }
    const view = {
      report, window, sessions: sessions.length, first, last,
      agents: read.map((r) => ({ id: r.def.id, sessions: r.sessions.length })),
      rookery: { version: rookery.tool.version, scannedAt: rookery.scannedAt }, top, color,
    };
    process.stdout.write(o.format === 'json' ? renderVerdictsJson(view) : renderVerdictsTerminal(view));
    return 0;
  }
  if (command === 'context') {
    const read = await Promise.all(chosen.map((def) => def.read(home, since)));
    const sessions = read.flatMap((r) => r.sessions);
    const view = { report: aggregateContext(sessions), window, home, top, color };
    process.stdout.write(o.format === 'json' ? renderContextJson(view) : renderContextTerminal(view));
    return 0;
  }

  const read = await Promise.all(chosen.map(async (def) => ({ def, ...(await def.read(home, since)) })));
  const views = read.map(({ def, sessions, skipped }) => ({
    agent: def.id,
    view: { report: aggregate(sessions, skipped, since), agentName: def.name, builtInCommands: def.builtInCommands, window, home, top, color } as UsageView,
  }));
  // With --agent all, show the agents that have sessions; name one agent to see it even when it has none.
  const shown = o.agent === 'all' ? views.filter((v) => v.view.report.sessions > 0) : views;
  if (o.format === 'json') process.stdout.write(renderUsageJson(shown, window));
  else if (!shown.length) process.stdout.write(renderUsageTerminal(views[0].view).replace(`No ${views[0].view.agentName} sessions found.`, `No ${AGENTS.map((a) => a.name).join(', ').replace(/, ([^,]+)$/, ' or $1')} sessions found.`));
  else process.stdout.write(shown.map((v, i) => renderUsageTerminal({ ...v.view, noFooter: i < shown.length - 1 })).join('\n'));
  return 0;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
