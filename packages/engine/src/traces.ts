import type { QueryableDB, Trace, Span, TraceCategory, TraceMatch } from '@agent-insights/types';
import { SESSION_TRACE_IDS_SQL } from './sessions';
import { effectiveDurationMsSql } from './duration';

// Search attributes in the same human-readable key/value form used by match previews.
const TRACE_SEARCH_ATTR_TEXT = `j.key || ' = ' || COALESCE(CAST(j.value AS TEXT), '')`;

// json_each() aborts the entire query with "malformed JSON" if handed a value
// that isn't valid JSON (including an empty string), so non-JSON rows degrade
// to an empty object instead of taking the whole trace list down with them.
const SPAN_ATTRS_JSON = `CASE WHEN json_valid(s.attributes) THEN s.attributes ELSE '{}' END`;
const HOST_SESSION_SPAN = 'vscode.agent_host.session';
const SEGMENT_SEPARATOR = ':';

const CODEX_BACKGROUND_ROOTS = [
  'account/read',
  'app_server.serialized_request_queue',
  'config/read',
  'hooks/list',
  'initialize',
  'list_models',
  'load_plugins_from_layer_stack',
  'load_with_cli_overrides',
  'mcpServerStatus/list',
  'plugins_for_config',
  'recommended_plugins_mode_for_config',
  'session_loop',
  'shell_snapshot',
  'skills/list',
  'skills/extraRoots/set',
  'thread/list',
  'thread/unsubscribe',
] as const;

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
  /** Omit to include every category. An empty array intentionally matches none. */
  categories?: TraceCategory[];
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
    categories,
    sessionId,
  } = opts;

  const conditions: string[] = [];
  const params: unknown[]    = [];

  const search = nameSearch?.trim();
  const matchPredicate = search
    ? `instr(lower(s.trace_id), lower(?)) > 0
       OR instr(lower(s.name), lower(?)) > 0
       OR instr(lower(s.span_id), lower(?)) > 0
       OR EXISTS (
         SELECT 1 FROM json_each(${SPAN_ATTRS_JSON}) j
         WHERE instr(lower(${TRACE_SEARCH_ATTR_TEXT}), lower(?)) > 0
       )`
    : '1';
  const standaloneMatchExpr = search
    ? `MAX(CASE WHEN ${matchPredicate} THEN 1 ELSE 0 END)`
    : '1';
  const projectedMatchExpr = search
    ? `MAX(CASE WHEN (${matchPredicate})
                    OR instr(
                      lower(sr.trace_id || '${SEGMENT_SEPARATOR}' || sr.root_span_id),
                      lower(?)
                    ) > 0
                THEN 1 ELSE 0 END)`
    : '1';
  const standaloneMatchParams = search ? [search, search, search, search] : [];
  const projectedMatchParams = search ? [...standaloneMatchParams, search] : [];

  let attributeExpr = '1';
  const attributeParams: unknown[] = [];
  if (attributeKey && attributeValue !== undefined) {
    const path = `'$."${attributeKey.replace(/"/g, '')}"'`;
    attributeExpr = `MAX(CASE WHEN json_extract(${SPAN_ATTRS_JSON}, ${path}) = ? THEN 1 ELSE 0 END)`;
    attributeParams.push(attributeValue);
  } else if (attributeValue) {
    attributeExpr = `MAX(CASE WHEN s.attributes LIKE ? THEN 1 ELSE 0 END)`;
    attributeParams.push(`%${attributeValue}%`);
  }

  if (serviceName) { conditions.push('service_name = ?'); params.push(serviceName); }
  if (search) { conditions.push('matched = 1'); }
  if (attributeExpr !== '1') { conditions.push('attribute_matched = 1'); }
  if (sinceNano) { conditions.push('start_time_unix_nano >= ?'); params.push(sinceNano); }
  if (untilNano) { conditions.push('start_time_unix_nano <= ?'); params.push(untilNano); }
  if (errorsOnly) { conditions.push('error_count > 0'); }
  if (categories) {
    if (categories.length === 0) {
      conditions.push('0');
    } else {
      conditions.push(`category IN (${categories.map(() => '?').join(',')})`);
      params.push(...categories);
    }
  }
  if (sessionId) {
    conditions.push(`physical_trace_id IN (${SESSION_TRACE_IDS_SQL})`);
    params.push(sessionId, sessionId);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const backgroundNames = CODEX_BACKGROUND_ROOTS.map(name => `'${name.replace(/'/g, "''")}'`).join(',');
  const queryParams = [
    ...projectedMatchParams,
    ...attributeParams,
    ...standaloneMatchParams,
    ...attributeParams,
    ...params,
    limit,
  ];

  const rows = db.prepare(`
    WITH RECURSIVE
    host_roots AS (
      SELECT trace_id, span_id
      FROM spans
      WHERE name = '${HOST_SESSION_SPAN}'
        AND (parent_span_id IS NULL OR parent_span_id = '')
    ),
    segment_roots AS (
      SELECT s.trace_id, s.span_id AS root_span_id, 0 AS is_partial
      FROM spans s
      JOIN host_roots h
        ON h.trace_id = s.trace_id AND h.span_id = s.parent_span_id
      UNION ALL
      SELECT s.trace_id, s.parent_span_id AS root_span_id, 1 AS is_partial
      FROM spans s
      JOIN host_roots h ON h.trace_id = s.trace_id
      LEFT JOIN spans p
        ON p.trace_id = s.trace_id AND p.span_id = s.parent_span_id
      WHERE s.parent_span_id IS NOT NULL AND s.parent_span_id != ''
        AND p.span_id IS NULL
      GROUP BY s.trace_id, s.parent_span_id
    ),
    segment_spans(trace_id, root_span_id, span_id, depth, visited) AS (
      SELECT r.trace_id, r.root_span_id, s.span_id, 0,
             ',' || s.span_id || ','
      FROM segment_roots r
      JOIN spans s ON s.trace_id = r.trace_id
       AND (s.span_id = r.root_span_id
            OR (r.is_partial = 1 AND s.parent_span_id = r.root_span_id))
      UNION ALL
      SELECT ss.trace_id, ss.root_span_id, child.span_id, ss.depth + 1,
             ss.visited || child.span_id || ','
      FROM segment_spans ss
      JOIN spans child
        ON child.trace_id = ss.trace_id AND child.parent_span_id = ss.span_id
      WHERE ss.depth < 1000
        AND instr(ss.visited, ',' || child.span_id || ',') = 0
    ),
    projected AS (
      SELECT
        sr.trace_id || '${SEGMENT_SEPARATOR}' || sr.root_span_id AS trace_id,
        sr.trace_id AS physical_trace_id,
        sr.root_span_id,
        COALESCE(
          MAX(CASE WHEN s.span_id = sr.root_span_id THEN s.name END),
          'Unresolved operation'
        ) AS root_span_name,
        COALESCE(
          MAX(CASE WHEN s.span_id = sr.root_span_id THEN s.service_name END),
          MAX(s.service_name),
          ''
        ) AS service_name,
        MIN(s.start_time_unix_nano) AS start_time_unix_nano,
        MAX(s.end_time_unix_nano) AS end_time_unix_nano,
        CASE WHEN sr.is_partial = 1
          THEN MAX(0, (CAST(MAX(s.end_time_unix_nano) AS INTEGER)
                     - CAST(MIN(s.start_time_unix_nano) AS INTEGER)) / 1000000.0)
          ELSE MAX(CASE WHEN s.span_id = sr.root_span_id
                        THEN ${effectiveDurationMsSql('s')} ELSE 0 END)
        END AS duration_ms,
        COUNT(*) AS span_count,
        SUM(CASE WHEN s.status_code = 2 THEN 1 ELSE 0 END) AS error_count,
        sr.is_partial,
        'agentActivity' AS category,
        0 AS is_background,
        ${projectedMatchExpr} AS matched,
        ${attributeExpr} AS attribute_matched
      FROM segment_roots sr
      JOIN segment_spans ss
        ON ss.trace_id = sr.trace_id AND ss.root_span_id = sr.root_span_id
      JOIN spans s
        ON s.trace_id = ss.trace_id AND s.span_id = ss.span_id
      GROUP BY sr.trace_id, sr.root_span_id, sr.is_partial
    ),
    standalone AS (
      SELECT
        s.trace_id,
        s.trace_id AS physical_trace_id,
        NULL AS root_span_id,
        COALESCE(
          MAX(CASE WHEN s.parent_span_id IS NULL OR s.parent_span_id = '' THEN s.name END),
          MIN(s.name),
          s.trace_id
        ) AS root_span_name,
        COALESCE(
          MAX(CASE WHEN s.parent_span_id IS NULL OR s.parent_span_id = ''
                   THEN s.service_name END),
          MAX(s.service_name)
        ) AS service_name,
        MIN(s.start_time_unix_nano) AS start_time_unix_nano,
        MAX(s.end_time_unix_nano) AS end_time_unix_nano,
        MAX(CASE WHEN s.parent_span_id IS NULL OR s.parent_span_id = ''
                 THEN ${effectiveDurationMsSql('s')} ELSE 0 END) AS duration_ms,
        COUNT(*) AS span_count,
        SUM(CASE WHEN s.status_code = 2 THEN 1 ELSE 0 END) AS error_count,
        0 AS is_partial,
        CASE
          WHEN COUNT(*) = 1
            AND SUM(CASE WHEN s.parent_span_id IS NULL OR s.parent_span_id = '' THEN 1 ELSE 0 END) = 1
            AND MAX(CASE WHEN json_extract(${SPAN_ATTRS_JSON}, '$."gen_ai.request.model"') IS NOT NULL THEN 1 ELSE 0 END) = 1
            AND MAX(CASE WHEN
              json_extract(${SPAN_ATTRS_JSON}, '$."gen_ai.conversation.id"') IS NOT NULL
              OR json_extract(${SPAN_ATTRS_JSON}, '$."session.id"') IS NOT NULL
              OR json_extract(${SPAN_ATTRS_JSON}, '$."copilot_chat.chat_session_id"') IS NOT NULL
            THEN 1 ELSE 0 END) = 0
          THEN 'utilityModelCall'
          WHEN COALESCE(
                 MAX(CASE WHEN s.parent_span_id IS NULL OR s.parent_span_id = ''
                          THEN s.service_name END),
                 MAX(s.service_name)
               ) = 'codex-app-server'
               AND COALESCE(
                 MAX(CASE WHEN s.parent_span_id IS NULL OR s.parent_span_id = '' THEN s.name END),
                 MIN(s.name)
               ) IN (${backgroundNames})
          THEN 'hostActivity'
          WHEN MAX(CASE WHEN
            json_extract(${SPAN_ATTRS_JSON}, '$."gen_ai.conversation.id"') IS NOT NULL
            OR json_extract(${SPAN_ATTRS_JSON}, '$."session.id"') IS NOT NULL
            OR json_extract(${SPAN_ATTRS_JSON}, '$."copilot_chat.chat_session_id"') IS NOT NULL
          THEN 1 ELSE 0 END) = 1
          THEN 'agentActivity'
          WHEN MAX(CASE WHEN s.service_name IN ('claude-code', 'github-copilot') THEN 1 ELSE 0 END) = 1
            AND (
              COUNT(*) > 1
              OR MAX(CASE WHEN json_extract(${SPAN_ATTRS_JSON}, '$."gen_ai.request.model"') IS NOT NULL THEN 1 ELSE 0 END) = 1
            )
          THEN 'agentActivity'
          ELSE 'other'
        END AS category,
        CASE WHEN COALESCE(
                    MAX(CASE WHEN s.parent_span_id IS NULL OR s.parent_span_id = ''
                             THEN s.service_name END),
                    MAX(s.service_name)
                  ) = 'codex-app-server'
                  AND COALESCE(
                    MAX(CASE WHEN s.parent_span_id IS NULL OR s.parent_span_id = '' THEN s.name END),
                    MIN(s.name)
                  ) IN (${backgroundNames})
             THEN 1 ELSE 0 END AS is_background,
        ${standaloneMatchExpr} AS matched,
        ${attributeExpr} AS attribute_matched
      FROM spans s
      WHERE NOT EXISTS (
        SELECT 1 FROM host_roots h WHERE h.trace_id = s.trace_id
      )
      GROUP BY s.trace_id
    ),
    trace_rows AS (
      SELECT * FROM projected
      UNION ALL
      SELECT * FROM standalone
    )
    SELECT *
    FROM trace_rows
    ${whereClause}
    ORDER BY CAST(start_time_unix_nano AS INTEGER) ${sortOrder === 'asc' ? 'ASC' : 'DESC'}
    LIMIT ?
  `).all(...queryParams);

  const traces: Trace[] = rows.map(r => ({
    traceId:           String(r['trace_id']          ?? ''),
    physicalTraceId:   String(r['physical_trace_id'] ?? r['trace_id'] ?? ''),
    rootSpanId:        r['root_span_id'] != null ? String(r['root_span_id']) : undefined,
    rootSpanName:      String(r['root_span_name']    ?? r['trace_id'] ?? ''),
    serviceName:       String(r['service_name']      ?? ''),
    startTimeUnixNano: String(r['start_time_unix_nano'] ?? '0'),
    endTimeUnixNano:   String(r['end_time_unix_nano'] ?? r['start_time_unix_nano'] ?? '0'),
    durationMs:        Number(r['duration_ms']       ?? 0),
    category:          String(r['category']          ?? 'other') as TraceCategory,
    isBackground:      Number(r['is_background']    ?? 0) > 0,
    isPartial:         Number(r['is_partial']       ?? 0) > 0,
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

  const selected = traceIds.map(logicalId => {
    const segment = parseTraceSegmentId(logicalId);
    return {
      logicalId,
      physicalTraceId: segment?.physicalTraceId ?? logicalId,
      rootSpanId: segment?.rootSpanId ?? null,
    };
  });
  const selectedValues = selected.map(() => '(?, ?, ?)').join(',');
  const selectedParams = selected.flatMap(item =>
    [item.logicalId, item.physicalTraceId, item.rootSpanId]);
  const ctx    = MATCH_CONTEXT_CHARS;
  // Code-point length, to match the character semantics of SQLite's substr().
  const width  = [...search].length + ctx * 2;
  // Attribute hits are matched against "key = value" so that a hit on either
  // side produces one row with a single, coherent preview.
  const attrText = TRACE_SEARCH_ATTR_TEXT;

  const rows = db.prepare(`
    WITH RECURSIVE
    selected(logical_id, physical_trace_id, root_span_id) AS (
      VALUES ${selectedValues}
    ),
    selected_spans(logical_id, physical_trace_id, span_id, depth, visited) AS (
      SELECT sel.logical_id, sel.physical_trace_id, s.span_id, 0,
             ',' || s.span_id || ','
      FROM selected sel
      JOIN spans s ON s.trace_id = sel.physical_trace_id
       AND (
         sel.root_span_id IS NULL
         OR s.span_id = sel.root_span_id
         OR (
           s.parent_span_id = sel.root_span_id
           AND NOT EXISTS (
             SELECT 1 FROM spans root
             WHERE root.trace_id = sel.physical_trace_id
               AND root.span_id = sel.root_span_id
           )
         )
       )
      UNION ALL
      SELECT ss.logical_id, ss.physical_trace_id, child.span_id, ss.depth + 1,
             ss.visited || child.span_id || ','
      FROM selected_spans ss
      JOIN selected sel ON sel.logical_id = ss.logical_id
      JOIN spans child
        ON child.trace_id = ss.physical_trace_id
       AND child.parent_span_id = ss.span_id
      WHERE sel.root_span_id IS NOT NULL
        AND ss.depth < 1000
        AND instr(ss.visited, ',' || child.span_id || ',') = 0
    ),
    hits(trace_id, physical_trace_id, span_id, span_name, started, field, attr_key, text) AS (
      SELECT ss.logical_id, s.trace_id, s.span_id, s.name, s.start_time_unix_nano, 'name', NULL, s.name
        FROM selected_spans ss
        JOIN spans s ON s.trace_id = ss.physical_trace_id AND s.span_id = ss.span_id
       WHERE instr(lower(s.name), lower(?)) > 0
      UNION ALL
      SELECT ss.logical_id, s.trace_id, s.span_id, s.name, s.start_time_unix_nano, 'spanId', NULL, s.span_id
        FROM selected_spans ss
        JOIN spans s ON s.trace_id = ss.physical_trace_id AND s.span_id = ss.span_id
       WHERE instr(lower(s.span_id), lower(?)) > 0
      UNION ALL
      SELECT ss.logical_id, s.trace_id, s.span_id, s.name, s.start_time_unix_nano, 'attr', j.key, ${attrText}
        FROM selected_spans ss
        JOIN spans s ON s.trace_id = ss.physical_trace_id AND s.span_id = ss.span_id,
             json_each(${SPAN_ATTRS_JSON}) j
       WHERE instr(lower(${attrText}), lower(?)) > 0
      UNION ALL
      -- getTraces also matches on the physical trace id itself; without this
      -- branch a segment found only that way would have no match preview.
      SELECT ss.logical_id, s.trace_id, s.span_id, s.name, s.start_time_unix_nano,
             'traceId', NULL, s.trace_id
        FROM selected_spans ss
        JOIN spans s ON s.trace_id = ss.physical_trace_id AND s.span_id = ss.span_id
       WHERE instr(lower(s.trace_id), lower(?)) > 0
         AND s.start_time_unix_nano = (
           SELECT MIN(first.start_time_unix_nano)
           FROM selected_spans first_ss
           JOIN spans first
             ON first.trace_id = first_ss.physical_trace_id
            AND first.span_id = first_ss.span_id
           WHERE first_ss.logical_id = ss.logical_id
         )
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
  `).all(...selectedParams, search, search, search, search, search);

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
  const segment = parseTraceSegmentId(traceId);
  const rows = segment
    ? db.prepare(`
        WITH RECURSIVE segment_spans(span_id, depth, visited) AS (
          SELECT span_id, 0, ',' || span_id || ',' FROM spans
          WHERE trace_id = ? AND span_id = ?
          UNION ALL
          SELECT span_id, 0, ',' || span_id || ',' FROM spans
          WHERE trace_id = ? AND parent_span_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM spans root WHERE root.trace_id = ? AND root.span_id = ?
            )
          UNION ALL
          SELECT child.span_id, parent.depth + 1,
                 parent.visited || child.span_id || ','
          FROM segment_spans parent
          JOIN spans child
            ON child.trace_id = ? AND child.parent_span_id = parent.span_id
          WHERE parent.depth < 1000
            AND instr(parent.visited, ',' || child.span_id || ',') = 0
        )
        SELECT * FROM spans
        WHERE trace_id = ? AND span_id IN (SELECT span_id FROM segment_spans)
        ORDER BY start_time_unix_nano ASC
      `).all(
        segment.physicalTraceId, segment.rootSpanId,
        segment.physicalTraceId, segment.rootSpanId,
        segment.physicalTraceId, segment.rootSpanId,
        segment.physicalTraceId,
        segment.physicalTraceId,
      )
    : db.prepare(`
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
    durationMs:        effectiveDurationMs(r['duration_ms'], r['attributes']),
    wallDurationMs:    Number(r['duration_ms']        ?? 0),
    statusCode:        Number(r['status_code']        ?? 0),
    statusMessage:     r['status_message'] != null ? String(r['status_message']) : null,
    attributes:        parseJson(r['attributes']),
    serviceName:       String(r['service_name']       ?? ''),
    raw:               parseJson(r['raw']),
  }));
}

export function parseTraceSegmentId(
  traceId: string,
): { physicalTraceId: string; rootSpanId: string } | null {
  const separator = traceId.indexOf(SEGMENT_SEPARATOR);
  if (separator < 0) { return null; }
  const physicalTraceId = traceId.slice(0, separator);
  const rootSpanId = traceId.slice(separator + 1);
  return physicalTraceId && rootSpanId ? { physicalTraceId, rootSpanId } : null;
}

function effectiveDurationMs(wallDuration: unknown, attributes: unknown): number {
  const attrs = parseJson(attributes);
  const busyNs = attrs['busy_ns'];
  return busyNs !== undefined && busyNs !== null
    ? Number(busyNs) / 1_000_000
    : Number(wallDuration ?? 0);
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
