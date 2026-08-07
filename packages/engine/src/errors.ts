import type { QueryableDB, Trace } from '@agent-insights/types';

export interface ErrorSpanSummary {
  spanId: string;
  name: string;
  statusMessage: string | null;
  durationMs: number;
  exceptionType: string | null;
  exceptionMessage: string | null;
}

export interface ErrorTrace extends Omit<Trace, 'category'> {
  errorSpans: ErrorSpanSummary[];
}

export function getRecentErrorTraces(db: QueryableDB, limit = 10, sinceNano?: string, untilNano?: string): ErrorTrace[] {
  const havingParts = ['SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) > 0'];
  const params: unknown[] = [];
  if (sinceNano) { havingParts.push('MIN(start_time_unix_nano) >= ?'); params.push(sinceNano); }
  if (untilNano) { havingParts.push('MIN(start_time_unix_nano) <= ?'); params.push(untilNano); }
  params.push(limit);

  const traceRows = db.prepare(`
    SELECT
      trace_id,
      MIN(start_time_unix_nano)  AS start_time_unix_nano,
      COUNT(*)                   AS span_count,
      SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS error_count,
      MAX(CASE WHEN (parent_span_id IS NULL OR parent_span_id = '')
               THEN name END)    AS root_span_name,
      MAX(service_name)          AS service_name,
      MAX(CASE WHEN (parent_span_id IS NULL OR parent_span_id = '')
               THEN duration_ms  ELSE 0 END) AS root_duration_ms
    FROM spans
    GROUP BY trace_id
    HAVING ${havingParts.join(' AND ')}
    ORDER BY MIN(start_time_unix_nano) DESC
    LIMIT ?
  `).all(...params);

  return traceRows.map(r => {
    const traceId = String(r['trace_id'] ?? '');

    const errorSpanRows = db.prepare(`
      SELECT span_id, name, status_message, duration_ms, attributes, raw
      FROM spans
      WHERE trace_id = ? AND status_code = 2
      ORDER BY start_time_unix_nano ASC
    `).all(traceId);

    const errorSpans: ErrorSpanSummary[] = errorSpanRows.map(s => {
      const attrs = parseJson(s['attributes']);
      // Exceptions are conventionally recorded as an OTLP span event named
      // "exception" (semconv). Prefer those event attributes, then fall back to
      // span-level exception.* attributes for SDKs that mirror them there.
      const evt = exceptionEventAttrs(s['raw']);
      const exceptionType = evt['exception.type'] ?? attrs['exception.type'];
      const exceptionMessage = evt['exception.message'] ?? attrs['exception.message'];
      return {
        spanId: String(s['span_id'] ?? ''),
        name: String(s['name'] ?? ''),
        statusMessage: s['status_message'] != null ? String(s['status_message']) : null,
        durationMs: Number(s['duration_ms'] ?? 0),
        exceptionType: exceptionType != null ? String(exceptionType) : null,
        exceptionMessage: exceptionMessage != null ? String(exceptionMessage) : null,
      };
    });

    return {
      traceId,
      rootSpanName:      String(r['root_span_name'] ?? r['trace_id'] ?? ''),
      serviceName:       String(r['service_name'] ?? ''),
      startTimeUnixNano: String(r['start_time_unix_nano'] ?? '0'),
      durationMs:        Number(r['root_duration_ms'] ?? 0),
      spanCount:         Number(r['span_count'] ?? 0),
      hasError:          true,
      errorSpans,
    };
  });
}

function parseJson(v: unknown): Record<string, unknown> {
  try { return JSON.parse(String(v ?? '{}')) as Record<string, unknown>; } catch { return {}; }
}

// Extracts the attributes of the most recent OTLP "exception" span event from a
// raw span JSON blob as a flat, dotted-key object (e.g. {"exception.type": ...}).
// Returns an empty object when the raw blob has no exception event.
function exceptionEventAttrs(raw: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw ?? '{}')) as {
      span?: { events?: Array<{ name?: string; attributes?: Array<{ key?: string; value?: unknown }> }> };
    };
    const events = parsed?.span?.events;
    if (!Array.isArray(events)) { return {}; }
    // Last exception event wins (closest to failure).
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.name === 'exception') {
        return flattenOtlpAttrs(events[i].attributes);
      }
    }
    return {};
  } catch {
    return {};
  }
}

// Flattens an OTLP attribute array [{key, value:{stringValue|intValue|...}}]
// into a plain { key: scalar } object.
function flattenOtlpAttrs(
  attrs: Array<{ key?: string; value?: unknown }> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(attrs)) { return out; }
  for (const a of attrs) {
    if (!a || typeof a.key !== 'string') { continue; }
    const v = a.value as Record<string, unknown> | undefined;
    if (!v) { continue; }
    const scalar =
      v['stringValue'] ??
      (v['intValue'] != null ? Number(v['intValue']) : undefined) ??
      v['doubleValue'] ??
      v['boolValue'];
    if (scalar !== undefined) { out[a.key] = scalar; }
  }
  return out;
}
