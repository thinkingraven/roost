import { agentDef } from '../usage/agents.js';
import type { AgentId } from '../sources.js';
import type { TeamReport } from '../merge.js';
import { VERDICT_ORDER, type Verdict } from '../verdicts.js';
import { VERSION } from '../version.js';
import { compact, count } from './format.js';
import { bar, style } from './style.js';

export interface MergeView {
  report: TeamReport;
  top: number;
  color?: boolean;
}

const HEADINGS: Record<Verdict, [string, string]> = {
  improve: ['FIX FIRST', 'used, but rookery found problems in them'],
  merge: ['MERGE', 'copies of another one: keep the copy people use'],
  retire: ['RETIRE', 'available to the team, never used'],
  keep: ['KEEP', 'used, no problems found'],
  'no-data': ['NO DATA', 'no session anywhere ran where these were available'],
};

export function renderMergeTerminal(v: MergeView): string {
  const { bold, dim, amber } = style(v.color ?? false);
  const r = v.report;
  const sep = `  ${dim('·')}  `;
  const out: string[] = [];
  const h = (title: string, meta = '') => out.push('', `${bold(title)}${meta ? '  ' + dim(meta) : ''}`);
  const more = (list: unknown[]) => {
    const rest = list.length - v.top;
    if (rest > 0) out.push(dim(`  … ${rest} more (--top ${list.length} shows them all)`));
  };
  const label = (x: { name: string; repo?: string }) => x.repo ? `${x.name} (${x.repo})` : x.name;
  const bars = (rows: { name: string; repo?: string; count: number; people: number }[]) => {
    if (!rows.length) return;
    const shown = rows.slice(0, v.top);
    const max = Math.max(...shown.map((x) => x.count));
    const width = Math.max(...shown.map((x) => label(x).length));
    for (const x of shown) out.push(`  ${label(x).padEnd(width)}  ${amber(bar(x.count, max))} ${bold(x.count.toLocaleString('en-US'))}  ${dim(count(x.people, 'person', 'people'))}`);
    more(rows);
  };

  const head = [`${bold('roost')}${amber('.')} ${dim(`v${VERSION}`)}`, 'merge', count(r.people, 'file', 'files'), `${r.window.from ?? 'all time'} → ${r.window.to}`];
  out.push(head.join(sep));
  if (r.teams.length > 1) out.push(dim(`Files from different teams: ${r.teams.join(', ')}. Combining them is probably not what you meant.`));

  if (r.byAgent.length) {
    h('ACTIVITY');
    for (const a of r.byAgent) out.push(`  ${agentDef(a.agent as AgentId).name.padEnd(12)}  ${bold(count(a.sessions, 'session'))}  ${dim(`${compact(a.tokens)} tokens`)}`);
  }

  h('TOP SKILLS', r.skills.length ? count(r.skills.length, 'skill') : 'none run');
  bars(r.skills);
  h('TOP SUBAGENTS', r.subagents.length ? count(r.subagents.length, 'subagent') : 'none run');
  bars(r.subagents);
  h('TOP COMMANDS', r.commands.length ? count(r.commands.length, 'command') : 'none run');
  bars(r.commands);
  h('TOP MCP SERVERS', r.mcp.length ? count(r.mcp.length, 'server') : 'none called');
  bars(r.mcp);

  if (r.verdicts.length) {
    for (const verdict of VERDICT_ORDER) {
      const rows = r.verdicts.filter((x) => x.verdict === verdict);
      if (!rows.length) continue;
      const [title, meta] = HEADINGS[verdict];
      out.push('', `${bold(title)} ${bold(rows.length)}  ${dim(meta)}`);
      const shown = rows.slice(0, v.top);
      const width = Math.max(...shown.map((x) => label(x).length));
      for (const x of shown) {
        const detail = verdict === 'retire' ? `not used in ${count(x.scopeSessions, 'session')} across the team`
          : verdict === 'keep' || verdict === 'improve' ? `used ${x.uses}× across the team`
          : verdict === 'merge' ? 'a duplicate; see roost verdicts in that repo for which copy wins'
          : 'no session anywhere ran in scope';
        out.push(`  ${label(x).padEnd(width)}  ${dim(count(x.people, 'person', 'people'))}  ${dim(detail)}`);
      }
      if (rows.length > shown.length) out.push(dim(`  … ${rows.length - shown.length} more (--top ${rows.length} shows them all)`));
    }
  }

  if (r.policy.length) {
    h('POLICY', 'what rookery\'s hook blocked or warned about, team-wide');
    const shown = r.policy.slice(0, v.top);
    const width = Math.max(...shown.map((x) => x.rule.length));
    for (const x of shown) out.push(`  ${x.rule.padEnd(width)}  ${dim(`blocked ${bold(String(x.blocked))} · warned ${bold(String(x.warned))}`)}`);
    more(r.policy);
  }

  out.push('', dim('Only the counts and names already in the files you combined. Nothing leaves this machine.'), '');
  return out.join('\n');
}

export function renderMergeJson(v: MergeView): string {
  return JSON.stringify({ tool: { name: 'roost', version: VERSION }, ...v.report }, null, 2) + '\n';
}
