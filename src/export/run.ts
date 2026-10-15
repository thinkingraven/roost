import { join } from 'node:path';
import type { AgentDef } from '../usage/agents.js';
import type { SessionUsage } from '../usage/types.js';
import { dayOf } from '../usage/types.js';
import { judge, type RookeryReport } from '../verdicts.js';
import { compact, count } from '../report/format.js';
import { style } from '../report/style.js';
import { VERSION } from '../version.js';
import { exportConfig, safeUrl, type ExportConfig } from './config.js';
import { machineId, personId, repoLabel } from './identity.js';
import { otlpPayload } from './otlp.js';
import { policyRows, usageRows, verdictRows, rowId, type Row } from './rows.js';
import { BATCH, lastSentDay, postLogs, recordSent } from './send.js';

export interface ExportRequest {
  home: string;
  env: NodeJS.ProcessEnv;
  agents: readonly AgentDef[];
  /** --since: "7d", "YYYY-MM-DD" or "all"; default: the day after the last send, or the last 7 days. */
  since?: string;
  send: boolean;
  format: 'terminal' | 'json' | 'otlp';
  endpoint?: string;
  team?: string;
  rookery?: RookeryReport;
  top: number;
  color: boolean;
  now?: Date;
  fetchImpl?: typeof fetch;
}

export interface ExportResponse { stdout: string; stderr: string; exitCode: number }

const DAY = 86_400_000;
const addDays = (day: string, n: number) => dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY));

const EVENT_NOTES: Record<string, string> = {
  'roost.activity': 'sessions and tokens per day, agent and repo',
  'roost.skill_used': 'skill runs',
  'roost.subagent_used': 'subagent runs',
  'roost.command_used': 'slash commands',
  'roost.mcp_used': 'MCP server calls',
  'rookery.policy': 'what rookery\'s hook blocked or warned about',
  'roost.verdict': 'keep, fix, merge or retire, per skill',
};

/** The days to export: whole UTC days, up to and including yesterday. */
/** How far back a default send goes: most log stores (Loki among them) reject entries older than about a week. */
export const MAX_BACKFILL_DAYS = 7;

/** The days to export: whole UTC days, up to and including yesterday. */
export function exportWindow(since: string | undefined, last: string | undefined, now: Date): { from?: string; to: string; label: string; skippedBefore?: string } {
  const today = dayOf(now);
  const to = addDays(today, -1);
  if (since === 'all') return { to, label: `all time → ${to}` };
  let from: string;
  let skippedBefore: string | undefined;
  if (since) {
    const days = /^(\d+)d$/.exec(since);
    if (days) from = addDays(today, -Number(days[1]));
    else if (/^\d{4}-\d{2}-\d{2}$/.test(since) && !Number.isNaN(Date.parse(since))) from = since;
    else throw new Error(`--since must look like 7d, 2026-09-01 or all, not "${since}"`);
  } else {
    const oldest = addDays(today, -MAX_BACKFILL_DAYS);
    from = last ? addDays(last, 1) : oldest;
    if (from < oldest) { skippedBefore = from; from = oldest; }
  }
  return { from, to, label: from > to ? `nothing new after ${to}` : `${from} → ${to}`, skippedBefore };
}

