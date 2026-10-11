import type { Source } from '../sources.js';
import { VERSION } from '../version.js';
import { count, day, table, tilde } from './format.js';

export function renderSourcesTerminal(sources: Source[], home: string): string {
  const rows = sources.map((s) => [
    s.name,
    tilde(s.dir, home),
    s.found ? count(s.sessions, 'session') : 'not found',
    s.first && s.last ? `${day(s.first)} → ${day(s.last)}` : '',
  ]);
  return `roost v${VERSION}: agent session logs on this machine\n\n${table(rows).join('\n')}\n\nNothing leaves this machine.\n`;
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
