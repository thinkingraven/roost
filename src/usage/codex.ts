import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { walkFiles } from '../sources.js';
import { resolveRepo } from './claude-code.js';
import { bump, noTokens, sessionTable, type ReadOptions, type ReadResult, type SessionUsage, type Tokens } from './types.js';

/**
 * Codex keeps one rollout per thread: ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<id>.jsonl (and archived_sessions/).
 * Each line is {timestamp, type, payload}. roost takes tool calls, skill names, subagent types, MCP server/tool names,
 * the working folder, times and token counts. Message text is parsed only to find a skill's name, and never kept.
 *
 * Gotchas, from Codex's source (codex-rs, checked 2026-10-14):
 * - `total_token_usage` is cumulative, repeats, and resets when the context window is exceeded:
 *   sum `last_token_usage` whenever the total changes. From 0.153, `token_usage_record` lines carry each response once.
 * - A legacy fork copies its parent's lines (a second session_meta … thread_settings_applied): skip that block.
 * - MCP calls name the server reliably only in mcp_tool_call_end / item_completed, matched on call_id.
 * - A subagent's thread is its own file; it's counted into its parent's session, like Claude Code's.
 * - Custom slash commands aren't recorded; /review shows as entered_review_mode.
 */

/** Codex's own slash commands (tui/src/slash_command.rs), reported apart from a team's. */
export const CODEX_BUILT_IN_COMMANDS: ReadonlySet<string> = new Set([
  'model', 'daybreak', 'ide', 'permissions', 'approvals', 'keymap', 'vim', 'elevate-sandbox', 'experimental', 'auto-review', 'memories',
  'skills', 'import', 'hooks', 'review', 'rename', 'new', 'archive', 'delete', 'resume', 'fork', 'worktree', 'app', 'init', 'compact',
  'config', 'recap', 'plan', 'voice', 'goal', 'agents', 'side', 'btw', 'copy', 'export', 'raw', 'tui', 'diff', 'mention', 'status',
  'daemon', 'warnings', 'cd', 'pwd', 'usage', 'debug-config', 'title', 'statusline', 'theme', 'pets', 'mcp', 'apps', 'plugins',
  'logout', 'quit', 'exit', 'feedback', 'rollout', 'ps', 'stop', 'clear', 'multi-agents',
].map((c) => `/${c}`));
/** Agent roles that ship with Codex (core/src/agent/role.rs). */
export const CODEX_BUILT_IN_SUBAGENTS: ReadonlySet<string> = new Set(['default', 'explorer', 'worker']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const SKILL = /^<skill>\s*<name>([^<\n]{1,200})<\/name>/;
const BUILT_IN_NAMESPACES = new Set(['', 'functions', 'multi_agent_v1']);
const MAX_DEPTH = 5;

/** Per-thread state while reading one rollout file. */
interface Thread {
  id: string;
  cwd?: string;
  prevTotal: number;
  /** call_id → "server/tool" guessed from the call's namespace (and the session it belongs to), until an end event names them. */
  mcpCalls: Map<string, { guess: string; session: SessionUsage }>;
  mcpNames: Map<string, string>;
  /** Tokens per session (or per session-day) from token_count events and from token_usage_record lines; a file's records win when it has any. */
  tokens: Map<SessionUsage, { fromCounts: Tokens; fromRecords: Tokens; firstCounts?: Tokens; firstRecords?: Tokens }>;
  hasRecords: boolean;
}

export async function readCodex(home: string, since?: Date, opts: ReadOptions = {}): Promise<ReadResult> {
  const files: string[] = [];
  for (const dir of ['sessions', 'archived_sessions']) {
    walkFiles(join(home, '.codex', dir), MAX_DEPTH, (file) => { if (/(^|[\\/])rollout-[^\\/]+\.jsonl$/.test(file)) files.push(file); });
  }
  files.sort();
  const sessions = sessionTable('codex', opts.byDay);
  const seenCalls = new Set<string>();
  const seenResponses = new Set<string>();
  let skipped = 0;

  for (const file of files) {
    if (since) { try { if (statSync(file).mtime < since) continue; } catch { continue; } }
    let t: Thread | undefined;
    let copying = false;   // inside a fork's copy of its parent
    let lastWhen: Date | undefined;
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { skipped++; continue; }
      if (!isObj(entry) || !isObj(entry.payload) || !str(entry.type)) { skipped++; continue; }
      const p = entry.payload;
      let when = new Date(str(entry.timestamp) ?? NaN);
      if (Number.isNaN(when.getTime())) when = lastWhen ?? when; else lastWhen = when;

      if (entry.type === 'session_meta') {
        if (t) { copying = true; continue; }   // a second session_meta: the parent's lines follow
        const parent = isObj(p.source) && isObj(p.source.subagent) && isObj(p.source.subagent.thread_spawn) ? str(p.source.subagent.thread_spawn.parent_thread_id) : undefined;
        const id = parent ?? str(p.parent_thread_id) ?? str(p.id) ?? file;
        t = { id, cwd: str(p.cwd), prevTotal: 0, mcpCalls: new Map(), mcpNames: new Map(), tokens: new Map(), hasRecords: false };
        continue;
      }
      if (!t) continue;   // nothing before the thread's own metadata counts
      if (copying) {
        if (entry.type === 'event_msg' && p.type === 'thread_settings_applied') copying = false;
        else if (entry.type === 'event_msg' && p.type === 'token_count') t.prevTotal = totalOf(p) ?? t.prevTotal;
        continue;
      }
      const known = !Number.isNaN(when.getTime());
      if ((since && known && when < since) || (opts.until && known && when >= opts.until)) {
        // Outside the window, but the running total still moves: a repeat just inside it must not count again.
        if (entry.type === 'event_msg' && p.type === 'token_count') t.prevTotal = totalOf(p) ?? t.prevTotal;
        continue;
      }
      const s = sessions.get(t.id, known ? when : undefined);
      s.cwd ??= t.cwd;
      let tk = t.tokens.get(s);
      if (!tk) t.tokens.set(s, (tk = { fromCounts: noTokens(), fromRecords: noTokens() }));
      if (known) {
        if (!s.first || when < s.first) s.first = when;
        if (!s.last || when > s.last) s.last = when;
      }

      if (entry.type === 'response_item') recordItem(t, s, p, seenCalls);
      else if (entry.type === 'token_usage_record') {
        const id = str(p.response_id);
        t.hasRecords = true;
        if (id && seenResponses.has(id)) continue;
        if (id) seenResponses.add(id);
        if (isObj(p.usage)) {
          addUsage(tk.fromRecords, p.usage);
          if (!tk.firstRecords) { tk.firstRecords = noTokens(); addUsage(tk.firstRecords, p.usage); }
        }
      } else if (entry.type === 'event_msg') {
        if (p.type === 'token_count') {
          const total = totalOf(p);
          if (total === undefined || total === t.prevTotal) continue;   // info:null, or a repeat
          t.prevTotal = total;
          const info = p.info as Obj;
          const last = isObj(info.last_token_usage) ? info.last_token_usage : undefined;
          const reset = isObj(info.total_token_usage) && num(info.total_token_usage.input_tokens) === 0 && num(info.total_token_usage.output_tokens) === 0;
          if (last && !reset) {
            addUsage(tk.fromCounts, last);
            if (!tk.firstCounts) { tk.firstCounts = noTokens(); addUsage(tk.firstCounts, last); }
          }
        } else if (p.type === 'mcp_tool_call_end' && isObj(p.invocation)) {
          const id = str(p.call_id), server = str(p.invocation.server), tool = str(p.invocation.tool);
          if (id && server && tool) t.mcpNames.set(id, `${server}/${tool}`);
        } else if (p.type === 'item_completed' && isObj(p.item) && p.item.type === 'McpToolCall') {
          const id = str(p.item.id), server = str(p.item.server), tool = str(p.item.tool);
          if (id && server && tool) t.mcpNames.set(id, `${server}/${tool}`);
        } else if (p.type === 'entered_review_mode') bump(s.commands, '/review');
      }
    }
    if (!t) continue;
    for (const [id, call] of t.mcpCalls) bump(call.session.mcp, t.mcpNames.get(id) ?? call.guess);
    for (const [session, tk] of t.tokens) {
      const used = t.hasRecords ? tk.fromRecords : tk.fromCounts;
      for (const k of ['input', 'cacheWrite', 'cacheRead', 'output'] as const) session.tokens[k] += used[k];
      // The earliest file touching a session sets its preload (files.sort() keeps rollouts in
      // chronological order, and a fork or subagent thread's own file always starts later).
      if (!session.preload) session.preload = t.hasRecords ? tk.firstRecords : tk.firstCounts;
    }
  }

  const all = [...sessions.map.values()].filter((s) => s.first || s.last);
  for (const s of all) s.repo = resolveRepo(s.cwd);
  return { sessions: all, skipped };
}

