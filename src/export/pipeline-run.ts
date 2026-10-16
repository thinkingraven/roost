import type { AgentDef } from '../usage/agents.js';
import { totalTokens } from '../usage/aggregate.js';
import { dayOf } from '../usage/types.js';
import { compact } from '../report/format.js';
import { style } from '../report/style.js';
import { VERSION } from '../version.js';
import { exportConfig, safeUrl, type ExportConfig } from './config.js';
import { machineId, repoLabel } from './identity.js';
import { otlpPayload } from './otlp.js';
import { pipelineRunRow, rowId, usageRows, type PipelineOutcome, type Row } from './rows.js';
import { postLogs } from './send.js';

/**
 * `roost pipeline`: one CI job's agent run, as a `roost.run` row (plus the same `roost.skill_used`
 * etc. rows `roost export` already makes), for a dashboard built on headless/CI runs — "the
 * factory" rather than a person's own session. Call it once, at the end of the job, in the same
 * runner the agent used: it reads whichever session is newest under `home`.
 *
 * Shares export's config, identity and OTLP code on purpose: same opt-in (`ROOST_EXPORT=on` or
 * `--endpoint`), same endpoint settings, same one network call.
 */

export interface PipelineRequest {
  home: string;
  env: NodeJS.ProcessEnv;
  agent: AgentDef;
  job: string;
  outcome: PipelineOutcome;
  pr?: string;
  send: boolean;
  format: 'terminal' | 'json' | 'otlp';
  endpoint?: string;
  team?: string;
  color: boolean;
  now?: Date;
  fetchImpl?: typeof fetch;
}

export interface PipelineResponse { stdout: string; stderr: string; exitCode: number }

export async function runPipeline(req: PipelineRequest): Promise<PipelineResponse> {
  let config: ExportConfig;
  try { config = exportConfig(req.env, { endpoint: req.endpoint, team: req.team }); } catch (err) {
    return { stdout: '', stderr: `roost: ${(err as Error).message}\n`, exitCode: 2 };
  }
  if (req.send && !config.optedIn) {
    return { stdout: '', stderr: 'roost: sending needs an explicit yes. Set ROOST_EXPORT=on (or pass --endpoint). Nothing was sent.\n', exitCode: 2 };
  }
  if (req.send && !config.logsUrl) {
    return { stdout: '', stderr: 'roost: nowhere to send. Set OTEL_EXPORTER_OTLP_ENDPOINT (and the login in OTEL_EXPORTER_OTLP_HEADERS), or pass --endpoint. Nothing was sent.\n', exitCode: 2 };
  }

  const { sessions } = await req.agent.read(req.home, undefined, { byDay: true });
  if (!sessions.length) {
    return { stdout: '', stderr: `roost: no ${req.agent.name} session found under ${req.home}. Run roost pipeline at the end of the job, after the agent ran.\n`, exitCode: 2 };
  }
  const latest = [...sessions].sort((a, b) => (b.last?.getTime() ?? 0) - (a.last?.getTime() ?? 0))[0];
  const day = latest.day ?? dayOf(latest.last ?? req.now ?? new Date());
  const identity = { repoOf: (root: string | undefined) => repoLabel(root, config.repo) };
  const repo = identity.repoOf(latest.repo);

  const rows: Row[] = usageRows([latest], identity);
  rows.push(pipelineRunRow({
    job: req.job, agent: latest.agent, outcome: req.outcome, pr: req.pr, day, repo,
    tokens: totalTokens(latest.tokens), skills: latest.skills.size,
    mcpCalls: [...latest.mcp.values()].reduce((a, b) => a + b, 0),
  }));

  const ctx = { team: config.team, instance: machineId(req.home), resource: config.resource, now: req.now };
  if (!req.send && req.format === 'otlp') return { stdout: JSON.stringify(otlpPayload(rows, ctx), null, 2) + '\n', stderr: '', exitCode: 0 };
  if (!req.send && req.format === 'json') {
    return {
      stdout: JSON.stringify({ version: VERSION, job: req.job, day, repo: repo ?? null, endpoint: config.logsUrl ? safeUrl(config.logsUrl) : null, rows: rows.map((r) => ({ ...r, rowId: rowId(r, undefined) })) }, null, 2) + '\n',
      stderr: '', exitCode: 0,
    };
  }

  if (req.send) {
    const url = config.logsUrl!;
    try {
      const result = await postLogs(url, config.headers, [otlpPayload(rows, ctx)], req.fetchImpl);
      const msg = `Sent ${rows.length} rows for job ${req.job} to ${safeUrl(url)}.${result.rejected ? ` ${result.rejected} rejected by the backend.` : ''}\n`;
      return { stdout: msg, stderr: '', exitCode: result.rejected ? 1 : 0 };
    } catch (err) {
      return { stdout: '', stderr: `roost: ${(err as Error).message}\n`, exitCode: 1 };
    }
  }

  return { stdout: preview(req, config, { job: req.job, day, repo, tokens: totalTokens(latest.tokens), skills: latest.skills.size }), stderr: '', exitCode: 0 };
}

function preview(req: PipelineRequest, config: ExportConfig, summary: { job: string; day: string; repo?: string; tokens: number; skills: number }): string {
  const { bold, dim, amber } = style(req.color);
  const sep = `  ${dim('·')}  `;
  const out: string[] = [];
  out.push([`${bold('roost')}${amber('.')} ${dim(`v${VERSION}`)}`, 'pipeline', dim('preview: nothing is sent')].join(sep), '');
  out.push(`  ${dim('Job'.padEnd(9))} ${summary.job}`);
  out.push(`  ${dim('Agent'.padEnd(9))} ${req.agent.name}`);
  out.push(`  ${dim('Repo'.padEnd(9))} ${summary.repo ?? '(unknown)'}`);
  out.push(`  ${dim('Outcome'.padEnd(9))} ${req.outcome}${req.pr ? dim(` (pr ${req.pr})`) : ''}`);
  out.push(`  ${dim('Day'.padEnd(9))} ${summary.day}`);
  out.push(`  ${dim('Tokens'.padEnd(9))} ${compact(summary.tokens)}`);
  out.push(`  ${dim('Skills'.padEnd(9))} ${summary.skills}`);
  out.push('', `  ${dim('Sends to'.padEnd(9))} ${config.logsUrl ? safeUrl(config.logsUrl) : 'nowhere yet: set OTEL_EXPORTER_OTLP_ENDPOINT, or pass --endpoint'}`);
  out.push(`  ${dim('Opt-in'.padEnd(9))} ${config.optedIn ? 'yes' : 'no (set ROOST_EXPORT=on to allow --send)'}`);
  // Pipeline rows carry no person id, so a note about salting one doesn't apply here.
  for (const n of config.notes.filter((note) => !note.includes('ROOST_PERSON_SALT'))) out.push('', `${amber('note')} ${n}`);
  out.push('', dim(config.optedIn && config.logsUrl ? 'Nothing was sent. `roost pipeline --send` sends this; --format otlp shows the exact payload.' : 'Nothing was sent. --format otlp shows the exact payload.'), '');
  return out.join('\n');
}
