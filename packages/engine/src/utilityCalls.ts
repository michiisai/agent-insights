import {
  isVisibleModel,
  type ModelVisibilityOptions,
  type QueryableDB,
  type UtilityCall,
  type UtilityModelStat,
  type UtilityCallsData,
} from '@agent-insights/types';
import { normalizeModelName } from './agentAnalytics';

/**
 * SQL fragment (used inside a `GROUP BY trace_id`) that resolves whether any
 * span in a trace carries a session/conversation id. A trace inherits its
 * session id from any span that carries one (some spans, e.g. `permission`,
 * never do). Utility calls have NONE of these keys.
 */
const TRACE_HAS_SESSION_ID = `(
  MAX(json_extract(attributes,'$."gen_ai.conversation.id"'))       IS NOT NULL OR
  MAX(json_extract(attributes,'$."session.id"'))                   IS NOT NULL OR
  MAX(json_extract(attributes,'$."copilot_chat.chat_session_id"')) IS NOT NULL
)`;

/**
 * Per-trace shape used to positively identify a utility / LM-API call. A trace
 * qualifies when it is a SINGLE span, that span is a root (parentless), it is
 * an LLM/embedding request (carries `gen_ai.request.model`), and it has NO
 * session/conversation id.
 *
 * Classifying by this positive structural signature — rather than merely
 * "copilot-chat" or "no session id" — ensures a real multi-span agent session
 * that is temporarily missing its id is never misclassified as a utility call.
 */
const UTILITY_TRACE_CTE = `
  trace_shape AS (
    SELECT
      trace_id,
      COUNT(*)                                                          AS span_count,
      SUM(CASE WHEN parent_span_id IS NULL OR parent_span_id = '' THEN 1 ELSE 0 END) AS root_count,
      MAX(CASE WHEN json_extract(attributes,'$."gen_ai.request.model"') IS NOT NULL THEN 1 ELSE 0 END) AS has_model,
      ${TRACE_HAS_SESSION_ID}                                          AS has_session_id
    FROM spans
    GROUP BY trace_id
  )`;

/** Predicate selecting only utility-shaped traces from `trace_shape`. */
const UTILITY_TRACE_FILTER = `
  span_count = 1 AND root_count = 1 AND has_model = 1 AND has_session_id = 0`;

/** A single standalone vscode.lm / LM-API "utility" call. */
export interface GetUtilityCallsOptions {
  /** Cap on the number of individual calls returned for drill-down. */
  limit?: number;
  /** Optional visibility filter for model/list consumers. */
  visibility?: ModelVisibilityOptions;
}

/**
 * Lists standalone vscode.lm / LM-API "utility" calls — title/summary
 * generation, embeddings and suggestions that are NOT agent turns and are
 * excluded from Sessions. Returns overall totals, a per-model
 * breakdown, and the individual calls (newest first) for drill-down.
 */
export function getUtilityCalls(db: QueryableDB, opts: GetUtilityCallsOptions = {}): UtilityCallsData {
  const { limit = 500, visibility } = opts;

  const rows = db.prepare(`
    WITH ${UTILITY_TRACE_CTE}
    SELECT
      s.trace_id,
      s.span_id,
      s.name,
      s.service_name,
      s.start_time_unix_nano,
      s.duration_ms,
      s.status_code,
      json_extract(s.attributes,'$."gen_ai.request.model"')                       AS model,
      CAST(json_extract(s.attributes,'$."gen_ai.usage.input_tokens"')  AS INTEGER) AS input_tokens,
      CAST(json_extract(s.attributes,'$."gen_ai.usage.output_tokens"') AS INTEGER) AS output_tokens
    FROM spans s
    JOIN trace_shape t ON s.trace_id = t.trace_id
    WHERE ${UTILITY_TRACE_FILTER}
    ORDER BY s.start_time_unix_nano DESC
    LIMIT ?
  `).all(limit);

  const calls: UtilityCall[] = rows
    .filter(r => isVisibleModel(normalizeModelName(String(r['model'] ?? 'unknown')), visibility))
    .map(r => {
      const inputTokens  = Number(r['input_tokens']  ?? 0);
      const outputTokens = Number(r['output_tokens'] ?? 0);
      return {
        traceId:           String(r['trace_id'] ?? ''),
        spanId:            String(r['span_id']  ?? ''),
        name:              String(r['name']     ?? ''),
        model:             String(r['model']    ?? 'unknown'),
        serviceName:       String(r['service_name'] ?? ''),
        startTimeUnixNano: String(r['start_time_unix_nano'] ?? '0'),
        durationMs:        Number(r['duration_ms'] ?? 0),
        inputTokens,
        outputTokens,
        totalTokens:       inputTokens + outputTokens,
        hasError:          Number(r['status_code'] ?? 0) === 2,
      };
    });

  // Per-model aggregate. Model ids are kept verbatim (e.g. the dated
  // "gpt-4o-mini-2024-07-18") — no version normalization, so distinct
  // deployed versions are not collapsed together.
  const byModelMap = new Map<string, UtilityModelStat & { _durSum: number }>();
  for (const c of calls) {
    let m = byModelMap.get(c.model);
    if (!m) {
      m = { model: c.model, callCount: 0, totalTokens: 0, avgDurationMs: 0, maxDurationMs: 0, errorCount: 0, _durSum: 0 };
      byModelMap.set(c.model, m);
    }
    m.callCount++;
    m.totalTokens += c.totalTokens;
    m._durSum += c.durationMs;
    m.maxDurationMs = Math.max(m.maxDurationMs, c.durationMs);
    if (c.hasError) { m.errorCount++; }
  }

  const byModel: UtilityModelStat[] = [...byModelMap.values()]
    .map(m => ({
      model:         m.model,
      callCount:     m.callCount,
      totalTokens:   m.totalTokens,
      avgDurationMs: round2(m.callCount ? m._durSum / m.callCount : 0),
      maxDurationMs: round2(m.maxDurationMs),
      errorCount:    m.errorCount,
    }))
    .sort((a, b) => b.callCount - a.callCount);

  const totalCalls  = calls.length;
  const totalTokens = calls.reduce((sum, c) => sum + c.totalTokens, 0);
  const durSum      = calls.reduce((sum, c) => sum + c.durationMs, 0);
  const errorCount  = calls.reduce((sum, c) => sum + (c.hasError ? 1 : 0), 0);

  return {
    totalCalls,
    totalTokens,
    avgDurationMs: round2(totalCalls ? durSum / totalCalls : 0),
    errorCount,
    byModel,
    calls,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
