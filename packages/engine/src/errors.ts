import type { QueryableDB, Trace } from '@agent-insights/types';
import { getSpansByTraceId, getTraces } from './traces';

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
  return getTraces(db, {
    limit,
    sinceNano,
    untilNano,
    errorsOnly: true,
  }).map(trace => {
    const errorSpans: ErrorSpanSummary[] = getSpansByTraceId(db, trace.traceId)
      .filter(span => span.statusCode === 2)
      .map(span => {
        const attrs = span.attributes;
        // Exceptions are conventionally recorded as an OTLP span event named
        // "exception" (semconv). Prefer those event attributes, then fall back to
        // span-level exception.* attributes for SDKs that mirror them there.
        const evt = exceptionEventAttrs(span.raw);
        const exceptionType = evt['exception.type'] ?? attrs['exception.type'];
        const exceptionMessage = evt['exception.message'] ?? attrs['exception.message'];
        return {
          spanId: span.spanId,
          name: span.name,
          statusMessage: span.statusMessage ?? null,
          durationMs: span.durationMs,
          exceptionType: exceptionType != null ? String(exceptionType) : null,
          exceptionMessage: exceptionMessage != null ? String(exceptionMessage) : null,
        };
      });

    const { category: _category, ...errorTrace } = trace;
    return {
      ...errorTrace,
      errorSpans,
    };
  });
}

// Extracts the attributes of the most recent OTLP "exception" span event from a
// raw span JSON blob as a flat, dotted-key object (e.g. {"exception.type": ...}).
// Returns an empty object when the raw blob has no exception event.
function exceptionEventAttrs(raw: unknown): Record<string, unknown> {
  try {
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw ?? {}) as {
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
