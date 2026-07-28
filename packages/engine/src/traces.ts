import type { QueryableDB, Trace, Span } from '@agent-insights/types';
import { SESSION_ID_EXPR, SESSION_TITLE_SPAN_NAME, SESSION_TRACE_FILTER } from './sessions';

export interface GetTracesOptions {
  limit?: number;
  sinceNano?: string;
  untilNano?: string;
  serviceName?: string;
  nameSearch?: string;
  errorsOnly?: boolean;
  attributeKey?: string;
  attributeValue?: string;
  sortOrder?: 'desc' | 'asc';
  /** Restrict to traces belonging to this resolved session id. */
  sessionId?: string;
}

export function getTraces(db: QueryableDB, opts: GetTracesOptions = {}): Trace[] {
  const {
    limit = 200,
    sinceNano,
    untilNano,
    serviceName,
    nameSearch,
    errorsOnly,
    attributeKey,
    attributeValue,
    sortOrder = 'desc',
    sessionId,
  } = opts;

  const conditions: string[] = [];
  const params: unknown[]    = [];

  // Session-title spans are synthetic metadata on a trace id of their own, so
  // each would otherwise surface as a junk single-span trace. The session list
  // reads their payload directly instead.
  conditions.push(`name != '${SESSION_TITLE_SPAN_NAME}'`);

  if (serviceName) {
    conditions.push('service_name = ?');
    params.push(serviceName);
  }

  // Session filter: restrict to traces whose trace-level resolved session id matches.
  // Reuses the same resolver as getSessions so the mapping is identical.
  if (sessionId) {
    conditions.push(`trace_id IN (
      SELECT trace_id FROM spans
      WHERE ${SESSION_TRACE_FILTER}
      GROUP BY trace_id
      HAVING ${SESSION_ID_EXPR} = ?
    )`);
    params.push(sessionId);
  }

  if (nameSearch) {
    // Search trace ID, root span name, and any span's name, span ID, or attribute values.
    conditions.push(`(
      trace_id LIKE ? OR
      name     LIKE ? OR
      trace_id IN (
        SELECT DISTINCT trace_id FROM spans
        WHERE name       LIKE ?
           OR span_id    LIKE ?
           OR attributes LIKE ?
      )
    )`);
    const like = `%${nameSearch}%`;
    params.push(like, like, like, like, like);
  }

  // Attribute filter: restrict to traces containing at least one matching span.
  // If a key is provided, use json_extract for an exact match on that attribute. (key requires value)
  // If ONLY a value is provided, do a substring search across the full JSON blob.
  if (attributeKey && attributeValue !== undefined) {
    const path = `'$."${attributeKey.replace(/"/g, '')}"'`;
    conditions.push(`trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE json_extract(attributes, ${path}) = ?)`);
    params.push(attributeValue);
  } else if (attributeValue) {
    conditions.push(`trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE attributes LIKE ?)`);
    params.push(`%${attributeValue}%`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const havingParts: string[] = [];
  if (sinceNano)   { havingParts.push('MIN(start_time_unix_nano) >= ?'); params.push(sinceNano); }
  if (untilNano)   { havingParts.push('MIN(start_time_unix_nano) <= ?'); params.push(untilNano); }
  if (errorsOnly)  { havingParts.push('SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) > 0'); }
  const havingClause = havingParts.length ? `HAVING ${havingParts.join(' AND ')}` : '';

  params.push(limit);

  const rows = db.prepare(`
    SELECT
      trace_id,
      MIN(start_time_unix_nano)  AS start_time_unix_nano,
      COUNT(*)                   AS span_count,
      SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS error_count,
      MAX(CASE WHEN (parent_span_id IS NULL OR parent_span_id = '')
               THEN name END)    AS root_span_name,
      MAX(service_name)          AS service_name,
      MAX(CASE WHEN (parent_span_id IS NULL OR parent_span_id = '')
               THEN duration_ms  ELSE 0 END) AS root_duration_ms,
      -- fallback: name of the span with the earliest start time
      MIN(name)                  AS earliest_span_name
    FROM spans
    ${whereClause}
    GROUP BY trace_id
    ${havingClause}
    ORDER BY MIN(start_time_unix_nano) ${sortOrder === 'asc' ? 'ASC' : 'DESC'}
    LIMIT ?
  `).all(...params);

  const traces: Trace[] = rows.map(r => ({
    traceId:           String(r['trace_id']          ?? ''),
    rootSpanName:      String(r['root_span_name']    ?? r['earliest_span_name'] ?? r['trace_id'] ?? ''),
    serviceName:       String(r['service_name']      ?? ''),
    startTimeUnixNano: String(r['start_time_unix_nano'] ?? '0'),
    durationMs:        Number(r['root_duration_ms']  ?? 0),
    spanCount:         Number(r['span_count']        ?? 0),
    hasError:          Number(r['error_count']       ?? 0) > 0,
  }));

  // A trace can match a search term without the term appearing anywhere in
  // the row itself (trace id / root span name) — e.g. a nested span's name,
  // span id, or an attribute value. Without pointing at *where* it matched,
  // the filtered list looks arbitrary (see: search results give no clue why
  // a trace was included). Resolve one representative matching span per
  // trace so the UI can surface it.
  if (nameSearch && traces.length) {
    annotateSearchMatches(db, traces, nameSearch);
  }

  return traces;
}

/** Populates `matchSpanId`/`matchSpanName`/`matchAttributeKey` on traces whose
 *  search match isn't already visible via `traceId`/`rootSpanName`. */
function annotateSearchMatches(db: QueryableDB, traces: Trace[], nameSearch: string): void {
  const term = nameSearch.toLowerCase();
  const needsLookup = traces.filter(t =>
    !t.traceId.toLowerCase().includes(term) && !t.rootSpanName.toLowerCase().includes(term)
  );
  if (!needsLookup.length) { return; }

  const like = `%${nameSearch}%`;
  const placeholders = needsLookup.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT trace_id, span_id, name, attributes
    FROM spans
    WHERE trace_id IN (${placeholders})
      AND (name LIKE ? OR span_id LIKE ? OR attributes LIKE ?)
    ORDER BY start_time_unix_nano ASC
  `).all(...needsLookup.map(t => t.traceId), like, like, like);

  // Prefer a match on the span's own name/id over an attribute match (more
  // meaningful at a glance); keep the first candidate found per trace.
  const bestByTrace = new Map<string, { spanId: string; name: string; attributeKey?: string; rank: number }>();
  for (const r of rows) {
    const traceId = String(r['trace_id'] ?? '');
    const spanId  = String(r['span_id']  ?? '');
    const name    = String(r['name']     ?? '');
    const nameMatches = name.toLowerCase().includes(term) || spanId.toLowerCase().includes(term);

    let attributeKey: string | undefined;
    let rank = nameMatches ? 0 : 1;
    if (!nameMatches) {
      attributeKey = findMatchingAttributeKey(r['attributes'], term);
    }

    const existing = bestByTrace.get(traceId);
    if (!existing || rank < existing.rank) {
      bestByTrace.set(traceId, { spanId, name, attributeKey, rank });
    }
  }

  for (const t of needsLookup) {
    const match = bestByTrace.get(t.traceId);
    if (!match) { continue; }
    t.matchSpanId = match.spanId;
    t.matchSpanName = match.name;
    if (match.attributeKey) { t.matchAttributeKey = match.attributeKey; }
  }
}

/** Finds the first attribute whose stringified value contains `term` (already lowercased). */
function findMatchingAttributeKey(rawAttributes: unknown, term: string): string | undefined {
  const attrs = parseJson(rawAttributes);
  for (const [key, value] of Object.entries(attrs)) {
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
    if (text.toLowerCase().includes(term)) { return key; }
  }
  return undefined;
}

export function getSpansByTraceId(db: QueryableDB, traceId: string): Span[] {
  const rows = db.prepare(`
    SELECT * FROM spans
    WHERE trace_id = ?
    ORDER BY start_time_unix_nano ASC
  `).all(traceId);

  return rows.map(r => ({
    traceId:           String(r['trace_id']           ?? ''),
    spanId:            String(r['span_id']            ?? ''),
    parentSpanId:      r['parent_span_id'] != null ? String(r['parent_span_id']) : null,
    name:              String(r['name']               ?? ''),
    kind:              Number(r['kind']               ?? 0),
    startTimeUnixNano: String(r['start_time_unix_nano'] ?? '0'),
    endTimeUnixNano:   String(r['end_time_unix_nano']   ?? '0'),
    durationMs:        Number(r['duration_ms']        ?? 0),
    statusCode:        Number(r['status_code']        ?? 0),
    statusMessage:     r['status_message'] != null ? String(r['status_message']) : null,
    attributes:        parseJson(r['attributes']),
    serviceName:       String(r['service_name']       ?? ''),
    raw:               parseJson(r['raw']),
  }));
}

function parseJson(v: unknown): Record<string, unknown> {
  try { return JSON.parse(String(v ?? '{}')) as Record<string, unknown>; } catch { return {}; }
}

export function getServices(db: QueryableDB): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT service_name FROM spans
    WHERE service_name IS NOT NULL AND service_name != ''
    ORDER BY service_name ASC
  `).all();
  return rows.map(r => String(r['service_name'] ?? ''));
}
