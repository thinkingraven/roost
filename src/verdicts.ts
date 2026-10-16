import { basename, dirname } from 'node:path';
import type { AgentId } from './sources.js';
import { agentDef } from './usage/agents.js';
import type { SessionUsage } from './usage/types.js';

/**
 * Verdicts: join what rookery found installed with what agents actually ran.
 *
 * rookery's JSON report says which skills, commands and subagents exist and what's wrong with them.
 * roost's session logs say which ones ran. Together: keep, improve, merge or retire each one.
 * Only names, counts and dates are used; never message text.
 */

export interface RookeryArtifact {
  id: string; repo: string; repoRoot?: string; relPath: string; agent: string; kind: string; name: string;
  links?: { relPath: string; agent: string }[];
  /** rookery 0.8.0+: what preloads before this artifact is invoked — name+description for a skill
   * or subagent, the whole file for anything always-on. Absent from older reports. */
  preloadTokens?: number;
}
export interface RookeryFinding { ruleId: string; severity: string; title: string; artifactId: string; confidence: string }
export interface RookeryCluster { members: { artifactId: string }[]; syncedFrom?: string }
export interface RookeryReport {
  tool: { name: string; version: string };
  scannedAt?: string;
  artifacts: RookeryArtifact[];
  findings: RookeryFinding[];
  clusters: RookeryCluster[];
}

export class InputError extends Error {}

/** Parse `rookery scan --format json`, checking only the fields roost uses. */
export function parseRookery(text: string): RookeryReport {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new InputError('the rookery report is not JSON. Make it with `rookery scan <folders> --local --format json`.'); }
  const d = data as Partial<RookeryReport>;
  if (!d || typeof d !== 'object' || d.tool?.name !== 'rookery' || !Array.isArray(d.artifacts)) {
    throw new InputError('that JSON is not a rookery report. Make one with `rookery scan <folders> --local --format json`.');
  }
  return { tool: d.tool, scannedAt: d.scannedAt, artifacts: d.artifacts, findings: Array.isArray(d.findings) ? d.findings : [], clusters: Array.isArray(d.clusters) ? d.clusters : [] };
}

export type Verdict = 'improve' | 'merge' | 'retire' | 'keep' | 'no-data';
export const VERDICT_ORDER: Verdict[] = ['improve', 'merge', 'retire', 'keep', 'no-data'];

export interface Judged {
  /** The rookery artifact id this verdict is about, for joining back to the report (`roost verdicts --fix`). */
  id: string;
  verdict: Verdict;
  name: string;
  kind: string;
  repo: string;            // ~/code/app, or ~ for personal ones
  relPath: string;
  uses: number;
  sessions: number;        // sessions that used it
  scopeSessions: number;   // sessions where it was available
  lastUsed: Date | null;
  issues: string[];        // titles of rookery findings to fix
  agents: AgentId[];       // the agents that load it
  mergeInto?: { relPath: string; repo: string; uses: number };
  /** Not used itself, but a namespaced copy with the same name was (a claude.ai or plugin skill). */
  copyUsed?: { name: string; uses: number };
  /** rookery 0.8.0+'s preloadTokens: what removing this would stop loading every session. Absent from older scans. */
  preloadTokens?: number;
}

export interface Unmatched { agent: AgentId; kind: 'skill' | 'command' | 'subagent'; name: string; uses: number }

export interface VerdictReport {
  judged: Judged[];
  /** Used in the logs but not in rookery's scan: plugins, built-ins, or repos the scan didn't cover. */
  unmatched: Unmatched[];
  /** rookery artifacts for agents whose logs roost doesn't read yet, by agent. */
  notJudged: Record<string, number>;
  /** True when rookery's report has no repoRoot (before 0.7.2), so repos were matched by folder name. */
  matchedByName: boolean;
  /** Sum of preloadTokens across retire and merge verdicts: a lower bound on what acting on them
   * would save, only as accurate as rookery's data (0 with no preloadTokens anywhere, pre-0.8.0). */
  tokensSavable: number;
}

const JUDGED_KINDS = new Set(['skill', 'command', 'subagent']);
/** rookery's agent ids → the agents whose logs roost reads. */
const READ_BY: Record<string, AgentId> = { 'claude-code': 'claude-code', codex: 'codex', gemini: 'gemini-cli' };
const ORDER: AgentId[] = ['claude-code', 'codex', 'gemini-cli'];

