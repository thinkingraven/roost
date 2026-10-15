import { agentDef } from '../usage/agents.js';
import type { AgentId } from '../sources.js';
import type { ContextReport, RepoTrend } from '../context.js';
import { VERSION } from '../version.js';
import { compact, count, day, tilde } from './format.js';
import { style } from './style.js';

export interface ContextView {
  report: ContextReport;
  /** "last 30 days", "since 2026-09-01" or "all time" */
  window: string;
  home: string;
  top: number;
  color?: boolean;
}

const GROWTH_THRESHOLD = 0.25;

function trendNote(t: RepoTrend): string | undefined {
  if (!t.earliest || !t.latest) return undefined;
  const change = t.earliest.total > 0 ? (t.latest.total - t.earliest.total) / t.earliest.total : 0;
  const arrow = `${compact(t.earliest.total)} → ${compact(t.latest.total)} since ${day(t.earliest.when)}`;
  if (change > GROWTH_THRESHOLD) return `growing: ${arrow} (+${Math.round(change * 100)}%)`;
  if (change < -GROWTH_THRESHOLD) return `shrinking: ${arrow} (${Math.round(change * 100)}%)`;
  return `steady: ${arrow}`;
}

export function renderContextTerminal(v: ContextView): string {
  const { bold, dim, amber } = style(v.color ?? false);
  const r = v.report;
  const sep = `  ${dim('·')}  `;
  const out: string[] = [];
  const total = r.measured + r.unmeasured;
  const head = [`${bold('roost')}${amber('.')} ${dim(`v${VERSION}`)}`, 'context', dim('tokens loaded before the first prompt'), v.window];
  if (total) head.push(r.unmeasured ? `${r.measured} of ${count(total, 'session')} measured` : count(total, 'session'));
  out.push(head.join(sep));

  if (!r.measured) {
    out.push('', 'No session had a turn with usable token usage in this window.', '');
    return out.join('\n');
  }

  const a = r.average;
  const avgTotal = a.input + a.cacheWrite + a.cacheRead;
  out.push('', `${bold('AVERAGE PRELOAD')}  ${bold(compact(avgTotal))} tokens`);
  out.push(`  ${dim('cache reads')} ${bold(compact(a.cacheRead))}${sep}${dim('cache writes')} ${bold(compact(a.cacheWrite))}${sep}${dim('uncached input')} ${bold(compact(a.input))}${sep}${dim('first reply')} ${bold(compact(a.output))}`);
  if (r.unmeasured) out.push(dim(`  ${count(r.unmeasured, 'session')} had no turn with usable token usage.`));

  if (r.byAgent.length > 1) {
    out.push('', `${bold('BY AGENT')}`);
    for (const x of r.byAgent) out.push(`  ${agentDef(x.agent as AgentId).name.padEnd(12)}  ${bold(compact(x.average))} avg${dim(` (${count(x.sessions, 'session')})`)}`);
  }

  if (r.byRepo.length) {
    out.push('', `${bold('BY REPO')}`);
    const shown = r.byRepo.slice(0, v.top);
    const width = Math.max(...shown.map((x) => tilde(x.repo, v.home).length));
    for (const x of shown) {
      const note = trendNote(x);
      out.push(`  ${tilde(x.repo, v.home).padEnd(width)}  ${bold(compact(x.average))} avg${dim(` (${count(x.sessions, 'session')})`)}${note ? sep + dim(note) : ''}`);
    }
    if (r.byRepo.length > shown.length) out.push(dim(`  … ${r.byRepo.length - shown.length} more (--top ${r.byRepo.length} shows them all)`));
  }

  out.push('', `${bold('HEAVIEST SESSIONS')}`);
  const heaviest = r.heaviest.slice(0, v.top);
  for (const x of heaviest) {
    out.push(`  ${(x.repo ? tilde(x.repo, v.home) : '(unknown folder)').padEnd(28)}  ${bold(compact(x.total))} tokens${x.when ? dim(`  ${day(x.when)}`) : ''}`);
  }
  if (r.heaviest.length > heaviest.length) out.push(dim(`  … ${r.heaviest.length - heaviest.length} more (--top ${r.heaviest.length} shows them all)`));

  out.push(
    '',
    dim('"Preload" is each session’s first turn, before anyone types a real prompt — not a'),
    dim('breakdown by skill or MCP server: rookery’s own per-artifact size isn’t the right unit for that yet.'),
    dim('Nothing leaves this machine.'),
    '',
  );
  return out.join('\n');
}

export function renderContextJson(v: ContextView): string {
  const r = v.report;
  return JSON.stringify({
    tool: { name: 'roost', version: VERSION },
    window: v.window,
    measured: r.measured,
    unmeasured: r.unmeasured,
    average: r.average,
    byAgent: r.byAgent,
    byRepo: r.byRepo.map((x) => ({
      repo: tilde(x.repo, v.home),
      sessions: x.sessions,
      average: x.average,
      earliest: x.earliest ? { when: x.earliest.when.toISOString(), total: x.earliest.total } : null,
      latest: x.latest ? { when: x.latest.when.toISOString(), total: x.latest.total } : null,
    })),
    heaviest: r.heaviest.map((x) => ({
      agent: x.agent, repo: x.repo ? tilde(x.repo, v.home) : null, when: x.when?.toISOString() ?? null, preload: x.preload, total: x.total,
    })),
  }, null, 2) + '\n';
}
