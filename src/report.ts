import { sep } from 'node:path';
import type { Source } from './sources.js';
import { VERSION } from './version.js';

/** Show paths under the home folder as ~/…, so reports don't carry the user's name. */
export function tilde(path: string, home: string): string {
  return path === home || path.startsWith(home + sep) ? '~' + path.slice(home.length).split(sep).join('/') : path;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export function renderSourcesTerminal(sources: Source[], home: string): string {
  const rows = sources.map((s) => [
    s.name,
    tilde(s.dir, home),
    s.found ? `${s.sessions} ${s.sessions === 1 ? 'session' : 'sessions'}` : 'not found',
    s.first && s.last ? `${day(s.first)} → ${day(s.last)}` : '',
  ]);
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const lines = rows.map((r) => '  ' + r.map((cell, i) => cell.padEnd(widths[i])).join('   ').trimEnd());
  return `roost v${VERSION}: agent session logs on this machine\n\n${lines.join('\n')}\n\nNothing leaves this machine.\n`;
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
