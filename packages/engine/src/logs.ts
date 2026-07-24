import type { QueryableDB, LogRecord } from '@agent-insights/types';

export interface LogQueryOptions {
  filter?: string;
  excludes?: string[];
  minSeverity?: number;
  limit?: number;
  sinceNano?: string;
  untilNano?: string;
  serviceName?: string;
  sortOrder?: 'desc' | 'asc';
}

export function getLogs(db: QueryableDB, opts: LogQueryOptions = {}): LogRecord[] {
  const { filter = '', excludes = [], minSeverity = 0, limit = 500, sinceNano, untilNano, serviceName, sortOrder = 'desc' } = opts;

  // severity_number 0 = UNSPECIFIED (often emitted as "TRACE" by SDKs).
  // Treat minSeverity 1 (Trace+) identically to 0 so those logs are included.
  const effectiveMin = minSeverity <= 1 ? 0 : minSeverity;
  const conditions: string[] = ['severity_number >= ?'];
  const params: unknown[]   = [effectiveMin];

  if (sinceNano)    { conditions.push('timestamp_unix_nano >= ?'); params.push(sinceNano); }
  if (untilNano)    { conditions.push('timestamp_unix_nano <= ?'); params.push(untilNano); }
  if (serviceName)  { conditions.push('service_name = ?');         params.push(serviceName); }

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

  const rows = db.prepare(`
    SELECT * FROM logs
    WHERE ${conditions.join(' AND ')}
    ORDER BY timestamp_unix_nano ${sortOrder === 'asc' ? 'ASC' : 'DESC'}, id ${sortOrder === 'asc' ? 'ASC' : 'DESC'}
    LIMIT ?
  `).all(...params, limit);

  return rows.map(r => ({
    id:                Number(r['id']                 ?? 0),
    timestampUnixNano: String(r['timestamp_unix_nano'] ?? '0'),
    severityNumber:    Number(r['severity_number']    ?? 0),
    severityText:      String(r['severity_text']      ?? ''),
    body:              String(r['body']               ?? ''),
    attributes:        parseJson(r['attributes']),
    traceId:           r['trace_id'] != null ? String(r['trace_id']) : null,
    spanId:            r['span_id']  != null ? String(r['span_id'])  : null,
    serviceName:       String(r['service_name']       ?? ''),
    raw:               parseJson(r['raw']),
  }));
}

function parseJson(v: unknown): Record<string, unknown> {
  try { return JSON.parse(String(v ?? '{}')) as Record<string, unknown>; } catch { return {}; }
}
