import { noTokens, type SessionUsage, type Tokens } from './types.js';

export interface Counted {
  name: string;
  count: number;
  sessions: number;
  repos: number;
}

export interface McpServer {
  server: string;
  calls: number;
  sessions: number;
  repos: number;
  tools: Counted[];
}

export interface RepoUsage {
  repo: string | null;
  sessions: number;
  tokens: Tokens;
  skillRuns: number;
  subagentRuns: number;
  mcpCalls: number;
}

export interface UsageReport {
  since: Date | null;
  first: Date | null;
  last: Date | null;
  sessions: number;
  tokens: Tokens;
  skills: Counted[];
  subagents: Counted[];
  mcp: McpServer[];
  commands: Counted[];
  tools: Counted[];
  repos: RepoUsage[];
  skipped: number;
}

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const byCount = <T extends { count?: number; calls?: number; name?: string; server?: string }>(a: T, b: T) =>
  (b.count ?? b.calls ?? 0) - (a.count ?? a.calls ?? 0) || String(a.name ?? a.server).localeCompare(String(b.name ?? b.server));

function addTokens(into: Tokens, t: Tokens): void {
  into.input += t.input;
  into.cacheWrite += t.cacheWrite;
  into.cacheRead += t.cacheRead;
  into.output += t.output;
}

/** Totals for one kind of name across sessions: how often, in how many sessions and repos. */
function countAcross(sessions: SessionUsage[], pick: (s: SessionUsage) => Map<string, number>): Counted[] {
  const acc = new Map<string, { count: number; sessions: number; repos: Set<string | undefined> }>();
  for (const s of sessions) {
    for (const [name, n] of pick(s)) {
      const a = acc.get(name) ?? { count: 0, sessions: 0, repos: new Set() };
      a.count += n;
      a.sessions++;
      a.repos.add(s.repo);
      acc.set(name, a);
    }
  }
  return [...acc].map(([name, a]) => ({ name, count: a.count, sessions: a.sessions, repos: a.repos.size })).sort(byCount);
}

export function aggregate(sessions: SessionUsage[], skipped: number, since?: Date): UsageReport {
  const tokens = noTokens();
  let first: Date | null = null;
  let last: Date | null = null;
  for (const s of sessions) {
    addTokens(tokens, s.tokens);
    if (s.first && (!first || s.first < first)) first = s.first;
    if (s.last && (!last || s.last > last)) last = s.last;
  }

  // MCP: group "server/tool" counts by server
  const servers = new Map<string, SessionUsage[]>();
  for (const s of sessions) {
    for (const key of s.mcp.keys()) {
      const server = key.slice(0, key.indexOf('/'));
      const list = servers.get(server) ?? [];
      if (!list.includes(s)) list.push(s);
      servers.set(server, list);
    }
  }
  const mcp: McpServer[] = [...servers].map(([server, used]) => {
    const tools = countAcross(used, (s) => new Map([...s.mcp].filter(([k]) => k.startsWith(server + '/')).map(([k, n]) => [k.slice(server.length + 1), n])));
    return {
      server,
      calls: tools.reduce((a, t) => a + t.count, 0),
      sessions: used.length,
      repos: new Set(used.map((s) => s.repo)).size,
      tools,
    };
  }).sort(byCount);

  const repos = new Map<string | undefined, RepoUsage>();
  for (const s of sessions) {
    const r = repos.get(s.repo) ?? { repo: s.repo ?? null, sessions: 0, tokens: noTokens(), skillRuns: 0, subagentRuns: 0, mcpCalls: 0 };
    r.sessions++;
    addTokens(r.tokens, s.tokens);
    r.skillRuns += sum(s.skills);
    r.subagentRuns += sum(s.subagents);
    r.mcpCalls += sum(s.mcp);
    repos.set(s.repo, r);
  }

  return {
    since: since ?? null,
    first,
    last,
    sessions: sessions.length,
    tokens,
    skills: countAcross(sessions, (s) => s.skills),
    subagents: countAcross(sessions, (s) => s.subagents),
    mcp,
    commands: countAcross(sessions, (s) => s.commands),
    tools: countAcross(sessions, (s) => s.tools),
    repos: [...repos.values()].sort((a, b) => b.sessions - a.sessions || totalTokens(b.tokens) - totalTokens(a.tokens)),
    skipped,
  };
}

export const totalInput = (t: Tokens) => t.input + t.cacheWrite + t.cacheRead;
export const totalTokens = (t: Tokens) => totalInput(t) + t.output;
