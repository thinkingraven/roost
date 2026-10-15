import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeUrl } from './config.js';

/**
 * The only place roost uses the network: `roost export --send` posting OTLP/JSON to the configured URL.
 * Batches of rows, a 30-second timeout per request, and an error that never echoes the login header.
 */

export const BATCH = 500;

export interface SendResult { requests: number; records: number; rejected: number }

export async function postLogs(url: string, headers: Record<string, string>, payloads: object[], fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const result: SendResult = { requests: 0, records: 0, rejected: 0 };
  for (const payload of payloads) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new Error(`couldn't reach ${safeUrl(url)}: ${(err as Error).message}`);
    }
    result.requests++;
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ' Check the login in OTEL_EXPORTER_OTLP_HEADERS.' : res.status === 404 ? ' Check the endpoint path (roost adds /v1/logs to OTEL_EXPORTER_OTLP_ENDPOINT).' : '';
      throw new Error(`${safeUrl(url)} answered ${res.status} ${res.statusText}.${hint} ${text.replace(/\s+/g, ' ').slice(0, 200)}`.trim());
    }
    const sent = (payload as { resourceLogs: { scopeLogs: { logRecords: unknown[] }[] }[] }).resourceLogs[0].scopeLogs[0].logRecords.length;
    result.records += sent;
    try {
      const body = JSON.parse(text || '{}');
      result.rejected += Number(body?.partialSuccess?.rejectedLogRecords ?? 0) || 0;
    } catch { /* not JSON: nothing rejected that we can see */ }
  }
  return result;
}

/** The last day sent to each endpoint, in ~/.roost/export-state.json, so each day goes once. */
export function stateFile(home: string): string {
  return join(home, '.roost', 'export-state.json');
}

const target = (url: string) => createHash('sha256').update(safeUrl(url)).digest('hex').slice(0, 16);

export function lastSentDay(home: string, url: string): string | undefined {
  try {
    const s = JSON.parse(readFileSync(stateFile(home), 'utf8'));
    const day = s?.targets?.[target(url)]?.lastDay;
    return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
  } catch { return undefined; }
}

export function recordSent(home: string, url: string, lastDay: string): void {
  let s: { targets?: Record<string, { lastDay: string; endpoint: string; at: string }> } = {};
  try { s = JSON.parse(readFileSync(stateFile(home), 'utf8')); } catch { /* first send */ }
  s.targets ??= {};
  s.targets[target(url)] = { lastDay, endpoint: safeUrl(url), at: new Date().toISOString() };
  mkdirSync(join(home, '.roost'), { recursive: true, mode: 0o700 });
  writeFileSync(stateFile(home), JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
}
