import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentId } from '../sources.js';
import { agentDef } from '../usage/agents.js';
import type { SessionUsage } from '../usage/types.js';
import type { Judged } from '../verdicts.js';

/**
 * The rows `roost export` sends: small daily summaries, counts only.
 * One row per day × agent × repo (× item). Every row has a stable id, so a re-send can be deduplicated downstream.
 */

export type EventName =
  | 'roost.activity' | 'roost.skill_used' | 'roost.subagent_used' | 'roost.command_used' | 'roost.mcp_used'
  | 'roost.verdict' | 'rookery.policy' | 'roost.run';

export interface Row {
  event: EventName;
  day: string;                       // YYYY-MM-DD (UTC)
  agent: string;
  repo?: string;
  /** What the row is about: the skill, subagent, command, MCP server, policy rule… */
  item?: { key: string; value: string };
  /** Other labels (built-in or not, the policy decision, the verdict). */
  labels: Record<string, string>;
  /** The counts. */
  values: Record<string, number>;
}

export interface Identity { team?: string; person?: string; repoOf: (repoRoot: string | undefined) => string | undefined }

/** Rows from sessions split by day (`byDay`), one agent's or several. */
export function usageRows(sessions: SessionUsage[], id: Identity): Row[] {
  const rows = new Map<string, Row>();
  const sessionsOf = new Map<string, Set<string>>();
  const row = (event: EventName, s: SessionUsage, item?: Row['item'], labels: Record<string, string> = {}) => {
    const repo = id.repoOf(s.repo);
    const key = [event, s.day, s.agent, repo, item?.key, item?.value].join('\u0000');
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { event, day: s.day!, agent: s.agent, repo, item, labels, values: {} }));
    const seen = sessionsOf.get(key) ?? new Set<string>();
    seen.add(s.id);
    sessionsOf.set(key, seen);
    r.values.sessions = seen.size;
    return r;
  };
  const add = (r: Row, k: string, n: number) => { r.values[k] = (r.values[k] ?? 0) + n; };

  for (const s of sessions) {
    if (!s.day) continue;
    const def = agentDef(s.agent);
    const a = row('roost.activity', s);
    add(a, 'tokens.input', s.tokens.input);
    add(a, 'tokens.cache_read', s.tokens.cacheRead);
    add(a, 'tokens.cache_write', s.tokens.cacheWrite);
    add(a, 'tokens.output', s.tokens.output);
    for (const [name, n] of s.skills) { add(row('roost.skill_used', s, { key: 'skill', value: name }), 'runs', n); add(a, 'skill_runs', n); }
    for (const [name, n] of s.subagents) add(row('roost.subagent_used', s, { key: 'subagent', value: name }, { builtin: String(def.builtInSubagents.has(name.toLowerCase())) }), 'runs', n);
    for (const [name, n] of s.commands) add(row('roost.command_used', s, { key: 'command', value: name }, { builtin: String(def.builtInCommands.has(name)) }), 'uses', n);
    const servers = new Map<string, { calls: number; tools: Set<string> }>();
    for (const [key, n] of s.mcp) {
      const i = key.indexOf('/');
      const server = i > 0 ? key.slice(0, i) : key;
      const e = servers.get(server) ?? { calls: 0, tools: new Set<string>() };
      e.calls += n; e.tools.add(key.slice(i + 1));
      servers.set(server, e);
    }
    for (const [server, e] of servers) {
      const r = row('roost.mcp_used', s, { key: 'mcp_server', value: server });
      add(r, 'calls', e.calls);
      r.values.tools = Math.max(r.values.tools ?? 0, e.tools.size);
      add(a, 'mcp_calls', e.calls);
    }
  }
  for (const r of rows.values()) for (const k of ['tokens.input', 'tokens.cache_read', 'tokens.cache_write', 'tokens.output', 'skill_runs', 'mcp_calls']) {
    if (r.event === 'roost.activity') r.values[k] ??= 0;
  }
  return [...rows.values()];
}