/**
 * Which agents load an artifact: the agent whose folder it's in, plus any agent folder it's linked into.
 * The shared `.agents/skills` folder is loaded by Codex and Gemini CLI (their skill docs and source), not by Claude Code.
 */
export function loadersOf(a: RookeryArtifact): AgentId[] {
  const set = new Set<AgentId>();
  if (READ_BY[a.agent]) set.add(READ_BY[a.agent]);
  if (a.agent === 'agent-skills' && /(^|\/)\.agents\/skills\//.test(a.relPath)) { set.add('codex'); set.add('gemini-cli'); }
  for (const l of a.links ?? []) if (READ_BY[l.agent]) set.add(READ_BY[l.agent]);
  return ORDER.filter((id) => set.has(id));
}
const SERIOUS = new Set(['critical', 'high', 'medium']);

/** Paths compared the same way on every OS: forward slashes, no trailing slash, any case on Windows. */
export function samePath(p: string, platform = process.platform): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? s.toLowerCase() : s;
}

/** The names an artifact answers to in the logs, as "skill:x", "command:/x" or "subagent:x" (lower case). */
function keysFor(a: RookeryArtifact): string[] {
  const names = new Set<string>();
  if (a.kind === 'skill') {
    names.add(a.name);
    // The folder name also invokes it, including the folders it's linked into (npx skills links ~/.agents/skills into ~/.claude/skills).
    for (const p of [a.relPath, ...(a.links ?? []).map((l) => l.relPath)]) {
      if (basename(p) === 'SKILL.md') names.add(basename(dirname(p)));
    }
    return [...names].flatMap((n) => [`skill:${n}`, `command:/${n}`].map((k) => k.toLowerCase()));
  }
  if (a.kind === 'command') {
    // .claude/commands/a/b.md and .gemini/commands/a/b.toml are /a:b; Codex's custom prompts were /prompts:name.
    const prompt = /(?:^|\/)\.codex\/prompts\/(.+)\.md$/.exec(a.relPath);
    const m = /(?:^|\/)commands\/(.+)\.(?:md|toml)$/.exec(a.relPath);
    const n = prompt ? `prompts:${prompt[1]}` : m ? m[1].split('/').join(':') : a.name;
    return [`command:/${n}`, `skill:${n}`].map((k) => k.toLowerCase());
  }
  return [`subagent:${a.name}`.toLowerCase()];
}

