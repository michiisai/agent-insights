import {
  isVisibleModel,
  type AgentAnalyticsData,
  type ModelVisibilityOptions,
  type QueryableDB,
} from '@agent-insights/types';
import { effectiveDurationMsSql } from './duration';
import { getTokenUsageRows } from './tokenRows';
import { toolCallErrorSql } from './toolCalls';

export function getAgentAnalytics(
  db: QueryableDB,
  sinceNano?: string,
  untilNano?: string,
  visibility?: ModelVisibilityOptions,
): AgentAnalyticsData {
  const spanParts: string[] = [];
  const spanParams: unknown[] = [];
  if (sinceNano) { spanParts.push('start_time_unix_nano >= ?'); spanParams.push(sinceNano); }
  if (untilNano) { spanParts.push('start_time_unix_nano <= ?'); spanParams.push(untilNano); }
  const spanWhere = spanParts.length ? `WHERE ${spanParts.join(' AND ')}` : '';

  const slowestOps = db.prepare(`
    SELECT
      name,
      AVG(${effectiveDurationMsSql()}) AS avg_duration_ms,
      MAX(${effectiveDurationMsSql()}) AS max_duration_ms,
      COUNT(*)         AS count,
      SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS error_count
    FROM spans
    ${spanWhere}
    GROUP BY name
    ORDER BY avg_duration_ms DESC
    LIMIT 25
  `).all(...spanParams);

  const tokenRows = getTokenUsageRows(db, { sinceNano, untilNano });

  const toolTimeClause = spanParams.length
    ? `${spanWhere}\n       AND (`
    : 'WHERE (';
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
    ${toolTimeClause}
        json_extract(attributes, '$."gen_ai.tool.name"') IS NOT NULL
        OR json_extract(attributes, '$."tool.name"')     IS NOT NULL
        OR json_extract(attributes, '$."tool_name"')     IS NOT NULL
        OR name LIKE 'tool.%'
        OR name LIKE 'tool:%'
      )
    GROUP BY tool_name
    ORDER BY count DESC
    LIMIT 25
  `).all(...spanParams);

  const visibleTokenRows = tokenRows.filter(row =>
    isVisibleModel(normalizeModelName(String(row['model'] ?? 'unknown')), visibility));

  const llmCalls       = visibleTokenRows.reduce((sum, r) => sum + Number(r['call_count']        ?? 0), 0);
  const toolCallsTotal = toolRows.reduce((sum, r)  => sum + Number(r['count']             ?? 0), 0);
  const inputTokens    = Math.round(visibleTokenRows.reduce((sum, r) => sum + Number(r['prompt_tokens']     ?? 0), 0));
  const outputTokens   = Math.round(visibleTokenRows.reduce((sum, r) => sum + Number(r['completion_tokens'] ?? 0), 0));
  const cachedTokens = Math.round(visibleTokenRows.reduce(
    (sum, row) => sum + Number(row['cached_tokens'] ?? 0), 0));
  const cacheCreationTokens = Math.round(visibleTokenRows.reduce(
    (sum, row) => sum + Number(row['cache_creation_tokens'] ?? 0), 0));
  const cacheHitRate = inputTokens > 0 ? cachedTokens / inputTokens : -1;

  const rootDurRows = db.prepare(`
    SELECT ${effectiveDurationMsSql()} AS duration_ms FROM spans
    ${spanWhere ? `${spanWhere} AND` : 'WHERE'} (parent_span_id IS NULL OR parent_span_id = '')
    ORDER BY duration_ms ASC
  `).all(...spanParams);
  const p95Ms = percentile(rootDurRows.map(r => Number(r['duration_ms'] ?? 0)), 0.95);

  const logParts: string[] = [];
  const logParams: unknown[] = [];
  if (sinceNano) { logParts.push('timestamp_unix_nano >= ?'); logParams.push(sinceNano); }
  if (untilNano) { logParts.push('timestamp_unix_nano <= ?'); logParams.push(untilNano); }
  const logWhere = logParts.length ? `WHERE ${logParts.join(' AND ')}` : '';

  const summaryParams: unknown[] = [...spanParams, ...spanParams, ...logParams, ...logParams, ...spanParams];
  const errorWhere = spanWhere ? `${spanWhere} AND status_code = 2` : `WHERE status_code = 2`;
  const summary = db.prepare(`
    SELECT
      (SELECT COUNT(*)                 FROM spans         ${spanWhere})  AS total_spans,
      (SELECT COUNT(DISTINCT trace_id) FROM spans         ${spanWhere})  AS total_traces,
      (SELECT COUNT(*)                 FROM logs          ${logWhere})   AS total_logs,
      (SELECT COUNT(*)                 FROM metric_points ${logWhere})   AS total_metric_points,
      (SELECT COUNT(DISTINCT trace_id) FROM spans         ${errorWhere}) AS error_traces
  `).get(...summaryParams);

  return {
    slowestOperations: slowestOps.map(r => ({
      name:          String(r['name']          ?? ''),
      avgDurationMs: round2(Number(r['avg_duration_ms'] ?? 0)),
      maxDurationMs: round2(Number(r['max_duration_ms'] ?? 0)),
      count:         Number(r['count']         ?? 0),
      errorCount:    Number(r['error_count']   ?? 0),
    })),

    tokenUsage: mergeTokenUsageByModel(visibleTokenRows),

    toolCalls: toolRows.map(r => ({
      toolName:        String(r['tool_name']        ?? ''),
      count:           Number(r['count']            ?? 0),
      avgDurationMs:   round2(Number(r['avg_duration_ms']   ?? 0)),
      totalDurationMs: round2(Number(r['total_duration_ms'] ?? 0)),
      errorCount:      Number(r['error_count']      ?? 0),
    })),

    summary: {
      totalSpans:        Number(summary?.['total_spans']         ?? 0),
      totalTraces:       Number(summary?.['total_traces']        ?? 0),
      totalLogs:         Number(summary?.['total_logs']          ?? 0),
      totalMetricPoints: Number(summary?.['total_metric_points'] ?? 0),
      llmCalls,
      toolCallsTotal,
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheCreationTokens,
      cacheHitRate,
      errorTraces:       Number(summary?.['error_traces']        ?? 0),
      p95Ms,
    },
  };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) { return 0; }
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

// Normalize provider-specific version separators and trailing variants.
export function normalizeModelName(model: string): string {
  return model
    .replace(/\s*\[[^\]]*\]\s*$/, '')
    .replace(/(\d)[.-](\d)/g, '$1.$2');
}

type TokenRow = Record<string, unknown>;

export function mergeTokenUsageByModel(rows: TokenRow[]): AgentAnalyticsData['tokenUsage'] {
  const merged = new Map<string, {
    model: string;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    callCount: number;
  }>();

  for (const r of rows) {
    const model = normalizeModelName(String(r['model'] ?? 'unknown'));
    const prompt     = Number(r['prompt_tokens']     ?? 0);
    const completion = Number(r['completion_tokens'] ?? 0);
    const cached     = Number(r['cached_tokens'] ?? 0);
    const creation   = Number(r['cache_creation_tokens'] ?? 0);
    const calls      = Number(r['call_count']        ?? 0);

    const existing = merged.get(model);
    if (existing) {
      existing.promptTokens     += prompt;
      existing.completionTokens += completion;
      existing.cachedTokens     += cached;
      existing.cacheCreationTokens += creation;
      existing.callCount        += calls;
    } else {
      merged.set(model, {
        model,
        promptTokens: prompt,
        completionTokens: completion,
        cachedTokens: cached,
        cacheCreationTokens: creation,
        callCount: calls,
      });
    }
  }

  return Array.from(merged.values())
    .map(m => ({
      model:            m.model,
      totalTokens:      Math.round(m.promptTokens + m.completionTokens),
      promptTokens:     Math.round(m.promptTokens),
      completionTokens: Math.round(m.completionTokens),
      cachedTokens:     Math.round(m.cachedTokens),
      cacheCreationTokens: Math.round(m.cacheCreationTokens),
      cacheHitRate: m.promptTokens > 0 ? m.cachedTokens / m.promptTokens : -1,
      callCount:        m.callCount,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}
