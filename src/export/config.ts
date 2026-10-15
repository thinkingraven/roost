/**
 * Where `roost export --send` sends, from the standard OpenTelemetry settings plus roost's own opt-in:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT        base URL; roost posts logs to <base>/v1/logs
 *   OTEL_EXPORTER_OTLP_LOGS_ENDPOINT   full logs URL, used as is (wins over the base)
 *   OTEL_EXPORTER_OTLP_HEADERS         key=value,key=value (values URL-encoded), e.g. Authorization=Basic%20…
 *   OTEL_EXPORTER_OTLP_LOGS_HEADERS    the same, for logs only (wins)
 *   OTEL_RESOURCE_ATTRIBUTES           extra key=value labels on everything sent
 *   ROOST_EXPORT=on                    the explicit opt-in: without it (or --endpoint) nothing is sent
 *   ROOST_TEAM                         a team label
 *   ROOST_PERSON=hashed|none           a pseudonymous id per person (default hashed), or none
 *   ROOST_PERSON_SALT                  a company secret mixed into the hash, so ids can't be matched to emails
 *   ROOST_REPO=remote|name|none        github.com/org/repo (default), the folder name, or none
 */

export class ExportConfigError extends Error {}

export interface ExportConfig {
  /** Full URL logs are posted to, or undefined when none is configured. */
  logsUrl?: string;
  headers: Record<string, string>;
  resource: Record<string, string>;
  team?: string;
  person: 'hashed' | 'none';
  salt: string;
  repo: 'remote' | 'name' | 'none';
  /** ROOST_EXPORT=on, or an endpoint given on the command line: sending is always an explicit choice. */
  optedIn: boolean;
  /** Notes worth showing in the preview (e.g. a protocol roost doesn't speak). */
  notes: string[];
}

/** "a=b,c=d%20e" → { a: 'b', c: 'd e' }, the W3C baggage-style list OTEL_* variables use. */
export function parseList(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (value ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const decode = (s: string) => { try { return decodeURIComponent(s.trim()); } catch { return s.trim(); } };
    const key = decode(part.slice(0, i));
    if (key) out[key] = decode(part.slice(i + 1));
  }
  return out;
}

export function exportConfig(env: NodeJS.ProcessEnv, flags: { endpoint?: string; team?: string } = {}): ExportConfig {
  const notes: string[] = [];
  const protocol = env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol === 'grpc') throw new ExportConfigError('roost sends OTLP over HTTP, not gRPC. Point OTEL_EXPORTER_OTLP_ENDPOINT at the HTTP endpoint (usually port 4318, or the vendor\'s /otlp URL).');
  if (protocol === 'http/protobuf') notes.push('OTEL_EXPORTER_OTLP_PROTOCOL is http/protobuf; roost sends OTLP as JSON, which Grafana Cloud, OpenObserve and the OpenTelemetry Collector accept.');

  const base = (flags.endpoint ?? env.OTEL_EXPORTER_OTLP_ENDPOINT)?.trim().replace(/\/+$/, '');
  const logs = flags.endpoint ? undefined : env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim();
  const logsUrl = logs || (base ? `${base}/v1/logs` : undefined);
  if (logsUrl && !/^https?:\/\//i.test(logsUrl)) throw new ExportConfigError(`the OTLP endpoint must start with https:// (or http://), not "${logsUrl}"`);
  if (logsUrl?.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(logsUrl)) notes.push('The endpoint uses plain http://, so the data and the login header travel unencrypted.');

  const person = (env.ROOST_PERSON ?? 'hashed') as ExportConfig['person'];
  if (person !== 'hashed' && person !== 'none') throw new ExportConfigError(`ROOST_PERSON must be hashed or none, not "${env.ROOST_PERSON}"`);
  const repo = (env.ROOST_REPO ?? 'remote') as ExportConfig['repo'];
  if (!['remote', 'name', 'none'].includes(repo)) throw new ExportConfigError(`ROOST_REPO must be remote, name or none, not "${env.ROOST_REPO}"`);
  if (person === 'hashed' && !env.ROOST_PERSON_SALT) notes.push('Set ROOST_PERSON_SALT to a company secret: without it, anyone with a list of emails could match the hashed ids.');

  return {
    logsUrl,
    headers: { ...parseList(env.OTEL_EXPORTER_OTLP_HEADERS), ...parseList(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS) },
    resource: parseList(env.OTEL_RESOURCE_ATTRIBUTES),
    team: (flags.team ?? env.ROOST_TEAM)?.trim() || undefined,
    person,
    salt: env.ROOST_PERSON_SALT ?? '',
    repo,
    optedIn: env.ROOST_EXPORT === 'on' || !!flags.endpoint,
    notes,
  };
}

/** The endpoint for display: scheme, host and path, never userinfo or a query string. */
export function safeUrl(url: string): string {
  try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return '(invalid URL)'; }
}
