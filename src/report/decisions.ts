import type { DecisionsReport } from '../decisions.js';
import { VERSION } from '../version.js';
import { count } from './format.js';
import { style } from './style.js';

export interface DecisionsView {
  report: DecisionsReport;
  found: boolean;
  /** "last 30 days", "since 2026-09-01" or "all time" */
  window: string;
  top: number;
  color?: boolean;
}

// rookery's hook agents: a wider set than the sessions roost reads (it has no Cursor or Copilot usage reader yet).
const AGENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', cursor: 'Cursor', copilot: 'Copilot', windsurf: 'Windsurf',
};
const agentName = (id: string) => AGENT_NAMES[id] ?? id;

export function renderDecisionsTerminal(v: DecisionsView): string {
  const { bold, dim, amber } = style(v.color ?? false);
  const sep = `  ${dim('·')}  `;
  const out: string[] = [];
  const head = [`${bold('roost')}${amber('.')} ${dim(`v${VERSION}`)}`, 'decisions', 'rookery’s policy log', v.window];
  out.push(head.join(sep));

  if (!v.found) {
    out.push('', 'No ~/.rookery/decisions folder found.', dim('It appears once `rookery hook` runs for a repo with a .rookery.yml — see https://github.com/thinkingraven/rookery.'), '');
    return out.join('\n');
  }

  const r = v.report;
  if (!r.total) {
    out.push('', 'No denies or warnings logged in this window.', dim('rookery only logs what it stops or flags; a clean run leaves nothing here.'), '');
    return out.join('\n');
  }

  out.push('', `${bold('DENIED')} ${bold(r.denied)}  ${dim('stopped before the agent ran it')}`);
  out.push(`${bold('WARNED')} ${bold(r.warned)}  ${dim('allowed, logged')}`);

  out.push('', `${bold('BY RULE')}`);
  const rules = r.byRule.slice(0, v.top);
  const idWidth = Math.min(28, Math.max(...rules.map((x) => x.id.length)));
  for (const x of rules) out.push(`  ${x.id.padEnd(idWidth)}  ${bold(String(x.count).padStart(3))}  ${dim(x.example)}`);
  if (r.byRule.length > rules.length) out.push(dim(`  … ${r.byRule.length - rules.length} more (--top ${r.byRule.length} shows them all)`));

  if (r.byAgent.length) {
    out.push('', `${bold('BY AGENT')}`);
    out.push('  ' + r.byAgent.map((x) => `${agentName(x.name)} ${amber(String(x.count))}`).join(dim('  ·  ')));
  }
  if (r.byRepo.length) {
    out.push('', `${bold('BY REPO')}`);
    const repos = r.byRepo.slice(0, v.top);
    out.push('  ' + repos.map((x) => `${x.name} ${amber(String(x.count))}`).join(dim('  ·  ')));
    if (r.byRepo.length > repos.length) out.push(dim(`  … ${r.byRepo.length - repos.length} more`));
  }

  if (r.skipped) out.push('', dim(`${count(r.skipped, 'line')} in the log roost couldn’t read (not a shape it knows).`));
  out.push('', dim('Nothing leaves this machine. rookery already redacts what it logs: first tokens and ~ paths only.'), '');
  return out.join('\n');
}

export function renderDecisionsJson(v: DecisionsView): string {
  return JSON.stringify({
    tool: { name: 'roost', version: VERSION },
    window: v.window,
    found: v.found,
    ...v.report,
  }, null, 2) + '\n';
}
