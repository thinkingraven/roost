import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type AgentId = 'claude-code' | 'codex' | 'gemini-cli';

/** Where an agent keeps its session logs (relative to the home folder) and which files there are sessions. */
interface SourceDef {
  agent: AgentId;
  name: string;
  dir: readonly string[];
  /** Matches a session file's path relative to `dir`, with forward slashes. */
  session: RegExp;
}

export const SOURCE_DEFS: readonly SourceDef[] = [
  // ~/.claude/projects/<project>/<session-id>.jsonl (subagent logs sit deeper and belong to their session)
  { agent: 'claude-code', name: 'Claude Code', dir: ['.claude', 'projects'], session: /^[^/]+\/[^/]+\.jsonl$/ },
  // ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<id>.jsonl
  { agent: 'codex', name: 'Codex', dir: ['.codex', 'sessions'], session: /(^|\/)rollout-[^/]+\.jsonl$/ },
  // ~/.gemini/tmp/<project>/chats/session-<time>-<id>.jsonl (.json up to v0.22); subagent transcripts sit deeper
  { agent: 'gemini-cli', name: 'Gemini CLI', dir: ['.gemini', 'tmp'], session: /^[^/]+\/chats\/session-[^/]+\.jsonl?$/ },
];

export interface Source {
  agent: AgentId;
  name: string;
  /** Absolute path of the agent's log folder. */
  dir: string;
  found: boolean;
  sessions: number;
  /** Oldest and newest session, by file modification time. */
  first?: Date;
  last?: Date;
}

const MAX_DEPTH = 6;

/** Find each agent's session logs under `home`. Lists and stats files only: never opens them. */
export function findSources(home: string): Source[] {
  return SOURCE_DEFS.map((def) => {
    const dir = join(home, ...def.dir);
    const source: Source = { agent: def.agent, name: def.name, dir, found: false, sessions: 0 };
    const entries = list(dir);
    if (!entries) return source;
    source.found = true;
    walk(dir, entries, 0, (file) => {
      if (!def.session.test(relative(dir, file).split(sep).join('/'))) return;
      let mtime: Date;
      try { mtime = statSync(file).mtime; } catch { return; }
      source.sessions++;
      if (!source.first || mtime < source.first) source.first = mtime;
      if (!source.last || mtime > source.last) source.last = mtime;
    });
    return source;
  });
}

/** Calls `onFile` for every file under `dir`, at most `maxDepth` folders down. Doesn't follow symlinks. */
export function walkFiles(dir: string, maxDepth: number, onFile: (path: string) => void): void {
  const entries = list(dir);
  if (entries) walk(dir, entries, 0, onFile, maxDepth);
}

function list(dir: string): Dirent[] | undefined {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
}

function walk(dir: string, entries: Dirent[], depth: number, onFile: (path: string) => void, maxDepth = MAX_DEPTH): void {
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile()) onFile(path);
    else if (entry.isDirectory() && depth < maxDepth) {
      const children = list(path);
      if (children) walk(path, children, depth + 1, onFile, maxDepth);
    }
  }
}
