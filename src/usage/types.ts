import type { AgentId } from '../sources.js';

export interface Tokens {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/**
 * Everything roost keeps from one session: names, counts, dates and token numbers.
 * Never message text, tool inputs or results.
 */
export interface SessionUsage {
  agent: AgentId;
  id: string;
  /** Working folder the session ran in, as logged. */
  cwd?: string;
  /** The repo it belongs to: nearest git root of `cwd`, worktrees folded in. */
  repo?: string;
  first?: Date;
  last?: Date;
  tokens: Tokens;
  /** Skill name → runs */
  skills: Map<string, number>;
  /** Subagent type → runs */
  subagents: Map<string, number>;
  /** "server/tool" → calls */
  mcp: Map<string, number>;
  /** Slash command → uses */
  commands: Map<string, number>;
  /** Built-in tool → calls */
  tools: Map<string, number>;
}

export const noTokens = (): Tokens => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });

export function newSession(agent: AgentId, id: string): SessionUsage {
  return {
    agent, id, tokens: noTokens(),
    skills: new Map(), subagents: new Map(), mcp: new Map(), commands: new Map(), tools: new Map(),
  };
}

/** Names come from logs, so strip control characters (no terminal escapes) and cap the length. */
export function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').trim();
  return (clean.length > 80 ? clean.slice(0, 79) + '…' : clean) || '?';
}

export function bump(map: Map<string, number>, name: string, by = 1): void {
  const key = cleanName(name);
  map.set(key, (map.get(key) ?? 0) + by);
}
