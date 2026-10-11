import { BUILT_IN_COMMANDS } from '../usage/claude-code.js';
import { totalInput, totalTokens, type Counted, type UsageReport } from '../usage/aggregate.js';
import { VERSION } from '../version.js';
import { compact, count, day, tilde } from './format.js';
import { bar, style } from './style.js';

export interface UsageView {
  report: UsageReport;
  agentName: string;
  /** "last 30 days", "since 2026-09-01" or "all time" */
  window: string;
  home: string;
  top: number;
  color?: boolean;
}

const repoName = (repo: string | null, home: string) => (repo ? tilde(repo, home) : '(unknown folder)');

export function renderUsageTerminal(v: UsageView): string {
  const { bold, dim, amber } = style(v.color ?? false);
  const r = v.report;
  const sep = `  ${dim('·')}  `;
  const out: string[] = [];
  const h = (title: string, meta = '') => out.push('', `${bold(title)}${meta ? '  ' + dim(meta) : ''}`);
  const more = (list: unknown[]) => {
    const rest = list.length - v.top;
    if (rest > 0) out.push(dim(`  … ${rest} more (--top ${list.length} shows them all)`));
  };
  /** Name, amber bar, bold count, dim detail: rookery's row. */
  const bars = (rows: { name: string; value: number; detail: string }[]) => {
    const shown = rows.slice(0, v.top);
    const max = Math.max(...shown.map((x) => x.value));
    const width = Math.max(...shown.map((x) => x.name.length));
    for (const x of shown) out.push(`  ${x.name.padEnd(width)}  ${amber(bar(x.value, max))} ${bold(x.value.toLocaleString('en-US'))}  ${dim(x.detail)}`);
    more(rows);
  };
  const spread = (c: Counted) => `in ${count(c.sessions, 'session')} · ${count(c.repos, 'repo')}`;

  const head = [`${bold('roost')}${amber('.')} ${dim(`v${VERSION}`)}`, v.agentName, v.window];
  if (r.sessions === 0) {
    out.push(head.join(sep), '', `No ${v.agentName} sessions found.`, '', dim('Nothing leaves this machine.'), '');
    return out.join('\n');
  }
  head.push(`${count(r.sessions, 'session')} in ${count(r.repos.length, 'repo')}`);
  if (r.first && r.last) head.push(dim(`${day(r.first)} → ${day(r.last)}`));
  out.push(head.join(sep));

  const t = r.tokens;
  h('TOKENS', `${compact(totalInput(t))} in · ${compact(t.output)} out`);
  out.push(`  ${dim('cache reads')} ${bold(compact(t.cacheRead))}${sep}${dim('cache writes')} ${bold(compact(t.cacheWrite))}${sep}${dim('uncached input')} ${bold(compact(t.input))}${sep}${dim('output')} ${bold(compact(t.output))}`);

  const runs = (list: Counted[]) => list.reduce((a, c) => a + c.count, 0);
  h('SKILLS', r.skills.length ? `${count(runs(r.skills), 'run')} of ${count(r.skills.length, 'skill')}` : 'none run');
  bars(r.skills.map((c) => ({ name: c.name, value: c.count, detail: spread(c) })));

  h('SUBAGENTS', r.subagents.length ? count(runs(r.subagents), 'run') : 'none run');
  bars(r.subagents.map((c) => ({ name: c.name, value: c.count, detail: spread(c) })));

  const calls = r.mcp.reduce((a, s) => a + s.calls, 0);
  h('MCP SERVERS', r.mcp.length ? `${count(calls, 'call')} to ${count(r.mcp.length, 'server')}` : 'none called');
  bars(r.mcp.map((s) => ({ name: s.server, value: s.calls, detail: `${count(s.tools.length, 'tool')} · ${count(s.sessions, 'session')} · ${count(s.repos, 'repo')}` })));

  const custom = r.commands.filter((c) => !BUILT_IN_COMMANDS.has(c.name));
  const builtIn = r.commands.filter((c) => BUILT_IN_COMMANDS.has(c.name));
  h('COMMANDS', custom.length ? `${count(runs(custom), 'use')} of your own slash commands` : 'none of your own used');
  bars(custom.map((c) => ({ name: c.name, value: c.count, detail: spread(c) })));
  if (builtIn.length) out.push(dim(`  Built in: ${builtIn.slice(0, 8).map((c) => `${c.name} ${c.count}`).join(' · ')}`));

  h('REPOS', 'by sessions');
  const repos = r.repos.slice(0, v.top).map((p) => ({
    name: repoName(p.repo, v.home),
    sessions: count(p.sessions, 'session'),
    tokens: `${compact(totalTokens(p.tokens))} tokens`,
    skills: count(p.skillRuns, 'skill run'),
    mcp: count(p.mcpCalls, 'MCP call'),
  }));
  const w = (k: keyof (typeof repos)[number]) => Math.max(...repos.map((x) => x[k].length));
  for (const x of repos) {
    out.push(`  ${x.name.padEnd(w('name'))}  ${bold(x.sessions.padEnd(w('sessions')))}${sep}${x.tokens.padEnd(w('tokens'))}${sep}${x.skills.padEnd(w('skills'))}${sep}${x.mcp}`);
  }
  more(r.repos);

  if (r.tools.length) {
    h('BUILT-IN TOOLS');
    out.push('  ' + r.tools.slice(0, 8).map((x) => `${x.name} ${bold(x.count.toLocaleString('en-US'))}`).join(dim('  ·  ')) + (r.tools.length > 8 ? dim('  · …') : ''));
  }
  const steps = nextSteps(r, v.window, { bold, dim, amber });
  if (steps.length) {
    h('NEXT STEPS');
    for (const step of steps) out.push(`  ${amber('→')} ${step}`);
  }
  if (r.skipped) out.push('', dim(`Skipped ${count(r.skipped, 'log line')} roost couldn't read.`));
  out.push('', dim('Tip: --format json has every row; --since all covers all time.'));
  out.push(dim('Only names, counts and dates: no prompt or reply text. Nothing leaves this machine.'), '');
  return out.join('\n');
}

