import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

/**
 * `roost decisions`: a readable report of rookery's runtime-hook log.
 *
 * `rookery hook <agent>` checks every tool call against a repo's `.rookery.yml` while an agent
 * works, and appends each deny or warn (never a pass) to `<rookery home>/decisions/YYYY-MM-DD.jsonl`
 * (`~/.rookery` by default, or `ROOKERY_HOME`). `roost export` already turns this into `rookery.policy`
 * rows for a company's dashboards (see `src/export/rows.ts`); this reads the same log for a
 * standalone, human report, with no OTLP setup needed.
 *
 * Fields are already redacted by rookery (first tokens, `~` paths only), so roost reads them as
 * counts and short subjects, the same way it reads everything else: never a full command line or
 * file contents, just what rule fired, on what, how often. `agent` and `kind` are rookery's own,
 * evolving vocabulary (more hook agents and kinds can land there before roost knows their names),
 * so they're read as plain strings and shown as-is rather than rejected.
 */

export type DecisionAction = 'deny' | 'warn';

export interface Decision {
  ts: Date;
  agent: string;
  kind: string;
  decision: DecisionAction;
  rule?: string;
  key?: string;
  subject: string;
  repo?: string;
}

export interface DecisionsResult {
  decisions: Decision[];
  /** Lines with no readable ts/decision/subject: a newer field shape, or a corrupt line. */
  skipped: number;
  /** Whether a decisions folder exists at all. */
  found: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const ACTIONS = new Set<string>(['deny', 'warn']);
const FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** Read rookery's decision log under `rookeryHome`/decisions, keeping entries from `since` on. */
export async function readDecisions(rookeryHome: string, since?: Date): Promise<DecisionsResult> {
  const dir = join(rookeryHome, 'decisions');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => FILE.test(f)).sort();
  } catch {
    return { decisions: [], skipped: 0, found: false };
  }

  const sinceDay = since?.toISOString().slice(0, 10);
  const decisions: Decision[] = [];
  let skipped = 0;
  for (const file of files) {
    if (sinceDay && file.slice(0, 10) < sinceDay) continue; // the whole day is before the window
    const lines = createInterface({ input: createReadStream(join(dir, file)), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        skipped++;
        continue;
      }
      if (!isObj(entry)) {
        skipped++;
        continue;
      }
      const ts = new Date(str(entry.ts) ?? NaN);
      const decision = str(entry.decision);
      const subject = str(entry.subject);
      if (Number.isNaN(ts.getTime()) || !decision || !ACTIONS.has(decision) || subject === undefined) {
        skipped++;
        continue;
      }
      if (since && ts < since) continue;
      decisions.push({
        ts,
        agent: str(entry.agent) ?? 'unknown',
        kind: str(entry.kind) ?? 'unknown',
        decision: decision as DecisionAction,
        rule: str(entry.rule),
        key: str(entry.key),
        subject,
        repo: str(entry.repo),
      });
    }
  }
  return { decisions, skipped, found: true };
}

export interface Tally {
  name: string;
  count: number;
}

export interface RuleTally {
  /** rookery's policy rule id when there is one (`RK-POL-…`), otherwise the policy key it matched. */
  id: string;
  count: number;
  /** One example subject, so the rule is recognisable without reading every line. */
  example: string;
}

export interface DecisionsReport {
  total: number;
  denied: number;
  warned: number;
  byAgent: Tally[];
  byRepo: Tally[];
  byRule: RuleTally[];
  skipped: number;
}

function tally(items: string[]): Tally[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Counts and groups decisions for the report: by outcome, agent, repo and rule. */
export function aggregateDecisions(decisions: Decision[], skipped: number): DecisionsReport {
  const byRule = new Map<string, RuleTally>();
  for (const d of decisions) {
    const id = d.rule ?? d.key ?? 'unknown';
    const existing = byRule.get(id);
    if (existing) existing.count++;
    else byRule.set(id, { id, count: 1, example: d.subject });
  }
  return {
    total: decisions.length,
    denied: decisions.filter((d) => d.decision === 'deny').length,
    warned: decisions.filter((d) => d.decision === 'warn').length,
    byAgent: tally(decisions.map((d) => d.agent)),
    byRepo: tally(decisions.flatMap((d) => (d.repo ? [d.repo] : []))),
    byRule: [...byRule.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    skipped,
  };
}