export async function runExport(req: ExportRequest): Promise<ExportResponse> {
  const now = req.now ?? new Date();
  let config: ExportConfig;
  try { config = exportConfig(req.env, { endpoint: req.endpoint, team: req.team }); } catch (err) { return { stdout: '', stderr: `roost: ${(err as Error).message}\n`, exitCode: 2 }; }
  const last = config.logsUrl ? lastSentDay(req.home, config.logsUrl) : undefined;
  let window: ReturnType<typeof exportWindow>;
  try { window = exportWindow(req.since, last, now); } catch (err) { return { stdout: '', stderr: `roost: ${(err as Error).message}\n`, exitCode: 2 }; }
  if (req.send && !config.optedIn) {
    return { stdout: '', stderr: 'roost: sending needs an explicit yes. Set ROOST_EXPORT=on (or pass --endpoint). Nothing was sent.\n', exitCode: 2 };
  }
  if (req.send && !config.logsUrl) {
    return { stdout: '', stderr: 'roost: nowhere to send. Set OTEL_EXPORTER_OTLP_ENDPOINT (and the login in OTEL_EXPORTER_OTLP_HEADERS), or pass --endpoint. Nothing was sent.\n', exitCode: 2 };
  }

  const person = config.person === 'hashed' ? personId(config.salt, req.home) : undefined;
  const identity = { team: config.team, person, repoOf: (root: string | undefined) => repoLabel(root, config.repo) };
  const empty = window.from !== undefined && window.from > window.to;
  let rows: Row[] = [];
  let skipped = 0;
  if (!empty) {
    const since = window.from ? new Date(`${window.from}T00:00:00Z`) : undefined;
    const until = new Date(`${addDays(window.to, 1)}T00:00:00Z`);
    const split: SessionUsage[] = [];
    for (const def of req.agents) {
      const r = await def.read(req.home, since, { byDay: true, until });
      split.push(...r.sessions);
      skipped += r.skipped;
    }
    rows = usageRows(split, identity);
    const days = new Set(rows.map((r) => r.day));
    if (window.from) for (let d = window.from; d <= window.to; d = addDays(d, 1)) days.add(d);
    const policy = policyRows(req.env.ROOKERY_HOME ?? join(req.home, '.rookery'), window.from ? days : null, window.to);
    rows.push(...policy.rows);
    skipped += policy.skipped;
    if (req.rookery) {
      const whole: SessionUsage[] = [];
      for (const def of req.agents) whole.push(...(await def.read(req.home, since, { until })).sessions);
      rows.push(...verdictRows(judge(req.rookery, whole, req.home).judged, window.to, identity, req.home));
    }
    rows.sort((a, b) => a.day.localeCompare(b.day) || a.event.localeCompare(b.event) || a.agent.localeCompare(b.agent) || (a.repo ?? '').localeCompare(b.repo ?? '') || (a.item?.value ?? '').localeCompare(b.item?.value ?? ''));
  }

  const ctx = { team: config.team, person, instance: person ?? machineId(req.home), resource: config.resource, now };
  if (!req.send && req.format === 'otlp') return { stdout: JSON.stringify(otlpPayload(rows, ctx), null, 2) + '\n', stderr: '', exitCode: 0 };
  if (!req.send && req.format === 'json') {
    return { stdout: JSON.stringify({ version: VERSION, window: { from: window.from ?? null, to: window.to }, endpoint: config.logsUrl ? safeUrl(config.logsUrl) : null, team: config.team ?? null, person: person ?? null, rows: rows.map((r) => ({ ...r, rowId: rowId(r, person) })) }, null, 2) + '\n', stderr: '', exitCode: 0 };
  }

  if (req.send) {
    const url = config.logsUrl!;
    if (empty) return { stdout: `Up to date: ${safeUrl(url)} already has every day through ${window.to}.\n`, stderr: '', exitCode: 0 };
    const batches: object[] = [];
    for (let i = 0; i < rows.length; i += BATCH) batches.push(otlpPayload(rows.slice(i, i + BATCH), ctx));
    try {
      const result = rows.length ? await postLogs(url, config.headers, batches, req.fetchImpl) : { requests: 0, records: 0, rejected: 0 };
      recordSent(req.home, url, window.to);
      const msg = rows.length
        ? `Sent ${count(result.records, 'row')} for ${window.label} to ${safeUrl(url)} in ${count(result.requests, 'request')}.${result.rejected ? ` ${result.rejected} rejected by the backend.` : ''}\n`
        : `No agent activity in ${window.label}; nothing to send. Marked as sent.\n`;
      return { stdout: msg, stderr: '', exitCode: result.rejected ? 1 : 0 };
    } catch (err) {
      return { stdout: '', stderr: `roost: ${(err as Error).message}\nNothing was marked as sent; the next run tries these days again.\n`, exitCode: 1 };
    }
  }
  return { stdout: preview(req, config, window, rows, person, skipped), stderr: '', exitCode: 0 };
}

