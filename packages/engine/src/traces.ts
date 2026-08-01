import type { QueryableDB, Trace, Span, TraceMatch } from '@agent-insights/types';
import { SESSION_ID_EXPR, SESSION_TITLE_SPAN_NAME, SESSION_TRACE_FILTER } from './sessions';

// Search attributes in the same human-readable key/value form used by match previews.
const TRACE_SEARCH_ATTR_TEXT = `j.key || ' = ' || COALESCE(CAST(j.value AS TEXT), '')`;

// json_each() aborts the entire query with "malformed JSON" if handed a value
// that isn't valid JSON (including an empty string), so non-JSON rows degrade
// to an empty object instead of taking the whole trace list down with them.
const SPAN_ATTRS_JSON = `CASE WHEN json_valid(s.attributes) THEN s.attributes ELSE '{}' END`;

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

  if (serviceName) {
    conditions.push('service_name = ?');
    params.push(serviceName);
  }

  // Session filter: restrict to traces whose trace-level resolved session id matches.
  // Activity traces reuse the same resolver as getSessions. Title-change metadata
  // lives on synthetic trace ids, so include it directly by conversation id.
  if (sessionId) {
    conditions.push(`trace_id IN (
      SELECT trace_id FROM spans
      WHERE ${SESSION_TRACE_FILTER}
      GROUP BY trace_id
      HAVING ${SESSION_ID_EXPR} = ?
      UNION
      SELECT trace_id FROM spans
      WHERE name = '${SESSION_TITLE_SPAN_NAME}'
        AND json_extract(attributes,'$."gen_ai.conversation.id"') = ?
    )`);
    params.push(sessionId, sessionId);
  }

  const search = nameSearch?.trim();
  if (search) {
    // Select matching trace ids first so the outer aggregation still includes
    // every span in each trace. instr() keeps %, _ and other input literal.
    conditions.push(`trace_id IN (
      SELECT DISTINCT s.trace_id
        FROM spans s
       WHERE instr(lower(s.trace_id), lower(?)) > 0
          OR instr(lower(s.name), lower(?)) > 0
          OR instr(lower(s.span_id), lower(?)) > 0
          OR EXISTS (
            SELECT 1
              FROM json_each(${SPAN_ATTRS_JSON}) j
             WHERE instr(lower(${TRACE_SEARCH_ATTR_TEXT}), lower(?)) > 0
          )
    )`);
    params.push(search, search, search, search);
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

  return traces;
}

/** Snippet context on each side of the hit; ~matches VS Code's search preview width. */
const MATCH_CONTEXT_CHARS = 60;

export interface GetTraceMatchesOptions {
  /** Literal substring to locate. Case-insensitive (ASCII), not a LIKE pattern. */
  search: string;
  /** Restrict to these traces — normally the ids getTraces just returned. */
  traceIds: string[];
}

/**
 * Locate individual search hits inside traces, so the UI can show "match lines"
 * with previews the way VS Code's Search view does.
 *
 * Snippets are trimmed in SQL rather than in the client: gen_ai content
 * attributes run to tens of KB, and a broad term would otherwise ship megabytes
 * into the webview just to throw nearly all of it away.
 */
