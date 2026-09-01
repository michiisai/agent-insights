import type { QueryableDB, LogRecord } from '@agent-insights/types';
import { hostSpanSql } from '@agent-insights/receiver';
import { SESSION_TRACE_IDS_SQL } from './sessions';

const HOST_SESSION_SPAN = 'vscode.agent_host.session';

export interface LogQueryOptions {
  filter?: string;
  excludes?: string[];
  minSeverity?: number;
  limit?: number;
  sinceNano?: string;
  untilNano?: string;
  serviceName?: string;
  /** Restrict to logs whose trace belongs to this resolved agent session. */
  sessionId?: string;
  sortOrder?: 'desc' | 'asc';
}

export function getLogs(db: QueryableDB, opts: LogQueryOptions = {}): LogRecord[] {
  const { filter = '', excludes = [], minSeverity = 0, limit = 500, sinceNano, untilNano, serviceName, sessionId, sortOrder = 'desc' } = opts;

  // severity_number 0 = UNSPECIFIED (often emitted as "TRACE" by SDKs).
  // Treat minSeverity 1 (Trace+) identically to 0 so those logs are included.
  const effectiveMin = minSeverity <= 1 ? 0 : minSeverity;
  const conditions: string[] = ['severity_number >= ?'];
  const params: unknown[]   = [effectiveMin];

  if (sinceNano)    { conditions.push('timestamp_unix_nano >= ?'); params.push(sinceNano); }
  if (untilNano)    { conditions.push('timestamp_unix_nano <= ?'); params.push(untilNano); }
  if (serviceName)  { conditions.push('service_name = ?');         params.push(serviceName); }
  if (sessionId) {
    conditions.push(`trace_id IN (${SESSION_TRACE_IDS_SQL})`);
    params.push(sessionId, sessionId);
  }

  if (filter.trim()) {
    conditions.push('(body LIKE ? OR service_name LIKE ? OR severity_text LIKE ? OR attributes LIKE ? OR trace_id LIKE ? OR span_id LIKE ?)');
    const like = `%${filter.trim()}%`;
    params.push(like, like, like, like, like, like);
  }

  for (const excl of excludes) {
    if (excl.trim()) {
      conditions.push('(body NOT LIKE ? AND service_name NOT LIKE ? AND severity_text NOT LIKE ? AND attributes NOT LIKE ?)');
      const like = `%${excl.trim()}%`;
      params.push(like, like, like, like);
    }
  }

  const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
  const rows = db.prepare(`
    WITH RECURSIVE
    filtered_logs AS MATERIALIZED (
      SELECT * FROM logs
      WHERE ${conditions.join(' AND ')}
      ORDER BY timestamp_unix_nano ${direction}, id ${direction}
      LIMIT ?
    ),
    log_ancestors(log_id, trace_id, span_id, parent_span_id, depth) AS (
      SELECT l.id, s.trace_id, s.span_id, s.parent_span_id, 0
        FROM filtered_logs l
        JOIN spans s ON s.trace_id = l.trace_id AND s.span_id = l.span_id
      UNION ALL
      SELECT a.log_id, p.trace_id, p.span_id, p.parent_span_id, a.depth + 1
        FROM log_ancestors a
        JOIN spans p ON p.trace_id = a.trace_id AND p.span_id = a.parent_span_id
       WHERE a.depth < 64
    ),
    segment_candidates(log_id, root_span_id, priority, depth) AS (
      SELECT a.log_id, a.span_id, 0, a.depth
        FROM log_ancestors a
        JOIN spans host
          ON host.trace_id = a.trace_id AND host.span_id = a.parent_span_id
       WHERE ${hostSpanSql('host.')}
      UNION ALL
      SELECT a.log_id, a.parent_span_id, 1, a.depth
        FROM log_ancestors a
       WHERE a.parent_span_id IS NOT NULL AND a.parent_span_id != ''
         AND NOT EXISTS (
           SELECT 1 FROM spans parent
            WHERE parent.trace_id = a.trace_id AND parent.span_id = a.parent_span_id
         )
         AND EXISTS (
           SELECT 1 FROM spans host_root
            WHERE host_root.trace_id = a.trace_id
              AND host_root.name = '${HOST_SESSION_SPAN}'
              AND (host_root.parent_span_id IS NULL OR host_root.parent_span_id = '')
         )
    ),
    segment_targets AS (
      SELECT log_id, root_span_id,
             ROW_NUMBER() OVER (
               PARTITION BY log_id ORDER BY priority, depth
             ) AS rn
        FROM segment_candidates
    )
    SELECT l.*, segment.root_span_id
      FROM filtered_logs l
      LEFT JOIN segment_targets segment
        ON segment.log_id = l.id AND segment.rn = 1
     ORDER BY l.timestamp_unix_nano ${direction}, l.id ${direction}
  `).all(...params, limit);

  return rows.map(r => {
    const traceId = r['trace_id'] != null ? String(r['trace_id']) : null;
    const rootSpanId = r['root_span_id'] != null ? String(r['root_span_id']) : null;
    return {
      id:                Number(r['id']                 ?? 0),
      timestampUnixNano: String(r['timestamp_unix_nano'] ?? '0'),
      severityNumber:    Number(r['severity_number']    ?? 0),
      severityText:      String(r['severity_text']      ?? ''),
      body:              String(r['body']               ?? ''),
      attributes:        parseJson(r['attributes']),
      traceId,
      spanId:            r['span_id'] != null ? String(r['span_id']) : null,
      targetTraceId:     traceId && rootSpanId ? `${traceId}:${rootSpanId}` : traceId,
      serviceName:       String(r['service_name']       ?? ''),
      raw:               parseJson(r['raw']),
    };
  });
}

function parseJson(v: unknown): Record<string, unknown> {
  try { return JSON.parse(String(v ?? '{}')) as Record<string, unknown>; } catch { return {}; }
}