/**
 * A few plain observations from the counts, like rookery's next steps. Only what the data shows:
 * the most widely used skill, skills that ran once, and MCP servers few sessions used.
 */
export function nextSteps(r: UsageReport, window: string, s: ReturnType<typeof style>): string[] {
  const { bold, amber } = s;
  const steps: string[] = [];
  const shared = r.skills.filter((x) => x.repos >= 3).sort((a, b) => b.repos - a.repos || b.count - a.count)[0];
  if (shared) {
    steps.push(`${bold(shared.name)} runs in ${amber(bold(shared.repos))} repos: worth one shared, reviewed version (rookery shows the copies).`);
  }
  const once = r.skills.filter((x) => x.count === 1);
  if (once.length) {
    const names = once.slice(0, 3).map((x) => x.name).join(', ') + (once.length > 3 ? ` and ${once.length - 3} more` : '');
    steps.push(`${amber(bold(count(once.length, 'skill')))} ran just once (${window}): ${names}. ${once.length === 1 ? 'Check it still earns its place.' : 'Check they still earn their place.'}`);
  }
  const quiet = r.mcp.filter((x) => x.sessions / r.sessions < 0.25).sort((a, b) => a.sessions - b.sessions)[0];
  if (quiet && r.sessions >= 8) {
    steps.push(`${bold(quiet.server)} was used in ${amber(bold(quiet.sessions))} of ${r.sessions} sessions. If it's enabled everywhere, its tool definitions cost tokens in the other ${r.sessions - quiet.sessions}.`);
  }
  return steps;
}

export function renderUsageJson(v: UsageView, agent: string): string {
  const r = v.report;
  const out = {
    version: VERSION,
    agent,
    window: v.window,
    since: r.since?.toISOString() ?? null,
    first: r.first?.toISOString() ?? null,
    last: r.last?.toISOString() ?? null,
    sessions: r.sessions,
    tokens: r.tokens,
    skills: r.skills,
    subagents: r.subagents,
    mcp: r.mcp,
    commands: r.commands.map((c) => ({ ...c, builtIn: BUILT_IN_COMMANDS.has(c.name) })),
    tools: r.tools,
    repos: r.repos.map((p) => ({ ...p, repo: p.repo ? tilde(p.repo, v.home) : null })),
    skipped: r.skipped,
  };
  return JSON.stringify(out, null, 2) + '\n';
}
