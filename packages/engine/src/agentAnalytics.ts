import type { QueryableDB, AgentAnalyticsData } from '@agent-insights/types';
import { effectiveDurationMsSql } from './duration';

// IMPORTANT: OTel attributes are stored as a flat JSON object with dotted keys,
// e.g. {"gen_ai.request.model": "gpt-4o"}.
// SQLite's json_extract treats unquoted dots as nested-object path separators, so
// every dotted key MUST be quoted inside the path string:
//   CORRECT:  json_extract(attributes, '$."gen_ai.request.model"')
//   WRONG:    json_extract(attributes, '$.gen_ai.request.model')  ← always returns NULL

export function getAgentAnalytics(db: QueryableDB, sinceNano?: string, untilNano?: string): AgentAnalyticsData {
  const spanParts: string[] = [];
  const spanParams: unknown[] = [];
  if (sinceNano) { spanParts.push('start_time_unix_nano >= ?'); spanParams.push(sinceNano); }
  if (untilNano) { spanParts.push('start_time_unix_nano <= ?'); spanParams.push(untilNano); }
  const spanWhere = spanParts.length ? `WHERE ${spanParts.join(' AND ')}` : '';

  // Slowest operations aggregated by span name
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

  // Token usage — supports both OTel GenAI semconv and common llm.* conventions
  const tokenTimeClause = spanParams.length
    ? `${spanWhere}\n       AND (`
    : 'WHERE (';
  const tokenRows = db.prepare(`
    SELECT
      COALESCE(
        json_extract(attributes, '$."gen_ai.request.model"'),
        json_extract(attributes, '$."llm.model"'),
        'unknown'
      ) AS model,
      SUM(COALESCE(
        CAST(json_extract(attributes, '$."gen_ai.usage.input_tokens"')   AS REAL),
        CAST(json_extract(attributes, '$."llm.usage.prompt_tokens"')     AS REAL),
        CAST(json_extract(attributes, '$."input_tokens"')                AS REAL),
        0
      )) AS prompt_tokens,
      SUM(COALESCE(
        CAST(json_extract(attributes, '$."gen_ai.usage.output_tokens"')      AS REAL),
        CAST(json_extract(attributes, '$."llm.usage.completion_tokens"')     AS REAL),
        CAST(json_extract(attributes, '$."output_tokens"')                   AS REAL),
        0
      )) AS completion_tokens,
      COUNT(*) AS call_count
    FROM spans
    ${tokenTimeClause}
        json_extract(attributes, '$."gen_ai.request.model"') IS NOT NULL
        OR json_extract(attributes, '$."llm.model"')         IS NOT NULL
      )
    GROUP BY model
    ORDER BY (prompt_tokens + completion_tokens) DESC
  `).all(...spanParams);

  // Tool calls — spans tagged with gen_ai.tool.name or tool.name
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
      SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS error_count
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

  // Derive aggregate stats from already-fetched rows
  const llmCalls       = tokenRows.reduce((sum, r) => sum + Number(r['call_count']        ?? 0), 0);
  const toolCallsTotal = toolRows.reduce((sum, r)  => sum + Number(r['count']             ?? 0), 0);
  const inputTokens    = Math.round(tokenRows.reduce((sum, r) => sum + Number(r['prompt_tokens']     ?? 0), 0));
  const outputTokens   = Math.round(tokenRows.reduce((sum, r) => sum + Number(r['completion_tokens'] ?? 0), 0));

  // Cache read tokens only (tokens served from cache = "cache hit").
  // cache_creation tokens are NOT included — they are a write cost, not a hit.
  const cachedAndClause = spanWhere ? `${spanWhere} AND` : 'WHERE';
  const cachedRow = db.prepare(`
    SELECT
      SUM(COALESCE(
        CAST(json_extract(attributes, '$."gen_ai.usage.cache_read.input_tokens"') AS REAL),
        CAST(json_extract(attributes, '$."gen_ai.usage.cache_read_input_tokens"') AS REAL),
        CAST(json_extract(attributes, '$."gen_ai.usage.cached_tokens"')           AS REAL),
        CAST(json_extract(attributes, '$."llm.usage.cache_read_input_tokens"')    AS REAL),
        CAST(json_extract(attributes, '$."llm.usage.cached_tokens"')              AS REAL),
        CAST(json_extract(attributes, '$."cache_read_tokens"')                    AS REAL),
        0
      )) AS cached_tokens
    FROM spans
    ${cachedAndClause} (
      json_extract(attributes, '$."gen_ai.usage.cache_read.input_tokens"') IS NOT NULL
      OR json_extract(attributes, '$."gen_ai.usage.cache_read_input_tokens"') IS NOT NULL
      OR json_extract(attributes, '$."gen_ai.usage.cached_tokens"')           IS NOT NULL
      OR json_extract(attributes, '$."llm.usage.cache_read_input_tokens"')    IS NOT NULL
      OR json_extract(attributes, '$."llm.usage.cached_tokens"')              IS NOT NULL
      OR json_extract(attributes, '$."cache_read_tokens"')                    IS NOT NULL
    )
  `).get(...spanParams);
  const cachedTokens = Math.round(Number(cachedRow?.['cached_tokens'] ?? 0));

  // Cache creation (write) tokens — the cost of populating the cache. Tracked
  // separately from cache hits because it is an input write cost, not a hit.
  const cacheCreationRow = db.prepare(`
    SELECT
      SUM(COALESCE(
        CAST(json_extract(attributes, '$."gen_ai.usage.cache_creation.input_tokens"') AS REAL),
        CAST(json_extract(attributes, '$."gen_ai.usage.cache_creation_input_tokens"') AS REAL),
        CAST(json_extract(attributes, '$."llm.usage.cache_creation_input_tokens"')    AS REAL),
        CAST(json_extract(attributes, '$."cache_creation_tokens"')                    AS REAL),
        0
      )) AS cache_creation_tokens
    FROM spans
    ${cachedAndClause} (
      json_extract(attributes, '$."gen_ai.usage.cache_creation.input_tokens"') IS NOT NULL
      OR json_extract(attributes, '$."gen_ai.usage.cache_creation_input_tokens"') IS NOT NULL
      OR json_extract(attributes, '$."llm.usage.cache_creation_input_tokens"')    IS NOT NULL
      OR json_extract(attributes, '$."cache_creation_tokens"')                    IS NOT NULL
    )
  `).get(...spanParams);
  const cacheCreationTokens = Math.round(Number(cacheCreationRow?.['cache_creation_tokens'] ?? 0));

  // Convention-aware cache-hit rate. Two accounting models coexist:
  //   - Standard/OTel semconv (e.g. Copilot): input_tokens is the TOTAL prompt and
  //     cache_read is a subset of it → denominator = input_tokens.
  //   - Claude Code/Anthropic: input_tokens counts only fresh (uncached) tokens and
  //     cache_read/cache_creation are additive → denominator = input + read + creation.
  // Anthropic-style spans are detected by the bare cache_read_tokens / cache_creation_tokens keys.
  const rateWhere = spanWhere ? `${spanWhere} AND` : 'WHERE';
  const hitRateRow = db.prepare(`
    SELECT
      SUM(read_tok) AS read_total,
      SUM(CASE WHEN is_additive THEN input_tok + read_tok + creation_tok ELSE input_tok END) AS prompt_total
    FROM (
      SELECT
        COALESCE(
          CAST(json_extract(attributes, '$."gen_ai.usage.input_tokens"') AS REAL),
          CAST(json_extract(attributes, '$."llm.usage.prompt_tokens"')   AS REAL),
          CAST(json_extract(attributes, '$."input_tokens"')              AS REAL),
          0
        ) AS input_tok,
        COALESCE(
          CAST(json_extract(attributes, '$."gen_ai.usage.cache_read.input_tokens"') AS REAL),
          CAST(json_extract(attributes, '$."gen_ai.usage.cache_read_input_tokens"') AS REAL),
          CAST(json_extract(attributes, '$."gen_ai.usage.cached_tokens"')           AS REAL),
          CAST(json_extract(attributes, '$."llm.usage.cache_read_input_tokens"')    AS REAL),
          CAST(json_extract(attributes, '$."llm.usage.cached_tokens"')              AS REAL),
          CAST(json_extract(attributes, '$."cache_read_tokens"')                    AS REAL),
          0
        ) AS read_tok,
        COALESCE(
          CAST(json_extract(attributes, '$."gen_ai.usage.cache_creation.input_tokens"') AS REAL),
          CAST(json_extract(attributes, '$."gen_ai.usage.cache_creation_input_tokens"') AS REAL),
          CAST(json_extract(attributes, '$."llm.usage.cache_creation_input_tokens"')    AS REAL),
          CAST(json_extract(attributes, '$."cache_creation_tokens"')                    AS REAL),
          0
        ) AS creation_tok,
        (
          json_extract(attributes, '$."cache_read_tokens"')     IS NOT NULL
          OR json_extract(attributes, '$."cache_creation_tokens"') IS NOT NULL
        ) AS is_additive
      FROM spans
      ${rateWhere} (
        json_extract(attributes, '$."gen_ai.request.model"') IS NOT NULL
        OR json_extract(attributes, '$."llm.model"')         IS NOT NULL
      )
    )
  `).get(...spanParams);
  const cacheReadTotal   = Number(hitRateRow?.['read_total']   ?? 0);
  const cachePromptTotal = Number(hitRateRow?.['prompt_total'] ?? 0);
  const cacheHitRate = cachePromptTotal > 0 ? cacheReadTotal / cachePromptTotal : -1;

  // P95 latency from root spans only
  const rootDurRows = db.prepare(`
    SELECT ${effectiveDurationMsSql()} AS duration_ms FROM spans
    ${spanWhere ? `${spanWhere} AND` : 'WHERE'} (parent_span_id IS NULL OR parent_span_id = '')
    ORDER BY duration_ms ASC
  `).all(...spanParams);
  const p95Ms = percentile(rootDurRows.map(r => Number(r['duration_ms'] ?? 0)), 0.95);

  // Counts for spans use start_time_unix_nano; logs/metrics use timestamp_unix_nano
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

    tokenUsage: mergeTokenUsageByModel(tokenRows),

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

// Different agents report the same model with different version separators, e.g.
// Copilot emits "claude-opus-4.8" while Claude Code emits "claude-opus-4-8".

// Trailing beta/variant tags such as Claude Code's "[1m]" (1M-token context window)
// are stripped so tagged and untagged calls to the same model aggregate together.
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
    callCount: number;
  }>();

  for (const r of rows) {
    const model = normalizeModelName(String(r['model'] ?? 'unknown'));
    const prompt     = Number(r['prompt_tokens']     ?? 0);
    const completion = Number(r['completion_tokens'] ?? 0);
    const calls      = Number(r['call_count']        ?? 0);

    const existing = merged.get(model);
    if (existing) {
      existing.promptTokens     += prompt;
      existing.completionTokens += completion;
      existing.callCount        += calls;
    } else {
      merged.set(model, { model, promptTokens: prompt, completionTokens: completion, callCount: calls });
    }
  }

  return Array.from(merged.values())
    .map(m => ({
      model:            m.model,
      totalTokens:      Math.round(m.promptTokens + m.completionTokens),
      promptTokens:     Math.round(m.promptTokens),
      completionTokens: Math.round(m.completionTokens),
      callCount:        m.callCount,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}
