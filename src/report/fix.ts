import type { ApplyResult } from '../fix-apply.js';
import type { FixPlan } from '../fix.js';
import { VERSION } from '../version.js';
import { count, tilde } from './format.js';
import { style } from './style.js';

export interface FixView {
  plan: FixPlan;
  home: string;
  color?: boolean;
}

export function renderFixPreviewTerminal(v: FixView): string {
  const { bold, dim, amber } = style(v.color ?? false);
  const out: string[] = [];
  out.push(`${bold('roost')}${amber('.')} ${dim(`v${VERSION}`)}  ${dim('·')}  verdicts --fix  ${dim('·')}  preview: nothing changed`);

  const total = v.plan.repos.reduce((n, r) => n + r.changes.length, 0);
  if (!total) {
    out.push('', 'No retire or merge verdicts with a repo to branch from.', '');
    return out.join('\n');
  }

  out.push('', `${bold(count(v.plan.repos.length, 'repo'))} ready to branch`);
  const width = Math.max(...v.plan.repos.flatMap((r) => r.changes.map((c) => c.relPath.length)));
  for (const repo of v.plan.repos) {
    out.push('', `${bold(tilde(repo.repoRoot, v.home))}  ${dim(count(repo.changes.length, 'file'))}`);
    for (const c of repo.changes) out.push(`  ${dim('remove')}  ${c.relPath.padEnd(width)}  ${dim(c.reason)}`);
  }

  if (v.plan.personalSkipped) {
    const verb = v.plan.personalSkipped === 1 ? 'matches' : 'match';
    out.push('', dim(`${count(v.plan.personalSkipped, 'personal skill')} also ${verb} (~/…) — not touched, no repo to branch from.`));
  }

  out.push(
    '',
    'Preview only: nothing changed. Run with --write to create one branch per repo above and',
    'commit the removals (git only: never pushes, never opens a pull request — that part is on you).',
    '',
  );
  return out.join('\n');
}

export function renderFixPreviewJson(v: FixView): string {
  return JSON.stringify({
    tool: { name: 'roost', version: VERSION },
    write: false,
    repos: v.plan.repos.map((r) => ({ repoRoot: tilde(r.repoRoot, v.home), changes: r.changes })),
    personalSkipped: v.plan.personalSkipped,
  }, null, 2) + '\n';
}

export function renderFixApplyTerminal(result: ApplyResult, home: string, color?: boolean): string {
  const { bold, dim, amber } = style(color ?? false);
  const out: string[] = [];
  out.push(`${bold('roost')}${amber('.')} ${dim(`v${VERSION}`)}  ${dim('·')}  verdicts --fix --write`);

  let updated = 0;
  for (const r of result.repos) {
    out.push('', bold(tilde(r.repoRoot, home)));
    if (r.repoSkipReason) {
      out.push(`  ${dim('✗ skipped:')} ${r.repoSkipReason}`);
      continue;
    }
    if (r.applied.length) {
      updated++;
      out.push(`  ${amber('✓')} branch ${bold(r.branch!)}, ${count(r.applied.length, 'file')} removed and committed`);
      out.push(`  ${dim(`→ cd ${tilde(r.repoRoot, home)} && git push -u origin ${r.branch} && gh pr create`)}`);
    }
    for (const { change, reason } of r.skipped) out.push(`  ${dim(`✗ ${change.relPath}: ${reason}`)}`);
  }

  out.push('', `${updated} of ${count(result.repos.length, 'repo')} updated. Nothing was pushed.`, '');
  return out.join('\n');
}

export function renderFixApplyJson(result: ApplyResult, home: string): string {
  return JSON.stringify({
    tool: { name: 'roost', version: VERSION },
    write: true,
    repos: result.repos.map((r) => ({
      repoRoot: tilde(r.repoRoot, home),
      branch: r.branch ?? null,
      repoSkipReason: r.repoSkipReason ?? null,
      applied: r.applied,
      skipped: r.skipped,
    })),
  }, null, 2) + '\n';
}