export function getTraceMatches(db: QueryableDB, opts: GetTraceMatchesOptions): TraceMatch[] {
  const { search, traceIds } = opts;
  if (!search || !traceIds.length) { return []; }

  const ph     = traceIds.map(() => '?').join(',');
  const ctx    = MATCH_CONTEXT_CHARS;
  // Code-point length, to match the character semantics of SQLite's substr().
  const width  = [...search].length + ctx * 2;
  // Attribute hits are matched against "key = value" so that a hit on either
  // side produces one row with a single, coherent preview.
  const attrText = TRACE_SEARCH_ATTR_TEXT;

  const rows = db.prepare(`
    WITH hits(trace_id, span_id, span_name, started, field, attr_key, text) AS (
      SELECT trace_id, span_id, name, start_time_unix_nano, 'name', NULL, name
        FROM spans
       WHERE trace_id IN (${ph}) AND instr(lower(name), lower(?)) > 0
      UNION ALL
      SELECT trace_id, span_id, name, start_time_unix_nano, 'spanId', NULL, span_id
        FROM spans
       WHERE trace_id IN (${ph}) AND instr(lower(span_id), lower(?)) > 0
      UNION ALL
      SELECT s.trace_id, s.span_id, s.name, s.start_time_unix_nano, 'attr', j.key, ${attrText}
        FROM spans s, json_each(${SPAN_ATTRS_JSON}) j
       WHERE s.trace_id IN (${ph}) AND instr(lower(${attrText}), lower(?)) > 0
      UNION ALL
      -- getTraces also matches on trace_id itself; without this branch a trace
      -- found only that way would get listed with zero match rows, looking
      -- like a false positive even though it did match.
      SELECT s.trace_id, s.span_id, s.name, s.start_time_unix_nano, 'traceId', NULL, s.trace_id
        FROM spans s
       WHERE s.trace_id IN (${ph}) AND instr(lower(s.trace_id), lower(?)) > 0
         AND s.start_time_unix_nano = (SELECT MIN(start_time_unix_nano) FROM spans WHERE trace_id = s.trace_id)
    ),
    located AS (
      SELECT *, instr(lower(text), lower(?)) AS off FROM hits
    ),
    snippets AS (
      -- Project away the full text as soon as the snippet exists: attribute
      -- values reach tens of KB, and carrying them through the sorts below is
      -- what makes prose-heavy searches slow.
      -- Each edge is reported separately: a snippet can be cut at the start,
      -- at the end, at both, or at neither, and the UI must only draw an
      -- ellipsis on a side that actually has text beyond it.
      SELECT trace_id, span_id, span_name, started, field, attr_key,
             substr(text, MAX(1, off - ${ctx}), ${width}) AS snippet,
             off - MAX(1, off - ${ctx})                   AS match_offset,
             off                                          AS off,
             MAX(1, off - ${ctx}) > 1                     AS trunc_start,
             MAX(1, off - ${ctx}) + ${width} - 1 < length(text) AS trunc_end,
             length(text)                                 AS text_len
        FROM located
    ),
    -- Boilerplate (system prompts, tool definitions) repeats verbatim across
    -- spans, so the same sentence would otherwise fill a trace's match list.
    deduped AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY trace_id, snippet ORDER BY started ASC) AS dup
        FROM snippets
    ),
    ranked AS (
      SELECT *,
             -- Short values (gen_ai.request.model) are far more legible as a
             -- preview than a 40KB prose blob, so surface them first.
             ROW_NUMBER() OVER (PARTITION BY trace_id ORDER BY text_len ASC, started ASC, off ASC) AS rn
        FROM deduped
       WHERE dup = 1
    )
    SELECT trace_id, span_id, span_name, field, attr_key, snippet, match_offset, trunc_start, trunc_end
      FROM ranked
     ORDER BY rn ASC, text_len ASC, started ASC
  `).all(...traceIds, search, ...traceIds, search, ...traceIds, search, ...traceIds, search, search);

  return rows.map(r => ({
    traceId:        String(r['trace_id']  ?? ''),
    spanId:         String(r['span_id']   ?? ''),
    spanName:       String(r['span_name'] ?? ''),
    field:          String(r['field'] ?? 'attr') as TraceMatch['field'],
    attrKey:        r['attr_key'] != null ? String(r['attr_key']) : undefined,
    snippet:        String(r['snippet'] ?? ''),
    matchOffset:    Number(r['match_offset'] ?? 0),
    truncatedStart: Number(r['trunc_start'] ?? 0) === 1,
    truncatedEnd:   Number(r['trunc_end']   ?? 0) === 1,
  }));
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