/** Judge every skill, command and subagent in rookery's report against the sessions of the agents that load it. */
export function judge(rookery: RookeryReport, sessions: SessionUsage[], home: string): VerdictReport {
  const matchedByName = rookery.artifacts.some((a) => a.repoRoot === undefined);
  const notJudged: Record<string, number> = {};
  const arts = rookery.artifacts.filter((a) => {
    if (!JUDGED_KINDS.has(a.kind)) return false;
    if (!loadersOf(a).length) { notJudged[a.agent] = (notJudged[a.agent] ?? 0) + 1; return false; }
    return true;
  });
  const loaders = new Map(arts.map((a) => [a.id, new Set(loadersOf(a))]));
  const personal = (a: RookeryArtifact) => a.repo === '~' || a.repoRoot === '~';
  const rootOf = (a: RookeryArtifact) => (a.repoRoot?.startsWith('~/') ? `${samePath(home)}/${samePath(a.repoRoot.slice(2))}` : samePath(a.repoRoot ?? ''));
  const inScope = (a: RookeryArtifact, s: SessionUsage) => {
    if (!loaders.get(a.id)!.has(s.agent)) return false;
    if (personal(a)) return true;
    if (!s.repo) return false;
    return a.repoRoot !== undefined ? rootOf(a) === samePath(s.repo) : basename(s.repo) === a.repo;
  };

  const stats = new Map(arts.map((a) => [a.id, { uses: 0, sessions: 0, scopeSessions: 0, lastUsed: null as Date | null }]));
  const unmatched = new Map<string, Unmatched>();

  for (const s of sessions) {
    const available = arts.filter((a) => inScope(a, s));
    // Personal skills win over project skills with the same name (Claude Code's docs), so they come first.
    available.sort((x, y) => Number(personal(y)) - Number(personal(x)));
    const byKey = new Map<string, RookeryArtifact>();
    for (const a of available) {
      stats.get(a.id)!.scopeSessions++;
      for (const k of keysFor(a)) if (!byKey.has(k)) byKey.set(k, a);
    }
    const used = new Set<string>();
    const credit = (kind: Unmatched['kind'], name: string, n: number) => {
      const a = byKey.get(`${kind}:${name}`.toLowerCase());
      if (!a) {
        const k = `${s.agent}:${kind}:${name}`;
        const u = unmatched.get(k) ?? { agent: s.agent, kind, name, uses: 0 };
        u.uses += n;
        unmatched.set(k, u);
        return;
      }
      const st = stats.get(a.id)!;
      st.uses += n;
      if (!used.has(a.id)) { used.add(a.id); st.sessions++; }
      if (s.last && (!st.lastUsed || s.last > st.lastUsed)) st.lastUsed = s.last;
    };
    for (const [name, n] of s.skills) credit('skill', name, n);
    const def = agentDef(s.agent);
    for (const [name, n] of s.commands) if (!def.builtInCommands.has(name)) credit('command', name, n);
    for (const [name, n] of s.subagents) if (!def.builtInSubagents.has(name.toLowerCase())) credit('subagent', name, n);
  }

  const issues = new Map<string, string[]>();
  for (const f of rookery.findings) {
    const fixable = f.ruleId.startsWith('RK-QLT-') ? f.severity !== 'info' : f.confidence === 'high' && SERIOUS.has(f.severity);
    if (!fixable || !stats.has(f.artifactId)) continue;
    const list = issues.get(f.artifactId) ?? [];
    if (!list.includes(f.title)) list.push(f.title);
    issues.set(f.artifactId, list);
  }

  // Duplicates: the copy people use most stays; the others merge into it.
  const mergeInto = new Map<string, RookeryArtifact>();
  for (const c of rookery.clusters) {
    if (c.syncedFrom) continue;
    const members = c.members.map((m) => arts.find((a) => a.id === m.artifactId)).filter((a): a is RookeryArtifact => !!a);
    if (members.length < 2) continue;
    const winner = [...members].sort((x, y) => stats.get(y.id)!.uses - stats.get(x.id)!.uses || stats.get(y.id)!.sessions - stats.get(x.id)!.sessions)[0];
    for (const m of members) if (m !== winner) mergeInto.set(m.id, winner);
  }

  // A namespaced skill (anthropic-skills:x from claude.ai, or plugin:x) that ran while the local x didn't.
  const namespaced = new Map<string, Unmatched>();
  for (const u of unmatched.values()) {
    const short = u.kind === 'skill' && u.name.includes(':') ? u.name.slice(u.name.lastIndexOf(':') + 1).toLowerCase() : '';
    if (short && (!namespaced.has(short) || namespaced.get(short)!.uses < u.uses)) namespaced.set(short, u);
  }

  const repoLabel = (a: RookeryArtifact) => (personal(a) ? '~' : a.repoRoot ?? a.repo);
  const judged: Judged[] = arts.map((a) => {
    const st = stats.get(a.id)!;
    const target = mergeInto.get(a.id);
    const found = issues.get(a.id) ?? [];
    const verdict: Verdict = target ? 'merge' : st.scopeSessions === 0 ? 'no-data' : st.uses === 0 ? 'retire' : found.length ? 'improve' : 'keep';
    return {
      id: a.id, verdict, name: a.name, kind: a.kind, repo: repoLabel(a), relPath: a.relPath,
      uses: st.uses, sessions: st.sessions, scopeSessions: st.scopeSessions, lastUsed: st.lastUsed, issues: found, agents: [...loaders.get(a.id)!],
      ...(target ? { mergeInto: { relPath: target.relPath, repo: repoLabel(target), uses: stats.get(target.id)!.uses } } : {}),
      ...(st.uses === 0 && a.kind === 'skill' && namespaced.has(a.name.toLowerCase()) ? { copyUsed: { name: namespaced.get(a.name.toLowerCase())!.name, uses: namespaced.get(a.name.toLowerCase())!.uses } } : {}),
      ...(a.preloadTokens !== undefined ? { preloadTokens: a.preloadTokens } : {}),
    };
  });
  judged.sort((x, y) => VERDICT_ORDER.indexOf(x.verdict) - VERDICT_ORDER.indexOf(y.verdict) || y.uses - x.uses || y.scopeSessions - x.scopeSessions || x.name.localeCompare(y.name));
  const tokensSavable = judged.filter((j) => j.verdict === 'retire' || j.verdict === 'merge').reduce((n, j) => n + (j.preloadTokens ?? 0), 0);

  return { judged, unmatched: [...unmatched.values()].sort((x, y) => y.uses - x.uses || x.name.localeCompare(y.name)), notJudged, matchedByName, tokensSavable };
}
