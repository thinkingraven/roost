import { join } from 'node:path';
import type { Judged, RookeryArtifact, RookeryReport, VerdictReport } from './verdicts.js';

/**
 * `roost verdicts --fix`: turn retire/merge verdicts into a plan of files to remove, grouped by
 * the repo they live in. Pure and side-effect free — `applyFix` in `fix-apply.ts` is what actually
 * touches disk and runs git, so this stays easy to test with synthetic data.
 *
 * Scope: project repos only. A personal skill (`~/.claude/skills/…`) has no repo to branch from,
 * so those are counted and reported, never touched.
 */

export interface FileChange {
  verdict: 'retire' | 'merge';
  name: string;
  kind: string;
  relPath: string;
  /** Absolute path on disk, resolved from the repo root (or home, for a personal item). */
  absolutePath: string;
  /** Why: "never used in 12 sessions", or "duplicate of <relPath>, used 40x there". */
  reason: string;
  /** rookery 0.8.0+'s preloadTokens: what removing this file would stop loading every session. Absent from older scans. */
  preloadTokens?: number;
}

export interface RepoFix {
  /** Absolute path to the repo root. */
  repoRoot: string;
  changes: FileChange[];
}

export interface FixPlan {
  repos: RepoFix[];
  /** retire/merge verdicts for personal (`~`) items: counted, never planned for removal. */
  personalSkipped: number;
  /** Sum of preloadTokens across every planned change: a lower bound, only as accurate as rookery's data. */
  tokensSavable: number;
}

function reasonFor(j: Judged): string {
  if (j.verdict === 'merge' && j.mergeInto) {
    return `duplicate of ${j.mergeInto.repo === j.repo ? '' : j.mergeInto.repo + '/'}${j.mergeInto.relPath}, used ${j.mergeInto.uses}× there`;
  }
  return `not used in ${j.scopeSessions} ${j.scopeSessions === 1 ? 'session' : 'sessions'} it was available`;
}

/** Resolves a `~/…` repoRoot against `home`; an already-absolute root is used as-is. */
function resolveRoot(repoRoot: string, home: string): string {
  return repoRoot.startsWith('~/') ? join(home, repoRoot.slice(2)) : repoRoot;
}

export function planFix(rookery: RookeryReport, report: VerdictReport, home: string): FixPlan {
  const byId = new Map<string, RookeryArtifact>(rookery.artifacts.map((a) => [a.id, a]));
  const repos = new Map<string, RepoFix>();
  let personalSkipped = 0;

  for (const j of report.judged) {
    if (j.verdict !== 'retire' && j.verdict !== 'merge') continue;
    const artifact = byId.get(j.id);
    if (!artifact) continue; // shouldn't happen: every Judged comes from an artifact in this same report

    if (j.repo === '~') {
      personalSkipped++;
      continue;
    }

    const root = resolveRoot(artifact.repoRoot ?? artifact.repo, home);
    const repoFix = repos.get(root) ?? { repoRoot: root, changes: [] };
    repoFix.changes.push({
      verdict: j.verdict,
      name: j.name,
      kind: j.kind,
      relPath: j.relPath,
      absolutePath: join(root, j.relPath),
      reason: reasonFor(j),
      ...(j.preloadTokens !== undefined ? { preloadTokens: j.preloadTokens } : {}),
    });
    repos.set(root, repoFix);
  }

  const tokensSavable = [...repos.values()].reduce((n, r) => n + r.changes.reduce((m, c) => m + (c.preloadTokens ?? 0), 0), 0);
  return { repos: [...repos.values()].sort((a, b) => a.repoRoot.localeCompare(b.repoRoot)), personalSkipped, tokensSavable };
}
