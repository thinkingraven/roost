import type { Source } from '../sources.js';
import { VERSION } from '../version.js';
import { count, day, tilde } from './format.js';
import { style } from './style.js';

export function renderSourcesTerminal(sources: Source[], home: string, color = false): string {
  const { bold, dim, amber } = style(color);
  const rows = sources.map((s) => ({
    name: s.name,
    dir: tilde(s.dir, home),
    sessions: s.found ? count(s.sessions, 'session') : 'not found',
    span: s.first && s.last ? `${day(s.first)} → ${day(s.last)}` : '',
    found: s.found,
  }));
  const w = (k: 'name' | 'dir' | 'sessions') => Math.max(...rows.map((r) => r[k].length));
  const out = [`${bold('roost')}${amber('.')} ${dim(`v${VERSION}`)}  ${dim('·')}  agent session logs on this machine`, ''];
  for (const r of rows) {
    const sessions = r.found ? bold(r.sessions.padEnd(w('sessions'))) : dim(r.sessions.padEnd(w('sessions')));
    out.push(`  ${r.name.padEnd(w('name'))}   ${dim(r.dir.padEnd(w('dir')))}   ${sessions}   ${dim(r.span)}`.trimEnd());
  }
  out.push('', dim('Nothing leaves this machine.'), '');
  return out.join('\n');
}

export function renderSourcesJson(sources: Source[], home: string): string {
  const out = {
    version: VERSION,
    sources: sources.map((s) => ({
      agent: s.agent,
      name: s.name,
      dir: tilde(s.dir, home),
      found: s.found,
      sessions: s.sessions,
      first: s.first?.toISOString() ?? null,
      last: s.last?.toISOString() ?? null,
    })),
  };
  return JSON.stringify(out, null, 2) + '\n';
}
