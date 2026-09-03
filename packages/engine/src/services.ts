import {
  isVisibleModel,
  type ModelVisibilityOptions,
  type QueryableDB,
} from '@agent-insights/types';
import { mergeTokenUsageByModel, normalizeModelName } from './agentAnalytics';
import { effectiveDurationMsSql } from './duration';
import { getTokenUsageRows } from './tokenRows';
import { toolCallErrorSql } from './toolCalls';

export interface ServiceOperationStat {
  name: string;
  avgDurationMs: number;
  maxDurationMs: number;
  count: number;
  errorCount: number;
}

export interface ServiceTokenUsage {
  model: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  cacheHitRate: number;
  callCount: number;
}

export interface ServiceToolCallStat {
  toolName: string;
  count: number;
  avgDurationMs: number;
  totalDurationMs: number;
  errorCount: number;
}

export interface ServiceSummary {
  serviceName: string;
  totalTraces: number;
  totalSpans: number;
  errorTraces: number;
  errorSpans: number;
  p50Ms: number;
  p95Ms: number;
  slowestOperations: ServiceOperationStat[];
  tokenUsage: ServiceTokenUsage[];
  toolCalls: ServiceToolCallStat[];
}

export function getServiceNames(db: QueryableDB): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT service_name FROM spans
    WHERE service_name IS NOT NULL AND service_name != ''
    ORDER BY service_name ASC
  `).all();
  return rows.map(r => String(r['service_name'] ?? ''));
}

export function getLogServiceNames(db: QueryableDB): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT service_name FROM logs
    WHERE service_name IS NOT NULL AND service_name != ''
    ORDER BY service_name ASC
  `).all();
  return rows.map(r => String(r['service_name'] ?? ''));
}

export function getServiceSummary(
  db: QueryableDB,
  serviceName: string,
  sinceNano?: string,
  untilNano?: string,
  visibility?: ModelVisibilityOptions,
): ServiceSummary | null {
  const exists = db.prepare(`
    SELECT 1 FROM spans WHERE service_name = ? LIMIT 1
  `).get(serviceName);
  if (!exists) { return null; }

  const timeParts: string[] = [];
  const timeParams: unknown[] = [];
  if (sinceNano) { timeParts.push('AND start_time_unix_nano >= ?'); timeParams.push(sinceNano); }
  if (untilNano) { timeParts.push('AND start_time_unix_nano <= ?'); timeParams.push(untilNano); }
  const timeAnd    = timeParts.join(' ');
  const baseParams = [serviceName, ...timeParams];

  const countRow = db.prepare(`
    SELECT
      COUNT(DISTINCT trace_id)                                       AS total_traces,
      COUNT(*)                                                       AS total_spans,
      COUNT(DISTINCT CASE WHEN status_code = 2 THEN trace_id END)   AS error_traces,
      SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END)             AS error_spans
    FROM spans
    WHERE service_name = ? ${timeAnd}
  `).get(...baseParams);

  const durationRows = db.prepare(`
    SELECT ${effectiveDurationMsSql()} AS duration_ms FROM spans
    WHERE service_name = ?
      AND (parent_span_id IS NULL OR parent_span_id = '')
      ${timeAnd}
    ORDER BY duration_ms ASC
  `).all(...baseParams);

  const durations = durationRows.map(r => Number(r['duration_ms'] ?? 0));
  const p50 = percentile(durations, 0.50);
  const p95 = percentile(durations, 0.95);

  const slowestRows = db.prepare(`
    SELECT
      name,
      AVG(${effectiveDurationMsSql()}) AS avg_duration_ms,
      MAX(${effectiveDurationMsSql()}) AS max_duration_ms,
      COUNT(*)         AS count,
      SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS error_count
    FROM spans
    WHERE service_name = ? ${timeAnd}
    GROUP BY name
    ORDER BY avg_duration_ms DESC
    LIMIT 15
  `).all(...baseParams);

  const tokenRows = getTokenUsageRows(db, { serviceName, sinceNano, untilNano });

  const toolRows = db.prepare(`
    SELECT
      COALESCE(
        json_extract(attributes, '$."gen_ai.tool.name"'),
        json_extract(attributes, '$."tool.name"'),
        json_extract(attributes, '$."tool_name"'),
        name
      ) AS tool_name,
      COUNT(*)         AS count,
      AVG(${effectiveDurationMsSql()}) AS avg_duration_ms,
      SUM(${effectiveDurationMsSql()}) AS total_duration_ms,
      SUM(CASE WHEN ${toolCallErrorSql('spans.')} THEN 1 ELSE 0 END) AS error_count
    FROM spans
    WHERE service_name = ? ${timeAnd}
      AND (
        json_extract(attributes, '$."gen_ai.tool.name"') IS NOT NULL
        OR json_extract(attributes, '$."tool.name"')     IS NOT NULL
        OR json_extract(attributes, '$."tool_name"')     IS NOT NULL
        OR name LIKE 'tool.%'
        OR name LIKE 'tool:%'
      )
    GROUP BY tool_name
    ORDER BY count DESC
    LIMIT 25
  `).all(...baseParams);

  return {
    serviceName,
    totalTraces:  Number(countRow?.['total_traces']  ?? 0),
    totalSpans:   Number(countRow?.['total_spans']   ?? 0),
    errorTraces:  Number(countRow?.['error_traces']  ?? 0),
    errorSpans:   Number(countRow?.['error_spans']   ?? 0),
    p50Ms: p50,
    p95Ms: p95,
    slowestOperations: slowestRows.map(r => ({
      name:          String(r['name']          ?? ''),
      avgDurationMs: round2(Number(r['avg_duration_ms'] ?? 0)),
      maxDurationMs: round2(Number(r['max_duration_ms'] ?? 0)),
      count:         Number(r['count']         ?? 0),
      errorCount:    Number(r['error_count']   ?? 0),
    })),
    tokenUsage: mergeTokenUsageByModel(tokenRows.filter(row =>
      isVisibleModel(normalizeModelName(String(row['model'] ?? 'unknown')), visibility))),
    toolCalls: toolRows.map(r => ({
      toolName:        String(r['tool_name']        ?? ''),
      count:           Number(r['count']            ?? 0),
      avgDurationMs:   round2(Number(r['avg_duration_ms']   ?? 0)),
      totalDurationMs: round2(Number(r['total_duration_ms'] ?? 0)),
      errorCount:      Number(r['error_count']      ?? 0),
    })),
  };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) { return 0; }
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