function preview(req: ExportRequest, config: ExportConfig, window: ReturnType<typeof exportWindow>, rows: Row[], person: string | undefined, skipped: number): string {
  const { bold, dim, amber } = style(req.color);
  const sep = `  ${dim('·')}  `;
  const out: string[] = [];
  out.push([`${bold('roost')}${amber('.')} ${dim(`v${VERSION}`)}`, 'export', window.label, dim('preview: nothing is sent')].join(sep), '');
  out.push(`  ${dim('Sends to'.padEnd(9))} ${config.logsUrl ? safeUrl(config.logsUrl) : 'nowhere yet: set OTEL_EXPORTER_OTLP_ENDPOINT, or pass --endpoint'}`);
  const as = [config.team ? `team ${config.team}` : 'no team (set ROOST_TEAM)', person ? `person ${person} (hashed)` : 'no person id', config.repo === 'remote' ? 'repos as host/org/repo' : config.repo === 'name' ? 'repos by folder name' : 'no repos'];
  out.push(`  ${dim('As'.padEnd(9))} ${as.join(dim(' · '))}`);
  out.push(`  ${dim('Opt-in'.padEnd(9))} ${config.optedIn ? 'yes' : 'no (set ROOST_EXPORT=on to allow --send)'}`);

  out.push('', `${bold('ROWS')}  ${dim(count(rows.length, 'row'))}`);
  if (!rows.length) out.push(`  ${dim(window.from && window.from > window.to ? `Every day through ${window.to} was already sent.` : 'No agent activity in this window.')}`);
  const byEvent = new Map<string, number>();
  for (const r of rows) byEvent.set(r.event, (byEvent.get(r.event) ?? 0) + 1);
  for (const [event, n] of byEvent) out.push(`  ${event.padEnd(20)} ${bold(String(n).padStart(4))}  ${dim(EVENT_NOTES[event] ?? '')}`);

  if (rows.length) {
    out.push('', `${bold('LATEST ROWS')}  ${dim('exactly what is sent, newest first')}`);
    const show = [...rows].reverse().slice(0, req.top);
    for (const r of show) {
      const values = Object.entries(r.values).filter(([, v]) => v).map(([k, v]) => `${k.replace('tokens.', '')} ${k.startsWith('tokens') ? compact(v) : v}`).join(' · ');
      const what = r.item ? `${r.item.key}=${r.item.value}` : '';
      out.push(`  ${dim(r.day)}  ${r.event.padEnd(19)} ${r.agent.padEnd(11)} ${(r.repo ?? '-').padEnd(26)} ${what}${what ? '  ' : ''}${dim(values)}`);
    }
    if (rows.length > show.length) out.push(dim(`  … ${rows.length - show.length} more (--top ${rows.length}, or --format json)`));
  }
  const notes = [...config.notes];
  if (window.skippedBefore) notes.push(`Days ${window.skippedBefore} to ${addDays(window.from!, -1)} weren't sent and are skipped: most log stores reject entries older than ${MAX_BACKFILL_DAYS} days.`);
  if (window.from && window.from < addDays(dayOf(req.now ?? new Date()), -MAX_BACKFILL_DAYS)) notes.push(`Days older than ${MAX_BACKFILL_DAYS} days may be rejected by log stores such as Loki.`);
  for (const n of notes) out.push('', `${amber('note')} ${n}`);
  if (skipped) out.push('', dim(`Skipped ${count(skipped, 'log line')} roost couldn't read.`));
  out.push('', dim(config.optedIn && config.logsUrl ? 'Nothing was sent. `roost export --send` sends these rows; --format otlp shows the exact payload.' : 'Nothing was sent. --format otlp shows the exact payload.'));
  out.push(dim('Only names, counts and dates: no prompts, replies, code, arguments or file paths.'), '');
  return out.join('\n');
}
