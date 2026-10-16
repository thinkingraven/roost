import type { EventName, Row } from './export/rows.js';
import { VERDICT_ORDER, type Verdict } from './verdicts.js';

/**
 * `roost merge`: combine several people's `roost export --format json` files into one team
 * report, with no server and no OpenTelemetry backend to set up. Each file is already counts
 * and names only (that's what `roost export` sends); merge just sums matching rows across people.
 */

export class InputError extends Error {}

export interface ExportFile {
  version: string;
  window: { from: string | null; to: string };
  team: string | null;
  person: string | null;
  rows: Row[];
}

/** Parse one `roost export --format json` file, checking only the fields roost merge uses. */
export function parseExportFile(text: string): ExportFile {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new InputError('not JSON. Make it with `roost export --format json`.'); }
  const d = data as Partial<ExportFile>;
  if (!d || typeof d !== 'object' || !Array.isArray(d.rows) || typeof d.window !== 'object' || d.window === null) {
    throw new InputError('not a roost export report. Make one with `roost export --format json`.');
  }
  return { version: d.version ?? '', window: { from: d.window.from ?? null, to: d.window.to ?? '' }, team: d.team ?? null, person: d.person ?? null, rows: d.rows };
}

export interface TeamAgent { agent: string; sessions: number; tokens: number }
/** An item (skill, subagent, command or MCP server) summed across people. `repo` is set only
 * when the source exports carried one (ROOST_REPO); without it, same-named items from different
 * repos can't be told apart, same tradeoff `roost export` already makes. */
export interface TeamCounted { name: string; repo?: string; count: number; people: number }
export interface TeamVerdict { kind: string; name: string; repo?: string; verdict: Verdict; uses: number; scopeSessions: number; issues: number; people: number }
export interface TeamPolicy { rule: string; blocked: number; warned: number }

export interface TeamReport {
  /** How many files were combined. */
  people: number;
  /** Distinct, non-null `team` labels across the files: more than one means a likely mistake. */
  teams: string[];
  window: { from: string | null; to: string };
  byAgent: TeamAgent[];
  skills: TeamCounted[];
  subagents: TeamCounted[];
  commands: TeamCounted[];
  mcp: TeamCounted[];
  /** Only populated when at least one file ran `roost export --rookery`. */
  verdicts: TeamVerdict[];
  /** Only populated when at least one file had rookery.policy rows (rookery's hook log). */
  policy: TeamPolicy[];
}

const COUNT_KEY: Partial<Record<EventName, string>> = {
  'roost.skill_used': 'runs', 'roost.subagent_used': 'runs', 'roost.command_used': 'uses', 'roost.mcp_used': 'calls',
};

function countedFor(files: ExportFile[], event: EventName): TeamCounted[] {
  const key = COUNT_KEY[event]!;
  const acc = new Map<string, { name: string; repo?: string; count: number; people: Set<number> }>();
  files.forEach((f, i) => {
    for (const r of f.rows) {
      if (r.event !== event || !r.item) continue;
      const k = `${r.repo ?? ''}\u0000${r.item.value}`;
      const a = acc.get(k) ?? { name: r.item.value, repo: r.repo, count: 0, people: new Set<number>() };
      a.count += r.values[key] ?? 0;
      a.people.add(i);
      acc.set(k, a);
    }
  });
  return [...acc.values()].map((a) => ({ name: a.name, ...(a.repo ? { repo: a.repo } : {}), count: a.count, people: a.people.size }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Combine several `roost export --format json` files into one team report. Pure: no files are read here. */
export function mergeExports(files: ExportFile[]): TeamReport {
  const froms = files.map((f) => f.window.from).filter((x): x is string => !!x).sort();
  const tos = files.map((f) => f.window.to).filter(Boolean).sort();
  const teams = [...new Set(files.map((f) => f.team).filter((t): t is string => !!t))];

  const agents = new Map<string, TeamAgent>();
  for (const f of files) for (const r of f.rows) {
    if (r.event !== 'roost.activity') continue;
    const a = agents.get(r.agent) ?? { agent: r.agent, sessions: 0, tokens: 0 };
    a.sessions += r.values.sessions ?? 0;
    a.tokens += (r.values['tokens.input'] ?? 0) + (r.values['tokens.cache_read'] ?? 0) + (r.values['tokens.cache_write'] ?? 0) + (r.values['tokens.output'] ?? 0);
    agents.set(r.agent, a);
  }

  const verdicts = new Map<string, { kind: string; name: string; repo?: string; uses: number; scopeSessions: number; issues: number; merge: boolean; people: Set<number> }>();
  files.forEach((f, i) => {
    for (const r of f.rows) {
      if (r.event !== 'roost.verdict' || !r.item) continue;
      const key = `${r.repo ?? ''}\u0000${r.item.key}\u0000${r.item.value}`;
      const v = verdicts.get(key) ?? { kind: r.item.key, name: r.item.value, repo: r.repo, uses: 0, scopeSessions: 0, issues: 0, merge: false, people: new Set<number>() };
      v.uses += r.values.uses ?? 0;
      v.scopeSessions += r.values.scope_sessions ?? 0;
      // issues: a static rookery finding count for this artifact, the same for everyone who scanned
      // it — take the largest report rather than summing N people's identical count into N×.
      v.issues = Math.max(v.issues, r.values.issues ?? 0);
      if (r.labels.verdict === 'merge') v.merge = true;
      v.people.add(i);
      verdicts.set(key, v);
    }
  });
  const teamVerdicts: TeamVerdict[] = [...verdicts.values()].map((v) => ({
    kind: v.kind, name: v.name, ...(v.repo ? { repo: v.repo } : {}), uses: v.uses, scopeSessions: v.scopeSessions, issues: v.issues, people: v.people.size,
    verdict: v.merge ? 'merge' : v.scopeSessions === 0 ? 'no-data' : v.uses === 0 ? 'retire' : v.issues > 0 ? 'improve' : 'keep',
  }));
  teamVerdicts.sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict) || b.uses - a.uses || a.name.localeCompare(b.name));

  const policy = new Map<string, TeamPolicy>();
  for (const f of files) for (const r of f.rows) {
    if (r.event !== 'rookery.policy' || !r.item) continue;
    const p = policy.get(r.item.value) ?? { rule: r.item.value, blocked: 0, warned: 0 };
    p.blocked += r.values.blocked ?? 0;
    p.warned += r.values.warned ?? 0;
    policy.set(r.item.value, p);
  }

  return {
    people: files.length,
    teams,
    window: { from: froms[0] ?? null, to: tos.at(-1) ?? '' },
    byAgent: [...agents.values()].sort((a, b) => b.sessions - a.sessions || a.agent.localeCompare(b.agent)),
    skills: countedFor(files, 'roost.skill_used'),
    subagents: countedFor(files, 'roost.subagent_used'),
    commands: countedFor(files, 'roost.command_used'),
    mcp: countedFor(files, 'roost.mcp_used'),
    verdicts: teamVerdicts,
    policy: [...policy.values()].sort((a, b) => (b.blocked + b.warned) - (a.blocked + a.warned) || a.rule.localeCompare(b.rule)),
  };
}
