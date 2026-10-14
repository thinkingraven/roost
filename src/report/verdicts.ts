import { VERSION } from '../version.js';
import type { Judged, Verdict, VerdictReport } from '../verdicts.js';
import { VERDICT_ORDER } from '../verdicts.js';
import { count, day } from './format.js';
import { style } from './style.js';

export interface VerdictView {
  report: VerdictReport;
  /** "last 30 days", "since 2026-09-01" or "all time" */
  window: string;
  sessions: number;
  first: Date | null;
  last: Date | null;
  rookery: { version: string; scannedAt?: string };
  top: number;
  color?: boolean;
}

const HEADINGS: Record<Verdict, [string, string]> = {
  improve: ['FIX FIRST', 'used, but rookery found problems in them'],
  merge: ['MERGE', 'copies of another one: keep the copy people use'],
  retire: ['RETIRE', 'available in sessions, never used'],
  keep: ['KEEP', 'used, no problems found'],
  'no-data': ['NO DATA', 'no sessions where these were available'],
};

const AGENT_NAMES: Record<string, string> = { codex: 'Codex', cursor: 'Cursor', copilot: 'Copilot', gemini: 'Gemini CLI', windsurf: 'Windsurf', 'agent-skills': 'Agent Skills', skillshare: 'skillshare' };

function detail(j: Judged): string {
  const times = (n: number) => `${n.toLocaleString('en-US')}×`;
  switch (j.verdict) {
    case 'improve': return `used ${times(j.uses)} · ${j.issues.slice(0, 2).join(' · ')}${j.issues.length > 2 ? ` · +${j.issues.length - 2} more` : ''}`;
    case 'merge': return `→ ${j.mergeInto!.repo === j.repo ? '' : j.mergeInto!.repo + '/'}${j.mergeInto!.relPath} (used ${times(j.mergeInto!.uses)}; this one ${times(j.uses)})`;
    case 'retire': return `not used in ${count(j.scopeSessions, 'session')}${j.copyUsed ? `; its copy ${j.copyUsed.name} ran ${times(j.copyUsed.uses)}` : ''}`;
    case 'keep': return `used ${times(j.uses)} in ${count(j.sessions, 'session')}${j.lastUsed ? ` · last ${day(j.lastUsed)}` : ''}`;
    case 'no-data': return 'no sessions in this repo in the window';
  }
}

export function renderVerdictsTerminal(v: VerdictView): string {
  const { bold, dim, amber } = style(v.color ?? false);
  const sep = `  ${dim('·')}  `;
  const out: string[] = [];
  const r = v.report;
  const head = [`${bold('roost')}${amber('.')} ${dim(`v${VERSION}`)}`, 'verdicts', 'Claude Code', v.window, count(v.sessions, 'session')];
  if (v.first && v.last) head.push(dim(`${day(v.first)} → ${day(v.last)}`));
  out.push(head.join(sep));
  out.push(dim(`rookery ${v.rookery.version}${v.rookery.scannedAt ? ` scan from ${day(new Date(v.rookery.scannedAt))}` : ''}: ${count(r.judged.length, 'Claude Code skill, command or subagent', 'Claude Code skills, commands and subagents')} judged`));
  if (r.matchedByName) out.push(dim('Repos matched by folder name. rookery 0.7.2 or later matches them exactly.'));

  if (!r.judged.length) {
    out.push('', 'rookery\'s report has no Claude Code skills, commands or subagents to judge.', dim('Scan the repos you work in, plus --local for ~/.claude: rookery scan ~/code --local --format json | roost verdicts'), '');
    return out.join('\n');
  }

  for (const verdict of VERDICT_ORDER) {
    const rows = r.judged.filter((j) => j.verdict === verdict);
    if (!rows.length) continue;
    const [title, meta] = HEADINGS[verdict];
    out.push('', `${bold(title)} ${bold(rows.length)}  ${dim(meta)}`);
    const shown = rows.slice(0, v.top);
    const label = (j: Judged) => `${j.name}${j.kind === 'skill' ? '' : ` (${j.kind})`}`;
    const width = Math.min(36, Math.max(...shown.map((j) => label(j).length)));
    const repoWidth = Math.min(28, Math.max(...shown.map((j) => j.repo.length)));
    for (const j of shown) out.push(`  ${label(j).padEnd(width)}  ${dim(j.repo.padEnd(repoWidth))}  ${verdict === 'improve' ? amber(detail(j)) : dim(detail(j))}`);
    if (rows.length > shown.length) out.push(dim(`  … ${rows.length - shown.length} more (--top ${rows.length} shows them all)`));
  }

  if (r.unmatched.length) {
    out.push('', `${bold('USED, NOT IN THE SCAN')} ${bold(r.unmatched.length)}  ${dim('plugins, built-ins, or repos rookery didn\'t scan')}`);
    const shown = r.unmatched.slice(0, v.top);
    out.push('  ' + shown.map((u) => `${u.name}${u.kind === 'subagent' ? ' (subagent)' : ''} ${bold(u.uses + '×')}`).join(dim('  ·  ')));
    if (r.unmatched.length > shown.length) out.push(dim(`  … ${r.unmatched.length - shown.length} more`));
  }
  const others = Object.entries(r.notJudged);
  if (others.length) {
    const total = others.reduce((n, [, c]) => n + c, 0);
    out.push('', dim(`Not judged yet: ${count(total, 'artifact')} for ${others.map(([a]) => AGENT_NAMES[a] ?? a).join(', ')}. roost reads Claude Code logs so far.`));
  }
  out.push('', dim('Nothing leaves this machine. Verdicts use names, counts and dates only.'), '');
  return out.join('\n');
}

export function renderVerdictsJson(v: VerdictView): string {
  return JSON.stringify({
    tool: { name: 'roost', version: VERSION },
    agent: 'claude-code',
    window: v.window,
    sessions: v.sessions,
    first: v.first?.toISOString() ?? null,
    last: v.last?.toISOString() ?? null,
    rookery: v.rookery,
    matchedByName: v.report.matchedByName,
    verdicts: v.report.judged.map((j) => ({ ...j, lastUsed: j.lastUsed?.toISOString() ?? null })),
    unmatched: v.report.unmatched,
    notJudged: v.report.notJudged,
  }, null, 2) + '\n';
}