/** rookery hook decisions (~/.rookery/decisions/YYYY-MM-DD.jsonl) for the days asked for: blocks and warnings per rule. */
export function policyRows(rookeryHome: string, days: Set<string> | null, until?: string): { rows: Row[]; skipped: number } {
  const rows = new Map<string, Row>();
  let skipped = 0;
  let files: string[] = [];
  try { files = readdirSync(join(rookeryHome, 'decisions')).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && (!days || days.has(f.slice(0, 10)))); } catch { /* no log */ }
  for (const f of files) {
    let text = '';
    try { text = readFileSync(join(rookeryHome, 'decisions', f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e: Record<string, unknown>;
      try { e = JSON.parse(line); } catch { skipped++; continue; }
      const day = typeof e.ts === 'string' ? e.ts.slice(0, 10) : f.slice(0, 10);
      const decision = e.decision === 'deny' ? 'blocked' : e.decision === 'warn' ? 'warned' : undefined;
      if (!decision || (days && !days.has(day))) continue;
      if (until && day > until) continue;
      // rookery calls Gemini CLI "gemini"; roost's rows use "gemini-cli", so dashboards filter both alike.
      const agent = e.agent === 'gemini' ? 'gemini-cli' : typeof e.agent === 'string' ? e.agent : 'unknown';
      const rule = typeof e.rule === 'string' ? e.rule : typeof e.key === 'string' ? e.key : 'hook-error';
      const setting = typeof e.key === 'string' ? e.key : '';
      // rookery logs the repo folder's name, so that's what's sent.
      const repo = typeof e.repo === 'string' ? e.repo : undefined;
      const key = [day, agent, repo, rule].join('\u0000');
      let r = rows.get(key);
      if (!r) rows.set(key, (r = { event: 'rookery.policy', day, agent, repo, item: { key: 'rule', value: rule }, labels: setting ? { setting } : {}, values: { blocked: 0, warned: 0 } }));
      r.values[decision]++;
    }
  }
  return { rows: [...rows.values()], skipped };
}

/** One row per judged skill, command or subagent: a snapshot, dated the last day exported. */
export function verdictRows(judged: Judged[], day: string, id: Identity, home: string): Row[] {
  return judged.map((j) => ({
    event: 'roost.verdict' as const,
    day,
    agent: j.agents.join('+'),
    repo: j.repo === '~' ? 'personal' : id.repoOf(j.repo.startsWith('~/') ? join(home, j.repo.slice(2)) : j.repo),
    item: { key: j.kind, value: j.name },
    labels: { verdict: j.verdict },
    // scope_sessions: sessions where it was available. Summed across people it tells "nobody used it" from "nobody worked there".
    values: { uses: j.uses, sessions: j.sessions, scope_sessions: j.scopeSessions, issues: j.issues.length },
  }));
}

export type PipelineOutcome = 'merged' | 'failed' | 'retried';

/** One CI job's agent run: `roost pipeline` (pipeline mode, for headless/CI agents). */
export interface PipelineRun {
  job: string;
  agent: string;
  outcome: PipelineOutcome;
  pr?: string;
  day: string;
  repo?: string;
  tokens: number;
  skills: number;
  mcpCalls: number;
}

/** One summary row per job: cost, skills used and the outcome, so a dashboard can show cost per
 * merged change and success rate. The skills themselves still come from the ordinary
 * `roost.skill_used` rows `usageRows` makes for the same session. */
export function pipelineRunRow(run: PipelineRun): Row {
  return {
    event: 'roost.run',
    day: run.day,
    agent: run.agent,
    repo: run.repo,
    item: { key: 'job', value: run.job },
    labels: { outcome: run.outcome, ...(run.pr ? { pr: run.pr } : {}) },
    values: { tokens: run.tokens, skills: run.skills, mcp_calls: run.mcpCalls },
  };
}

/** A stable id for a row: the same person, day, event, agent, repo and item always gives the same id. */
export function rowId(r: Row, person: string | undefined): string {
  return createHash('sha256').update([person ?? '', r.day, r.event, r.agent, r.repo ?? '', r.item?.key ?? '', r.item?.value ?? ''].join('\u0000')).digest('hex').slice(0, 32);
}

export const AGENT_IDS: AgentId[] = ['claude-code', 'codex', 'gemini-cli'];
