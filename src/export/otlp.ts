import { VERSION } from '../version.js';
import { rowId, type Row } from './rows.js';

/**
 * Rows as OTLP/JSON logs (opentelemetry-proto, ExportLogsServiceRequest): one log record per row.
 * The record's time is the end of the day it summarises; attributes carry the labels and counts.
 * int64 values are JSON strings, as the protobuf JSON mapping requires.
 */

type AnyValue = { stringValue: string } | { intValue: string } | { boolValue: boolean };
interface KeyValue { key: string; value: AnyValue }

const str = (key: string, value: string): KeyValue => ({ key, value: { stringValue: value } });
const int = (key: string, value: number): KeyValue => ({ key, value: { intValue: String(Math.round(value)) } });
const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;

export interface OtlpContext {
  team?: string;
  person?: string;
  /** One stream per person (or per machine): log stores such as Loki reject entries older than a stream's newest. */
  instance: string;
  resource: Record<string, string>;
  now?: Date;
}

export function recordOf(r: Row, ctx: OtlpContext) {
  const attributes: KeyValue[] = [
    str('event.name', r.event),
    str('roost.day', r.day),
    str('roost.agent', r.agent),
    ...(r.repo ? [str('roost.repo', r.repo)] : []),
    ...(ctx.team ? [str('roost.team', ctx.team)] : []),
    ...(ctx.person ? [str('roost.person', ctx.person)] : []),
    ...(r.item ? [str(`roost.${r.item.key}`, r.item.value)] : []),
    ...Object.entries(r.labels).map(([k, v]) => str(`roost.${k}`, v)),
    ...Object.entries(r.values).map(([k, v]) => int(`roost.${k}`, v)),
    str('roost.row_id', rowId(r, ctx.person)),
  ];
  return {
    timeUnixNano: nanos(Date.parse(`${r.day}T23:59:59.999Z`)),
    observedTimeUnixNano: nanos((ctx.now ?? new Date()).getTime()),
    severityNumber: 9,
    severityText: 'INFO',
    body: { stringValue: r.event },
    attributes,
  };
}

/** One ExportLogsServiceRequest for a batch of rows. */
export function otlpPayload(rows: Row[], ctx: OtlpContext) {
  const resource = {
    ...ctx.resource,
    'service.name': 'roost',
    'service.version': VERSION,
    'service.instance.id': ctx.instance,
  };
  return {
    resourceLogs: [{
      resource: { attributes: Object.entries(resource).map(([k, v]) => str(k, v)) },
      scopeLogs: [{ scope: { name: 'roost', version: VERSION }, logRecords: rows.map((r) => recordOf(r, ctx)) }],
    }],
  };
}