function totalOf(p: Obj): number | undefined {
  return isObj(p.info) && isObj(p.info.total_token_usage) ? num(p.info.total_token_usage.total_tokens) : undefined;
}

/** Codex counts cached input inside input_tokens, and reasoning inside output_tokens. */
function addUsage(into: Tokens, u: Obj): void {
  into.input += Math.max(0, num(u.input_tokens) - num(u.cached_input_tokens));
  into.cacheRead += num(u.cached_input_tokens);
  into.cacheWrite += num(u.cache_write_input_tokens);
  into.output += num(u.output_tokens);
}

function recordItem(t: Thread, s: SessionUsage, p: Obj, seenCalls: Set<string>): void {
  const type = str(p.type);
  if (type === 'message') {
    if (p.role !== 'user' || !Array.isArray(p.content)) return;
    for (const part of p.content) {
      const m = isObj(part) && typeof part.text === 'string' ? SKILL.exec(part.text) : null;
      if (m) bump(s.skills, m[1].trim());
    }
    return;
  }
  const callId = str(p.call_id);
  if (callId) { if (seenCalls.has(callId)) return; seenCalls.add(callId); }
  if (type === 'function_call') {
    const name = str(p.name);
    if (!name) return;
    const ns = str(p.namespace) ?? '';
    if (ns.startsWith('mcp__') || (!ns && name.startsWith('mcp__'))) {
      // Sanitised names: only a guess at the server. The end event, if any, replaces it.
      const [server, ...tool] = ns ? [ns.slice(5), name] : name.slice(5).split('__');
      const guess = `${server || '?'}/${tool.join('__') || '?'}`;
      if (callId) t.mcpCalls.set(callId, { guess, session: s }); else bump(s.mcp, guess);
      return;
    }
    if (name === 'spawn_agent') {
      let role = 'default';
      try { const a = JSON.parse(str(p.arguments) ?? '{}'); if (isObj(a) && str(a.agent_type)) role = a.agent_type as string; } catch { /* default */ }
      bump(s.subagents, role);
      return;
    }
    bump(s.tools, BUILT_IN_NAMESPACES.has(ns) ? name : `${ns}/${name}`);
  } else if (type === 'custom_tool_call') bump(s.tools, str(p.name) ?? 'custom_tool');
  else if (type === 'local_shell_call') bump(s.tools, 'local_shell');
  else if (type === 'web_search_call') bump(s.tools, 'web_search');
  else if (type === 'tool_search_call') bump(s.tools, 'tool_search');
  else if (type === 'image_generation_call') bump(s.tools, 'image_generation');
}
