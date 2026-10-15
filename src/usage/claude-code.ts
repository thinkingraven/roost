import { createReadStream, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join } from 'node:path';
import { walkFiles } from '../sources.js';
import { bump, sessionTable, type ReadOptions, type ReadResult, type SessionUsage } from './types.js';

// ~/.claude/projects/<project>/<session>.jsonl, plus <session>/subagents/agent-<id>.jsonl (same sessionId)
const MAX_DEPTH = 4;

/** Commands that ship with Claude Code, reported apart from a team's own commands. */
export const BUILT_IN_COMMANDS = new Set([
  '/add-dir', '/agents', '/bashes', '/bug', '/clear', '/compact', '/config', '/context', '/cost', '/doctor',
  '/effort', '/exit', '/export', '/fast', '/feedback', '/help', '/hooks', '/ide', '/init', '/install-github-app',
  '/keybindings', '/login', '/logout', '/mcp', '/memory', '/model', '/output-style', '/permissions', '/plugin',
  '/pr-comments', '/privacy-settings', '/release-notes', '/remote-control', '/resume', '/rewind', '/sandbox',
  '/status', '/statusline', '/terminal-setup', '/theme', '/todos', '/upgrade', '/usage', '/vim',
]);
const COMMAND = /<command-name>\s*(\/[\w:.-]+)\s*<\/command-name>/g;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);


/**
 * Read Claude Code session logs under `home`, keeping entries from `since` on.
 * Takes tool names, skill names, subagent types, MCP server/tool names, slash-command names,
 * working folders, timestamps and token counts. Message text is parsed but never kept.
 */
export async function readClaudeCode(home: string, since?: Date, opts: ReadOptions = {}): Promise<ReadResult> {
  const files: string[] = [];
  walkFiles(join(home, '.claude', 'projects'), MAX_DEPTH, (file) => {
    if (file.endsWith('.jsonl')) files.push(file);
  });

  const sessions = sessionTable('claude-code', opts.byDay);
  // A response is logged once per content block, each copy carrying the same usage: count it once.
  const seenMessages = new Set<string>();
  const seenToolCalls = new Set<string>();
  const seenEntries = new Set<string>();
  // Directory order isn't chronological (a subagent's file can be read before its parent's), so the
  // earliest preload candidate is tracked by timestamp, not by processing order.
  const preloadWhen = new Map<SessionUsage, Date>();
  let skipped = 0;

  for (const file of files) {
    if (since) {
      try { if (statSync(file).mtime < since) continue; } catch { continue; } // nothing newer inside
    }
    const fallbackId = basename(file, '.jsonl');
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { skipped++; continue; }
      if (!isObj(entry) || (entry.type !== 'user' && entry.type !== 'assistant')) continue; // titles, modes, snapshots…
      const when = new Date(str(entry.timestamp) ?? NaN);
      const message = entry.message;
      if (Number.isNaN(when.getTime()) || !isObj(message)) { skipped++; continue; }
      if (since && when < since) continue;
      if (opts.until && when >= opts.until) continue;
      const uuid = str(entry.uuid);
      if (uuid) {
        if (seenEntries.has(uuid)) continue;
        seenEntries.add(uuid);
      }

      const id = str(entry.sessionId) ?? fallbackId;
      const session = sessions.get(id, when);
      if (!session.first || when < session.first) session.first = when;
      if (!session.last || when > session.last) session.last = when;
      session.cwd ??= str(entry.cwd);

      if (entry.type === 'assistant') {
        const usage = message.usage;
        const messageId = str(message.id);
        if (isObj(usage) && messageId) {
          const key = `${messageId}|${str(entry.requestId) ?? ''}`;
          if (!seenMessages.has(key)) {
            seenMessages.add(key);
            session.tokens.input += num(usage.input_tokens);
            session.tokens.cacheWrite += num(usage.cache_creation_input_tokens);
            session.tokens.cacheRead += num(usage.cache_read_input_tokens);
            session.tokens.output += num(usage.output_tokens);
            // Preload is the top-level conversation's first turn, not a subagent's own.
            if (entry.isSidechain !== true) {
              const seenAt = preloadWhen.get(session);
              if (!seenAt || when < seenAt) {
                preloadWhen.set(session, when);
                session.preload = {
                  input: num(usage.input_tokens),
                  cacheWrite: num(usage.cache_creation_input_tokens),
                  cacheRead: num(usage.cache_read_input_tokens),
                  output: num(usage.output_tokens),
                };
              }
            }
          }
        }
        if (Array.isArray(message.content)) {
          for (const item of message.content) {
            if (isObj(item) && item.type === 'tool_use') recordToolCall(session, item, seenToolCalls);
          }
        }
      } else {
        for (const text of userTexts(message.content)) {
          for (const match of text.matchAll(COMMAND)) bump(session.commands, match[1]);
        }
      }
    }
  }

  const all = [...sessions.map.values()];
  for (const s of all) s.repo = resolveRepo(s.cwd);
  return { sessions: all, skipped };
}

function recordToolCall(session: SessionUsage, item: Obj, seen: Set<string>): void {
  const callId = str(item.id);
  if (callId) {
    if (seen.has(callId)) return;
    seen.add(callId);
  }
  const name = str(item.name);
  if (!name) return;
  const input = isObj(item.input) ? item.input : {};
  if (name === 'Skill') bump(session.skills, str(input.skill) ?? '?');
  else if (name === 'Agent' || name === 'Task') bump(session.subagents, str(input.subagent_type) ?? 'general-purpose');
  else if (name.startsWith('mcp__')) {
    const [server, ...tool] = name.slice('mcp__'.length).split('__');
    bump(session.mcp, `${server || '?'}/${tool.join('__') || '?'}`);
  } else bump(session.tools, name);
}

/** Text the person typed (where slash commands are logged); tool results are skipped. */
function userTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((i): i is Obj => isObj(i) && i.type === 'text' && typeof i.text === 'string').map((i) => i.text as string);
}

const repoCache = new Map<string, string>();

/** Nearest folder with a .git, with Claude Code worktrees (<repo>/.claude/worktrees/<name>) folded into their repo. */
export function resolveRepo(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const cached = repoCache.get(cwd);
  if (cached) return cached;
  const worktree = cwd.search(/[\\/]\.claude[\\/]worktrees[\\/]/);
  const start = worktree >= 0 ? cwd.slice(0, worktree) : cwd;
  let repo = start;
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) { repo = dir; break; }
    if (dirname(dir) === dir) break;
  }
  repoCache.set(cwd, repo);
  return repo;
}
