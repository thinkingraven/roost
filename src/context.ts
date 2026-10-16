import { join } from 'node:path';
import type { AgentId } from './sources.js';
import { totalInput } from './usage/aggregate.js';
import type { SessionUsage, Tokens } from './usage/types.js';
import type { RookeryArtifact, RookeryReport } from './verdicts.js';

/**
 * `roost context`: "context tax" — tokens loaded before anyone types a real prompt.
 *
 * Each reader (`usage/claude-code.ts`, `usage/codex.ts`, `usage/gemini.ts`) already tags a
 * session with `preload`: the usage of its first top-level turn (never a subagent's own first
 * turn), which is the system prompt, instructions, skill descriptions and MCP tool definitions,
 * all sent before any real exchange happens. `totalInput` (input + cache write + cache read,
 * never output) is what that turn's prompt actually cost in tokens.
 *
 * This is always a measured number, never a guess. With `--rookery` (rookery 0.8.0+, for its
 * `preloadTokens` field), part of it can also be attributed: a skill or subagent's name and
 * description, and a rules file's whole content, are exactly what rookery says they are. What's
 * left unattributed — the system prompt, MCP tool-definition schemas — isn't something rookery
 * can see yet, and the report says so rather than guessing at it.
 */

/** Kinds whose `preloadTokens` genuinely represents preload cost, not just file size. */
const ATTRIBUTABLE_KINDS = new Set(['skill', 'subagent', 'rules']);

/** Resolves a `~/…` repoRoot against `home`; an already-absolute root is used as-is. */
function resolveRoot(repoRoot: string, home: string): string {
  return repoRoot.startsWith('~/') ? join(home, repoRoot.slice(2)) : repoRoot;
}

export interface AttributedArtifact {
  name: string;
  kind: string;
  preloadTokens: number;
}

export interface Attribution {
  /** Sum of every matched artifact's preloadTokens: a lower bound, never the whole preload. */
  total: number;
  artifacts: AttributedArtifact[];
}

/** Every skill, subagent and rules file that would preload into a session in this repo: project
 * artifacts whose repo root matches, plus personal ones (`~`), which apply everywhere. */
function attributeRepo(rookery: RookeryReport, repoRoot: string, home: string): Attribution {
  const matches = rookery.artifacts.filter((a: RookeryArtifact) => {
    if (!ATTRIBUTABLE_KINDS.has(a.kind)) return false;
    if (a.repo === '~' || a.repoRoot === '~') return true;
    return resolveRoot(a.repoRoot ?? a.repo, home) === repoRoot;
  });
  const artifacts = matches
    .map((a) => ({ name: a.name, kind: a.kind, preloadTokens: a.preloadTokens ?? 0 }))
    .sort((a, b) => b.preloadTokens - a.preloadTokens);
  return { total: artifacts.reduce((sum, a) => sum + a.preloadTokens, 0), artifacts };
}

export interface PreloadSession {
  agent: AgentId;
  repo?: string;
  when?: Date;
  preload: Tokens;
  total: number;
}

export interface RepoTrend {
  repo: string;
  sessions: number;
  average: number;
  earliest?: { when: Date; total: number };
  /** Undefined when there's only one measured session for this repo: nothing to compare yet. */
  latest?: { when: Date; total: number };
  /** Only with `--rookery`: what rookery can account for in this repo's preload. */
  attributed?: Attribution;
}

export interface ContextReport {
  measured: number;
  unmeasured: number;
  /** Per-field average across measured sessions (so the terminal/cache split stays visible). */
  average: Tokens;
  byAgent: { agent: AgentId; sessions: number; average: number }[];
  byRepo: RepoTrend[];
  /** Measured sessions, heaviest first. */
  heaviest: PreloadSession[];
  /** Whether `--rookery` was given at all (each repo's own `attributed` can still be empty). */
  hasRookery: boolean;
}

function emptyTokens(): Tokens {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
}

/** Groups and averages each session's preload: by agent, by repo (with a trend), and the heaviest overall.
 * `rookery` (optional, piped in from `rookery scan --format json`) attributes part of each repo's
 * average to specific skills, subagents and rules files, via their `preloadTokens`. */
export function aggregateContext(sessions: SessionUsage[], rookery?: RookeryReport, home = ''): ContextReport {
  const measured: PreloadSession[] = sessions
    .filter((s): s is SessionUsage & { preload: Tokens } => !!s.preload)
    .map((s) => ({ agent: s.agent, repo: s.repo, when: s.first, preload: s.preload, total: totalInput(s.preload) }));

  const average = emptyTokens();
  for (const m of measured) {
    average.input += m.preload.input;
    average.cacheWrite += m.preload.cacheWrite;
    average.cacheRead += m.preload.cacheRead;
    average.output += m.preload.output;
  }
  if (measured.length) {
    average.input = Math.round(average.input / measured.length);
    average.cacheWrite = Math.round(average.cacheWrite / measured.length);
    average.cacheRead = Math.round(average.cacheRead / measured.length);
    average.output = Math.round(average.output / measured.length);
  }

  const byAgentMap = new Map<AgentId, { sessions: number; total: number }>();
  for (const m of measured) {
    const a = byAgentMap.get(m.agent) ?? { sessions: 0, total: 0 };
    a.sessions++;
    a.total += m.total;
    byAgentMap.set(m.agent, a);
  }
  const byAgent = [...byAgentMap].map(([agent, a]) => ({ agent, sessions: a.sessions, average: Math.round(a.total / a.sessions) })).sort((a, b) => b.average - a.average);

  const byRepoMap = new Map<string, PreloadSession[]>();
  for (const m of measured) {
    if (!m.repo) continue;
    const list = byRepoMap.get(m.repo) ?? [];
    list.push(m);
    byRepoMap.set(m.repo, list);
  }
  const byRepo: RepoTrend[] = [...byRepoMap].map(([repo, list]) => {
    const sorted = [...list].sort((a, b) => (a.when?.getTime() ?? 0) - (b.when?.getTime() ?? 0));
    const total = sorted.reduce((sum, m) => sum + m.total, 0);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    return {
      repo,
      sessions: sorted.length,
      average: Math.round(total / sorted.length),
      earliest: first.when ? { when: first.when, total: first.total } : undefined,
      latest: last !== first && last.when ? { when: last.when, total: last.total } : undefined,
      attributed: rookery ? attributeRepo(rookery, repo, home) : undefined,
    };
  }).sort((a, b) => b.average - a.average);

  const heaviest = [...measured].sort((a, b) => b.total - a.total);

  return { measured: measured.length, unmeasured: sessions.length - measured.length, average, byAgent, byRepo, heaviest, hasRookery: !!rookery };
}
