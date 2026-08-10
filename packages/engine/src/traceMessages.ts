import type { QueryableDB, SessionMessageTurn, TraceMessages } from '@agent-insights/types';
import { parseTraceSegmentId, getSegmentSpanIds } from './traces';
import { LLM_PREDICATE, lastUserPrompt, claudeLogTurns, codexLogTurns } from './sessions';

/**
 * The captured conversation of ONE trace, in the same shape `getSessionMessages`
 * returns for a whole session — so both tabs render through one code path.
 *
 * Scoping to a trace rather than a session is what lets the Traces tab read a
 * transcript for the many traces that belong to no session at all: standalone
 * utility model calls, host activity, anything the session filter drops.
 *
 * `traceId` may be a logical segment id (`<physicalTraceId>:<rootSpanId>`) for a
 * projected agent-host trace, in which case only that segment's turns come back.
 * Returns null when the trace has no spans — an id that matches nothing.
 */
export function getTraceMessages(db: QueryableDB, traceId: string): TraceMessages | null {
  if (!traceId?.trim()) { return null; }
  const id = traceId.trim();

  const segment = parseTraceSegmentId(id);
  const physicalTraceId = segment ? segment.physicalTraceId : id;
  const segmentSpanIds = segment ? (getSegmentSpanIds(db, id) ?? []) : null;

  if (segmentSpanIds && !segmentSpanIds.length) { return null; }
  if (!segmentSpanIds && !traceExists(db, physicalTraceId)) { return null; }

  const spanScope = segmentSpanIds
    ? ` AND span_id IN (${segmentSpanIds.map(() => '?').join(',')})`
    : '';

  const rows = db.prepare(`
    SELECT
      trace_id, span_id, name, start_time_unix_nano, status_code,
      json_extract(attributes,'$."gen_ai.request.model"')   AS model,
      json_extract(attributes,'$."gen_ai.output.messages"')  AS output_messages,
      json_extract(attributes,'$."gen_ai.input.messages"')   AS input_messages
    FROM spans
    WHERE trace_id = ?${spanScope}
      AND ${LLM_PREDICATE}
      AND json_extract(attributes,'$."gen_ai.output.messages"') IS NOT NULL
    ORDER BY start_time_unix_nano ASC
  `).all(physicalTraceId, ...(segmentSpanIds ?? []));

  const turns: SessionMessageTurn[] = rows.map(r => ({
    traceId:           String(r['trace_id'] ?? ''),
    spanId:            String(r['span_id'] ?? ''),
    spanName:          String(r['name'] ?? ''),
    startTimeUnixNano: String(r['start_time_unix_nano'] ?? '0'),
    model:             r['model'] != null ? String(r['model']) : null,
    hasError:          Number(r['status_code'] ?? 0) === 2,
    outputMessages:    String(r['output_messages'] ?? ''),
    inputPreview:      lastUserPrompt(r['input_messages']),
  }));

  // Same precedence as getSessionMessages: span attributes are the richer source
  // (tool calls, reasoning parts), so logs are consulted only when the trace
  // recorded none. Claude first — it reports both sides, Codex only the user's.
  const resolved = turns.length ? turns : (() => {
    const claude = claudeLogTurns(db, [physicalTraceId]);
    const fromLogs = claude.length ? claude : codexLogTurns(db, [physicalTraceId]);
    // Log records carry only a trace id, so a segment has to be cut out of the
    // physical trace by time — the same window the Sessions view slices on.
    return segmentSpanIds ? withinSegmentWindow(db, segmentSpanIds, physicalTraceId, fromLogs) : fromLogs;
  })();

  return { traceId: id, captureEnabled: resolved.length > 0, turns: resolved };
}

function traceExists(db: QueryableDB, traceId: string): boolean {
  const row = db.prepare(`SELECT 1 AS found FROM spans WHERE trace_id = ? LIMIT 1`).get(traceId);
  return row != null;
}

/** Turns that started inside the segment's [first start, last end) span of time.
 *  A zero-width segment (one instantaneous span) keeps turns at its instant. */
function withinSegmentWindow(
  db: QueryableDB,
  segmentSpanIds: string[],
  physicalTraceId: string,
  turns: SessionMessageTurn[],
): SessionMessageTurn[] {
  if (!turns.length) { return turns; }
  const ph = segmentSpanIds.map(() => '?').join(',');
  const row = db.prepare(`
    SELECT MIN(CAST(start_time_unix_nano AS INTEGER)) AS started,
           MAX(CAST(end_time_unix_nano   AS INTEGER)) AS ended
    FROM spans
    WHERE trace_id = ? AND span_id IN (${ph})
  `).get(physicalTraceId, ...segmentSpanIds);
  if (row?.['started'] == null) { return turns; }

  const start = BigInt(String(row['started']));
  const end = BigInt(String(row['ended'] ?? row['started']));
  return turns.filter(t => {
    const at = BigInt(t.startTimeUnixNano || '0');
    return at >= start && (at < end || start === end);
  });
}
