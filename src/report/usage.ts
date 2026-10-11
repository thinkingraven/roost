import { BUILT_IN_COMMANDS } from '../usage/claude-code.js';
import { totalInput, totalTokens, type Counted, type UsageReport } from '../usage/aggregate.js';
import type { Tokens } from '../usage/types.js';
import { VERSION } from '../version.js';
import { compact, count, day, table, tilde } from './format.js';

export interface UsageView {
  report: UsageReport;
  agentName: string;
  /** "last 30 days", "since 2026-09-01" or "all time" */
  window: string;
  home: string;
  top: number;
}

const repoName = (repo: string | null, home: string) => (repo ? tilde(repo, home) : '(unknown folder)');

function more(list: unknown[], top: number): string[] {
  const rest = list.length - top;
  return rest > 0 ? [`  + ${rest} more (--top ${list.length} shows them all)`] : [];
}

function countedRows(list: Counted[], top: number, unit: string): string[] {
  return [
    ...table(list.slice(0, top).map((c) => [c.name, count(c.count, unit), count(c.sessions, 'session'), count(c.repos, 'repo')])),
    ...more(list, top),
  ];
}

const tokensLine = (t: Tokens) =>
  `${compact(totalInput(t))} in · ${compact(t.output)} out`;

export function renderUsageTerminal(v: UsageView): string {
  const r = v.report;
  const out: string[] = [`roost v${VERSION}: what your agents actually used`];
  if (r.sessions === 0) {
    out.push('', `No ${v.agentName} sessions found (${v.window}).`, '', 'Nothing leaves this machine.', '');
    return out.join('\n');
  }
  const span = r.first && r.last ? ` · ${day(r.first)} → ${day(r.last)}` : '';
  out.push(`${v.agentName} · ${v.window} · ${count(r.sessions, 'session')} in ${count(r.repos.length, 'repo')}${span}`, '');

  out.push(`TOKENS        ${tokensLine(r.tokens)}`);
  if (totalInput(r.tokens) > 0) {
    out.push(`              of the input, ${compact(r.tokens.cacheRead)} was cache reads and ${compact(r.tokens.cacheWrite)} cache writes`);
  }

  const skillRuns = r.skills.reduce((a, s) => a + s.count, 0);
  out.push('', `SKILLS        ${r.skills.length ? `${count(skillRuns, 'run')} of ${count(r.skills.length, 'skill')}` : 'none run'}`);
  out.push(...countedRows(r.skills, v.top, 'run'));

  const agentRuns = r.subagents.reduce((a, s) => a + s.count, 0);
  out.push('', `SUBAGENTS     ${r.subagents.length ? count(agentRuns, 'run') : 'none run'}`);
  out.push(...countedRows(r.subagents, v.top, 'run'));

  const mcpCalls = r.mcp.reduce((a, s) => a + s.calls, 0);
  out.push('', `MCP SERVERS   ${r.mcp.length ? `${count(mcpCalls, 'call')} to ${count(r.mcp.length, 'server')}` : 'none called'}`);
  out.push(...table(r.mcp.slice(0, v.top).map((s) => [s.server, count(s.calls, 'call'), count(s.tools.length, 'tool'), count(s.sessions, 'session'), count(s.repos, 'repo')])));
  out.push(...more(r.mcp, v.top));

  const custom = r.commands.filter((c) => !BUILT_IN_COMMANDS.has(c.name));
  const builtIn = r.commands.filter((c) => BUILT_IN_COMMANDS.has(c.name));
  out.push('', `COMMANDS      ${custom.length ? count(custom.reduce((a, c) => a + c.count, 0), 'use') + ' of your own slash commands' : 'none of your own used'}`);
  out.push(...countedRows(custom, v.top, 'use'));
  if (builtIn.length) out.push(`  Built in: ${builtIn.slice(0, 8).map((c) => `${c.name} ${c.count}`).join(' · ')}`);

  out.push('', 'REPOS');
  out.push(...table(r.repos.slice(0, v.top).map((p) => [
    repoName(p.repo, v.home), count(p.sessions, 'session'), `${compact(totalTokens(p.tokens))} tokens`,
    count(p.skillRuns, 'skill run'), count(p.mcpCalls, 'MCP call'),
  ])));
  out.push(...more(r.repos, v.top));

  if (r.tools.length) {
    out.push('', `BUILT-IN TOOLS  ${r.tools.slice(0, 8).map((t) => `${t.name} ${t.count.toLocaleString('en-US')}`).join(' · ')}${r.tools.length > 8 ? ' · …' : ''}`);
  }
  if (r.skipped) out.push('', `Skipped ${count(r.skipped, 'log line')} roost couldn't read.`);
  out.push('', 'Only names, counts and dates: no prompt or reply text. Nothing leaves this machine.', '');
  return out.join('\n');
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
