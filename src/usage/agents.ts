import type { AgentId } from '../sources.js';
import { BUILT_IN_COMMANDS as CLAUDE_BUILT_IN_COMMANDS, readClaudeCode } from './claude-code.js';
import { CODEX_BUILT_IN_COMMANDS, CODEX_BUILT_IN_SUBAGENTS, readCodex } from './codex.js';
import { GEMINI_BUILT_IN_COMMANDS, GEMINI_BUILT_IN_SUBAGENTS, readGemini } from './gemini.js';
import type { ReadOptions, ReadResult } from './types.js';

/** What roost knows about each agent: how to read its logs, and what's built in rather than a team's own. */
export interface AgentDef {
  id: AgentId;
  name: string;
  /** The value of `--agent` that picks this one. */
  flag: string;
  read: (home: string, since?: Date, opts?: ReadOptions) => Promise<ReadResult>;
  builtInCommands: ReadonlySet<string>;
  /** Built-in subagent types, compared in lower case. */
  builtInSubagents: ReadonlySet<string>;
}

export const AGENTS: readonly AgentDef[] = [
  {
    id: 'claude-code', name: 'Claude Code', flag: 'claude-code', read: readClaudeCode, builtInCommands: CLAUDE_BUILT_IN_COMMANDS,
    builtInSubagents: new Set(['general-purpose', 'explore', 'plan', 'fork', 'statusline-setup', 'output-style-setup', 'claude-code-guide']),
  },
  { id: 'codex', name: 'Codex', flag: 'codex', read: readCodex, builtInCommands: CODEX_BUILT_IN_COMMANDS, builtInSubagents: CODEX_BUILT_IN_SUBAGENTS },
  { id: 'gemini-cli', name: 'Gemini CLI', flag: 'gemini', read: readGemini, builtInCommands: GEMINI_BUILT_IN_COMMANDS, builtInSubagents: GEMINI_BUILT_IN_SUBAGENTS },
];

export const agentDef = (id: AgentId): AgentDef => AGENTS.find((a) => a.id === id)!;
