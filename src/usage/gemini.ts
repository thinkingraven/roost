import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolveRepo } from './claude-code.js';
import { bump, sessionTable, type ReadOptions, type ReadResult, type SessionUsage } from './types.js';

/**
 * Gemini CLI keeps each session under ~/.gemini/tmp/<project>/chats/:
 * - current versions: session-<time>-<id>.jsonl, appended to on every update (the same message id again, last copy wins),
 *   with `{"$set":…}` and `{"$rewindTo":…}` lines;
 * - up to v0.22: session-<time>-<id>.json, one record rewritten whole;
 * - subagent transcripts in chats/<parent session id>/<agent id>.jsonl, counted into their parent.
 * The project folder is tmp/<slug> (with a .project_root file) or, before, tmp/<sha256 of the project root>.
 * A migration copies the hash folder to the slug folder, so sessions are united by session id and message id.
 * Slash commands are only reliably in tmp/<project>/logs.json (raw input); roost keeps the command name alone.
 */

/** Gemini CLI's own slash commands (packages/cli/src/ui/commands, names and aliases), reported apart from a team's. */
export const GEMINI_BUILT_IN_COMMANDS = new Set([
  'about', 'agents', 'auth', 'bug', 'chat', 'checkpoints', 'clear', 'commands', 'compress', 'config', 'copy', 'corgi', 'debug',
  'directory', 'dir', 'docs', 'editor', 'explore', 'export-session', 'extensions', 'gemma', 'help', 'hooks', 'ide', 'inbox', 'init',
  'mcp', 'memory', 'model', 'permissions', 'plan', 'policies', 'privacy', 'quit', 'exit', 'restore', 'resume', 'rewind', 'settings',
  'setup-github', 'shells', 'bashes', 'shortcuts', 'signin', 'login', 'signout', 'logout', 'skills', 'stats', 'usage', 'tasks', 'bg',
  'background', 'terminal-setup', 'theme', 'tools', 'upgrade', 'update', 'vim', 'voice', 'new', 'compact', 'summarize', 'refresh',
].map((c) => `/${c}`));
/** Subagents that ship with Gemini CLI. */
export const GEMINI_BUILT_IN_SUBAGENTS = new Set(['codebase_investigator', 'cli_help', 'generalist', 'browser_agent', 'confucius']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const date = (v: unknown) => { const d = new Date(str(v) ?? NaN); return Number.isNaN(d.getTime()) ? undefined : d; };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const MCP_DISPLAY = /^(.*) \((.+) MCP Server\)$/;
const COMMAND = /^\/[A-Za-z0-9][\w:.-]*$/;

interface Gathered {
  id: string;
  projectHash?: string;
  root?: string;            // project root, when the folder says so
  start?: Date;
  updated?: Date;
  messages: Map<string, Obj>;
  /** Subagent transcripts: agent id → its messages. */
  subagents: Map<string, Map<string, Obj>>;
}

function list(dir: string) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Read Gemini CLI sessions under `home` (~/.gemini, and ~/.cache/.gemini when sandboxed), keeping messages from `since` on. */
export async function readGemini(home: string, since?: Date, opts: ReadOptions = {}): Promise<ReadResult> {
  const roots = [join(home, '.gemini'), join(home, '.cache', '.gemini')].filter((r) => existsSync(join(r, 'tmp')));
  let skipped = 0;
  const sessions = new Map<string, Gathered>();
  const commands = new Map<string, Map<string, { name: string; when?: Date }>>(); // session id → message id → command

  // Project roots by folder: .project_root files, and sha256 of every root roost knows of (for older hash folders).
  const byHash = new Map<string, string>();
  for (const root of roots) {
    try {
      const reg = JSON.parse(readFileSync(join(root, 'projects.json'), 'utf8'));
      if (isObj(reg) && isObj(reg.projects)) for (const p of Object.keys(reg.projects)) byHash.set(sha256(p), p);
    } catch { /* no registry */ }
  }
  const folderRoot = (folder: string): string | undefined => {
    try { const p = readFileSync(join(folder, '.project_root'), 'utf8').trim(); if (p) { byHash.set(sha256(p), p); return p; } } catch { /* none */ }
    return byHash.get(basename(folder));
  };

  const gather = (id: string) => {
    let g = sessions.get(id);
    if (!g) sessions.set(id, (g = { id, messages: new Map(), subagents: new Map() }));
    return g;
  };
  const meta = (g: Gathered, m: Obj) => {
    g.projectHash ??= str(m.projectHash);
    const start = date(m.startTime), updated = date(m.lastUpdated);
    if (start && (!g.start || start < g.start)) g.start = start;
    if (updated && (!g.updated || updated > g.updated)) g.updated = updated;
  };
  /** A session file's records: the metadata and its messages (all copies; the last copy of an id wins). */
  const parse = (file: string): { meta?: Obj; messages: Obj[] } | undefined => {
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch { skipped++; return undefined; }
    if (file.endsWith('.json')) {
      try {
        const rec = JSON.parse(text);
        if (!isObj(rec) || !Array.isArray(rec.messages)) { skipped++; return undefined; }
        return { meta: rec, messages: rec.messages.filter(isObj) };
      } catch { skipped++; return undefined; }
    }
    const out: { meta?: Obj; messages: Obj[] } = { messages: [] };
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec: unknown;
      try { rec = JSON.parse(line); } catch { skipped++; continue; }
      if (!isObj(rec)) { skipped++; continue; }
      if (str(rec.id)) out.messages.push(rec);
      else if (isObj(rec.$set)) {
        // Compression or a rollback replaces the list; those turns were still spent, so their messages still count.
        if (Array.isArray(rec.$set.messages)) out.messages.push(...rec.$set.messages.filter(isObj));
        out.meta = { ...out.meta, ...rec.$set };
      } else if (str(rec.sessionId)) out.meta = { ...out.meta, ...rec };
      else if (!('$rewindTo' in rec)) skipped++;
    }
    return out;
  };

  for (const root of roots) {
    for (const project of list(join(root, 'tmp'))) {
      if (!project.isDirectory()) continue;
      const folder = join(root, 'tmp', project.name);
      const projectRoot = folderRoot(folder);
      const chats = join(folder, 'chats');
      for (const entry of list(chats)) {
        const path = join(chats, entry.name);
        if (entry.isFile() && /^session-.+\.jsonl?$/.test(entry.name)) {
          if (since) { try { if (statSync(path).mtime < since) continue; } catch { continue; } }
          const rec = parse(path);
          const id = str(rec?.meta?.sessionId);
          if (!rec || !id) continue;
          const g = gather(id);
          meta(g, rec.meta!);
          g.root ??= projectRoot;
          for (const m of rec.messages) g.messages.set(str(m.id)!, m);
        } else if (entry.isDirectory()) {
          // chats/<parent session id>/<agent id>.jsonl: a subagent's transcript, counted into its parent.
          for (const sub of list(path)) {
            if (!sub.isFile() || !sub.name.endsWith('.jsonl')) continue;
            const rec = parse(join(path, sub.name));
            if (!rec) continue;
            const g = gather(entry.name);
            g.root ??= projectRoot;
            const agent = sub.name.slice(0, -'.jsonl'.length);
            const msgs = g.subagents.get(agent) ?? new Map<string, Obj>();
            for (const m of rec.messages) msgs.set(str(m.id)!, m);
            g.subagents.set(agent, msgs);
          }
        }
      }
      // logs.json: raw input, before slash commands are handled. Only the command's name is kept.
      try {
        const log = JSON.parse(readFileSync(join(folder, 'logs.json'), 'utf8'));
        if (Array.isArray(log)) for (const e of log) {
          if (!isObj(e) || e.type !== 'user' || typeof e.message !== 'string') continue;
          const first = e.message.trim().split(/\s/, 1)[0];
          const when = date(e.timestamp);
          if (!COMMAND.test(first) || (since && when && when < since) || (opts.until && when && when >= opts.until)) continue;
          const sid = str(e.sessionId);
          if (!sid) continue;
          const per = commands.get(sid) ?? new Map<string, { name: string; when?: Date }>();
          per.set(String(e.messageId ?? `${when?.getTime()}`), { name: first, when });
          commands.set(sid, per);
        }
      } catch { /* no input log */ }
    }
  }

  const out: SessionUsage[] = [];
  for (const g of sessions.values()) {
    if (!g.root && g.projectHash) g.root = byHash.get(g.projectHash);
    const repo = resolveRepo(g.root);
    const table = sessionTable('gemini-cli', opts.byDay);
    const pieceAt = (when?: Date) => { const s = table.get(g.id, when); s.cwd = g.root; s.repo = repo; return s; };
    const seenCalls = new Set<string>();
    // Preload is the top-level conversation's first turn, so only tracked for isMain=true calls.
    const preloadWhen = new Map<SessionUsage, Date>();
    const count = (messages: Map<string, Obj>, isMain: boolean) => {
      for (const m of messages.values()) {
        const when = date(m.timestamp);
        if ((since && when && when < since) || (opts.until && when && when >= opts.until)) continue;
        const s = pieceAt(when);
        if (when && (!s.first || when < s.first)) s.first = when;
        if (when && (!s.last || when > s.last)) s.last = when;
        if (m.type !== 'gemini') continue;
        if (isObj(m.tokens)) {
          const t = m.tokens;
          const input = Math.max(0, num(t.input) - num(t.cached)) + num(t.tool);
          const cacheRead = num(t.cached);
          const output = num(t.output) + num(t.thoughts);
          s.tokens.input += input;
          s.tokens.cacheRead += cacheRead;
          s.tokens.output += output;
          if (isMain && when) {
            const seenAt = preloadWhen.get(s);
            if (!seenAt || when < seenAt) {
              preloadWhen.set(s, when);
              s.preload = { input, cacheWrite: 0, cacheRead, output };
            }
          }
        }
        if (!Array.isArray(m.toolCalls)) continue;
        for (const call of m.toolCalls) {
          if (!isObj(call)) continue;
          const callId = str(call.id);
          if (callId) { if (seenCalls.has(callId)) continue; seenCalls.add(callId); }
          recordToolCall(s, call);
        }
      }
    };
    count(g.messages, true);
    for (const msgs of g.subagents.values()) count(msgs, false);
    for (const c of commands.get(g.id)?.values() ?? []) {
      const s = pieceAt(c.when ?? g.start);
      bump(s.commands, c.name);
      if (opts.byDay && c.when) {
        if (!s.first || c.when < s.first) s.first = c.when;
        if (!s.last || c.when > s.last) s.last = c.when;
      }
    }
    if (opts.byDay) { out.push(...[...table.map.values()].filter((s) => s.first || s.last)); continue; }
    const s = pieceAt();
    if (!s.first && !s.last) {
      // A session with no messages in the window: keep it only if its dates fall inside.
      if (!g.updated || (since && g.updated < since)) continue;
      s.first = g.start; s.last = g.updated;
    }
    out.push(s);
  }
  return { sessions: out, skipped };
}

function recordToolCall(s: SessionUsage, call: Obj): void {
  const name = str(call.name);
  if (!name) return;
  const args = isObj(call.args) ? call.args : {};
  if (name === 'activate_skill') { bump(s.skills, str(args.name) ?? '?'); return; }
  if (name === 'invoke_agent' || name === 'delegate_to_agent') { bump(s.subagents, str(args.agent_name) ?? '?'); return; }
  // An MCP tool shows as "<tool> (<server> MCP Server)" in every version; the name alone can't be split reliably.
  const display = MCP_DISPLAY.exec(str(call.displayName) ?? '');
  if (display) { bump(s.mcp, `${display[2]}/${display[1]}`); return; }
  if (name.startsWith('mcp_')) { bump(s.mcp, `?/${name.slice(4)}`); return; }
  bump(s.tools, name);
}
