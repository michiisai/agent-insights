import type { QueryableDB, Session, SessionFailure, SessionMessages, SessionMessageTurn } from '@agent-insights/types';

/** One trace within a session — a single agent turn / request. */
export interface SessionTurn {
  traceId: string;
  /** Root span name of the trace (best-effort; empty if no root span found). */
  rootName: string;
  startTimeUnixNano: string;
  durationMs: number;
  spanCount: number;
  llmRequestCount: number;
  toolCallCount: number;
  totalTokens: number;
  hasError: boolean;
  /** Errored spans in this trace. */
  errorCount: number;
  failureReason: string | null;
  /** Every distinct failure in this trace, oldest first. */
  failures: SessionFailure[];
}

/** Aggregate usage for one tool across a session. */
export interface SessionToolStat {
  toolName: string;
  count: number;
  errorCount: number;
}

/** Token usage for one model across a session. */
export interface SessionModelTokens {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  callCount: number;
}

/** One errored span surfaced for a session's failure narrative. */
export interface SessionErrorDetail {
  /** Trace (turn) the errored span belongs to. */
  traceId: string;
  spanName: string;
  statusMessage: string | null;
  exceptionType: string | null;
  exceptionMessage: string | null;
}

/**
 * A single session's full breakdown — extends the Session row with a
 * turn-by-turn timeline, per-tool and per-model rollups, and error details.
 * Powers a narratable "what happened / outcome / key stats" summary.
 */
export interface SessionSummary extends Session {
  inputTokens: number;
  outputTokens: number;
  turns: SessionTurn[];
  toolStats: SessionToolStat[];
  modelTokens: SessionModelTokens[];
  errors: SessionErrorDetail[];
}

/**
 * Standalone metadata span the agent host emits whenever a session's title
 * changes. Carries `gen_ai.conversation.id` plus the title, on its own
 * synthetic trace id. Requires `chat.agentHost.otel.captureContent`, and older
 * VS Code builds never emit it, so titles are always optional.
 */
export { SESSION_TITLE_SPAN_NAME } from '@agent-insights/receiver';
import { SESSION_TITLE_SPAN_NAME } from '@agent-insights/receiver';

/**
 * SQL expression that resolves a session id for a group of spans sharing a
 * trace_id. The id lives on some spans (e.g. `chat`) but not others (e.g.
 * `permission`, `execute_tool`), so it must be resolved at the trace level —
 * a trace inherits its session id from any span that carries one. Falls back
 * to trace_id (a safety net that does not fire for real agent traces, which
 * always carry a conversation/session id somewhere in the trace).
 *
 * MUST be used inside a `GROUP BY trace_id` context (it uses MAX aggregates).
 */
export const SESSION_ID_EXPR = `COALESCE(
  MAX(json_extract(attributes,'$."gen_ai.conversation.id"')),
  MAX(json_extract(attributes,'$."session.id"')),
  MAX(json_extract(attributes,'$."copilot_chat.chat_session_id"')),
  trace_id
)`;

/**
 * Sessions exclude copilot-chat: those spans are plain vscode LM API / utility
 * calls (title & summary generation, embeddings) with no conversation key —
 * they are surfaced separately (Home), not as agent sessions.
 *
 * Session-title spans are excluded too: they are zero-duration metadata the
 * agent host emits alongside the session, so counting them would inflate every
 * session's trace and span totals with non-agent activity.
 */
export const SESSION_TRACE_FILTER =
  `service_name != 'copilot-chat' AND name != '${SESSION_TITLE_SPAN_NAME}'`;

/** Default `service.name` of the agent host itself (user-overridable). */
export const AGENT_HOST_SERVICE_NAME = 'vscode-agent-host';

/**
 * Spans the agent host emits *on a provider's trace* rather than the provider
 * itself (microsoft/vscode#328529): the `vscode.agent_host.session` anchor that
 * hands W3C parent context to Copilot/Claude/Codex, plus session metadata.
 *
 * They are not agent activity, so they must not be counted or reported as the
 * session's service — but they DO carry `gen_ai.conversation.id`, which is how
 * a provider trace that never labels itself still resolves to a session. So
 * they stay inside SESSION_TRACE_FILTER's grouping and are subtracted at the
 * point of measurement instead.
 *
 * The host service name is user-overridable, hence the span-namespace arm.
 */
const hostSpan = (alias = '') =>
  `(${alias}service_name = '${AGENT_HOST_SERVICE_NAME}' OR ${alias}name LIKE 'vscode.agent_host.%')`;
const HOST_SPAN = hostSpan();

/** Spans in a trace that the agent actually produced. */
const AGENT_SPAN_COUNT = `SUM(CASE WHEN ${HOST_SPAN} THEN 0 ELSE 1 END)`;

/**
 * The provider that ran the turn, ignoring host spans sharing its trace.
 * `vscode-agent-host` sorts after `claude-code`, `codex-app-server` and
 * `github-copilot`, so a plain MAX(service_name) would relabel every native
 * session as the host. NULL when a trace carries host spans only.
 */
const AGENT_SERVICE_NAME = `MAX(CASE WHEN ${HOST_SPAN} THEN NULL ELSE service_name END)`;

/** Trace ids belonging to a resolved session. Bind the session id twice. */
export const SESSION_TRACE_IDS_SQL = `
  SELECT trace_id FROM spans
  WHERE ${SESSION_TRACE_FILTER}
  GROUP BY trace_id
  HAVING ${SESSION_ID_EXPR} = ?
  UNION
  SELECT trace_id FROM spans
  WHERE name = '${SESSION_TITLE_SPAN_NAME}'
    AND json_extract(attributes,'$."gen_ai.conversation.id"') = ?
`;

/** Resolve the session containing a trace, including synthetic title metadata traces. */
export function getSessionIdForTrace(db: QueryableDB, traceId: string): string | null {
  const id = traceId?.trim();
  if (!id) { return null; }

  const row = db.prepare(`
    SELECT ${SESSION_ID_EXPR} AS session_id
      FROM spans
     WHERE trace_id = ?
        AND (service_name != 'copilot-chat' OR name = '${SESSION_TITLE_SPAN_NAME}')
     GROUP BY trace_id
  `).get(id);
  return row?.['session_id'] != null ? String(row['session_id']) : null;
}

/** Span-name predicate: an LLM request/chat turn. */
const LLM_PREDICATE  = `(name LIKE 'chat %' OR name = 'chat' OR name LIKE '%llm_request%')`;
/** Span-name predicate: a single tool execution (avoids double-counting claude's tool wrapper spans). */
const TOOL_PREDICATE = `(name LIKE 'execute_tool%' OR name LIKE '%tool.execution%')`;

/**
 * Prompt/completion token attributes, in priority order. Emitters disagree on
 * the key: the Copilot agent host uses the OTel GenAI semconv
 * (`gen_ai.usage.*`), other instrumentations use `llm.usage.*`, and Claude Code
 * puts bare `input_tokens` / `output_tokens` on its `claude_code.llm_request`
 * spans. Mirrors the fallback chain used by metrics.ts so sessions and the Home
 * totals agree. Cache read/creation tokens are deliberately excluded — they are
 * tracked separately (and are additive, not a subset, for Anthropic).
 */
const INPUT_TOKENS_EXPR = `COALESCE(
  CAST(json_extract(attributes,'$."gen_ai.usage.input_tokens"') AS INTEGER),
  CAST(json_extract(attributes,'$."llm.usage.prompt_tokens"')   AS INTEGER),
  CAST(json_extract(attributes,'$."input_tokens"')              AS INTEGER),
  0
)`;
const OUTPUT_TOKENS_EXPR = `COALESCE(
  CAST(json_extract(attributes,'$."gen_ai.usage.output_tokens"')   AS INTEGER),
  CAST(json_extract(attributes,'$."llm.usage.completion_tokens"')  AS INTEGER),
  CAST(json_extract(attributes,'$."output_tokens"')                AS INTEGER),
  0
)`;

/** Token attributes summed for the session token total. */
const TOKENS_EXPR = `(${INPUT_TOKENS_EXPR} + ${OUTPUT_TOKENS_EXPR})`;

/** Model attribute for a token-bearing span, across emitter conventions. */
const MODEL_EXPR = `COALESCE(
  json_extract(attributes,'$."gen_ai.request.model"'),
  json_extract(attributes,'$."llm.model"'),
  json_extract(attributes,'$."model"')
)`;

export interface GetSessionsOptions {
  limit?: number;
  errorsOnly?: boolean;
  nameSearch?: string;
  sortOrder?: 'desc' | 'asc';
}

/** Error text for a failed span: status message, falling back to the exception message. */
const FAILURE_MESSAGE_EXPR = `COALESCE(s.status_message, json_extract(s.attributes,'$."exception.message"'))`;

/** Upper bound on distinct failures reported per session (keeps payloads sane). */
const MAX_SESSION_FAILURES = 50;

/**
 * Loads every distinct failure (errored span name + message, with an occurrence
 * count) for the given sessions, oldest first. A session spans many traces and
 * each trace can fail more than once, so failures are collected across the whole
 * session rather than reduced to a single representative message.
 */
function loadSessionFailures(db: QueryableDB, sessionIds: string[]): Map<string, SessionFailure[]> {
  const bySession = new Map<string, SessionFailure[]>();
  if (!sessionIds.length) { return bySession; }

  const ph = sessionIds.map(() => '?').join(',');
  const rows = db.prepare(`
    WITH trace_session AS (
      SELECT trace_id, ${SESSION_ID_EXPR} AS session_id
      FROM spans
      WHERE ${SESSION_TRACE_FILTER}
      GROUP BY trace_id
    )
    SELECT
      ts.session_id                    AS session_id,
      s.trace_id                       AS trace_id,
      s.name                           AS span_name,
      ${FAILURE_MESSAGE_EXPR}          AS message,
      COUNT(*)                         AS cnt,
      MIN(s.start_time_unix_nano)      AS first_start
    FROM spans s
    JOIN trace_session ts ON ts.trace_id = s.trace_id
    WHERE s.status_code = 2 AND ts.session_id IN (${ph})
    GROUP BY ts.session_id, s.trace_id, s.name, message
    ORDER BY first_start ASC
  `).all(...sessionIds);

  for (const r of rows) {
    const sid  = String(r['session_id'] ?? '');
    const list = bySession.get(sid) ?? [];
    if (list.length >= MAX_SESSION_FAILURES) { continue; }
    list.push({
      traceId:  String(r['trace_id'] ?? ''),
      spanName: String(r['span_name'] ?? ''),
      message:  r['message'] != null ? String(r['message']) : null,
      count:    Number(r['cnt'] ?? 0),
    });
    bySession.set(sid, list);
  }
  return bySession;
}

/**
 * Best-effort label per session id: the reported title from `session_titles`,
 * falling back to the session's opening user prompt. Sessions with neither
 * (content capture off) are absent from the map.
 */
function loadSessionTitles(db: QueryableDB, sessionIds: string[]): Map<string, string> {
  const titles = new Map<string, string>();
  if (!sessionIds.length) { return titles; }

  const ph = sessionIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT session_id, title FROM session_titles WHERE session_id IN (${ph})`,
  ).all(...sessionIds);

  for (const r of rows) {
    const sid   = String(r['session_id'] ?? '');
    const title = r['title'] != null ? String(r['title']).trim() : '';
    if (sid && title) { titles.set(sid, title); }
  }

  const untitled = sessionIds.filter(id => id && !titles.has(id));
  for (const [sid, prompt] of loadOpeningPrompts(db, untitled)) {
    titles.set(sid, prompt);
  }
  return titles;
}

/** Opening user prompt per session, from the earliest LLM span that captured
 *  input messages. */
function loadOpeningPrompts(db: QueryableDB, sessionIds: string[]): Map<string, string> {
  const prompts = new Map<string, string>();
  if (!sessionIds.length) { return prompts; }

  const ph = sessionIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT session_id, input_messages FROM (
      SELECT
        ts.session_id AS session_id,
        json_extract(s.attributes,'$."gen_ai.input.messages"') AS input_messages,
        ROW_NUMBER() OVER (
          PARTITION BY ts.session_id
          ORDER BY CAST(s.start_time_unix_nano AS INTEGER) ASC
        ) AS rn
      FROM spans s
      JOIN (
        SELECT trace_id, ${SESSION_ID_EXPR} AS session_id
        FROM spans
        WHERE ${SESSION_TRACE_FILTER}
        GROUP BY trace_id
      ) ts ON ts.trace_id = s.trace_id
      WHERE ts.session_id IN (${ph})
        AND ${LLM_PREDICATE}
        AND json_extract(s.attributes,'$."gen_ai.input.messages"') IS NOT NULL
    ) WHERE rn = 1
  `).all(...sessionIds);

  for (const r of rows) {
    const sid    = String(r['session_id'] ?? '');
    const prompt = firstUserPrompt(r['input_messages']);
    if (sid && prompt) { prompts.set(sid, prompt); }
  }
  return prompts;
}

/**
 * Lists agent sessions — conversations grouping multiple traces — newest first.
 * Each row aggregates the session's traces/spans, LLM-request and tool-call
 * counts, distinct models, token total, and failure state.
 */
export function getSessions(db: QueryableDB, opts: GetSessionsOptions = {}): Session[] {
  const { limit = 500, errorsOnly, nameSearch, sortOrder = 'desc' } = opts;

  const params: unknown[] = [];

  // Per-trace search: match a session if any of its traces matches the term
  // (trace id, span name, span id, or attribute values). Titles are not
  // reachable that way — title spans sit on a trace id SESSION_TRACE_FILTER
  // excludes — so matching sessions are resolved separately.
  let searchClause = '';
  let titleSessionIds: string[] = [];
  if (nameSearch) {
    titleSessionIds = db
      .prepare('SELECT session_id FROM session_titles WHERE title LIKE ?')
      .all(`%${nameSearch}%`)
      .map(r => String(r['session_id'] ?? ''))
      .filter(Boolean);

    const byTitle = titleSessionIds.length
      ? ` OR trace_id IN (
            SELECT trace_id FROM spans
            WHERE ${SESSION_TRACE_FILTER}
            GROUP BY trace_id
            HAVING ${SESSION_ID_EXPR} IN (${titleSessionIds.map(() => '?').join(',')})
          )`
      : '';

    searchClause = `AND (trace_id IN (
      SELECT DISTINCT trace_id FROM spans
      WHERE name LIKE ? OR span_id LIKE ? OR trace_id LIKE ? OR attributes LIKE ?
    )${byTitle})`;
  }

  // 1) Resolve each trace to its session id (and carry per-trace rollups).
  // 2) Aggregate traces into sessions.
  const sql = `
    WITH trace_session AS (
      SELECT
        trace_id,
        ${SESSION_ID_EXPR}                       AS session_id,
        ${AGENT_SERVICE_NAME}                    AS service_name,
        MIN(start_time_unix_nano)                AS trace_start,
        MAX(end_time_unix_nano)                  AS trace_end,
        ${AGENT_SPAN_COUNT}                      AS span_count,
        SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END)      AS error_count,
        SUM(CASE WHEN ${LLM_PREDICATE}  THEN 1 ELSE 0 END)   AS llm_count,
        SUM(CASE WHEN ${TOOL_PREDICATE} THEN 1 ELSE 0 END)   AS tool_count,
        SUM(${TOKENS_EXPR})                      AS token_sum,
        group_concat(DISTINCT ${MODEL_EXPR})     AS models
      FROM spans
      WHERE ${SESSION_TRACE_FILTER}
      ${searchClause}
      GROUP BY trace_id
    )
    SELECT
      session_id,
      MAX(service_name)              AS service_name,
      MIN(trace_start)              AS start_time_unix_nano,
      MAX(trace_end)               AS end_time_unix_nano,
      COUNT(*)                      AS trace_count,
      SUM(span_count)              AS span_count,
      SUM(error_count)             AS error_count,
      SUM(llm_count)               AS llm_request_count,
      SUM(tool_count)              AS tool_call_count,
      SUM(token_sum)               AS total_tokens,
      group_concat(models)         AS models
    FROM trace_session
    GROUP BY session_id
    ${errorsOnly ? 'HAVING SUM(error_count) > 0' : ''}
    ORDER BY MIN(trace_start) ${sortOrder === 'asc' ? 'ASC' : 'DESC'}
    LIMIT ?
  `;

  if (nameSearch) {
    const like = `%${nameSearch}%`;
    params.push(like, like, like, like, ...titleSessionIds);
  }
  params.push(limit);

  const rows = db.prepare(sql).all(...params);

  const erroredIds = rows
    .filter(r => Number(r['error_count'] ?? 0) > 0)
    .map(r => String(r['session_id'] ?? ''));
  const failuresBySession = loadSessionFailures(db, erroredIds);
  const titlesBySession = loadSessionTitles(db, rows.map(r => String(r['session_id'] ?? '')));

  return rows.map(r => {
    const startNano = String(r['start_time_unix_nano'] ?? '0');
    const endNano   = String(r['end_time_unix_nano']   ?? '0');
    const sessionId = String(r['session_id'] ?? '');
    const failures  = failuresBySession.get(sessionId) ?? [];
    return {
      sessionId,
      title:             titlesBySession.get(sessionId) ?? null,
      serviceName:       String(r['service_name']      ?? ''),
      models:            dedupeModels(r['models']),
      startTimeUnixNano: startNano,
      endTimeUnixNano:   endNano,
      durationMs:        nanoSpanMs(startNano, endNano),
      traceCount:        Number(r['trace_count']       ?? 0),
      spanCount:         Number(r['span_count']        ?? 0),
      llmRequestCount:   Number(r['llm_request_count'] ?? 0),
      toolCallCount:     Number(r['tool_call_count']   ?? 0),
      totalTokens:       Number(r['total_tokens']      ?? 0),
      hasError:          Number(r['error_count']       ?? 0) > 0,
      errorCount:        Number(r['error_count']       ?? 0),
      failureReason:     failures.find(f => f.message)?.message ?? null,
      failures,
    };
  });
}

/** Splits a comma-joined group_concat of model names into a unique, non-empty list. */
function dedupeModels(v: unknown): string[] {
  if (v == null) { return []; }
  const seen = new Set<string>();
  for (const part of String(v).split(',')) {
    const m = part.trim();
    if (m && m !== 'null') { seen.add(m); }
  }
  return [...seen];
}

/** Wall-clock ms between two epoch-nanosecond strings (BigInt-safe). */
function nanoSpanMs(startNano: string, endNano: string): number {
  try {
    const ms = (BigInt(endNano) - BigInt(startNano)) / 1_000_000n;
    return ms > 0n ? Number(ms) : 0;
  } catch {
    return 0;
  }
}

/**
 * Full breakdown for a single session: its ordered turns (traces), per-tool and
 * per-model rollups, error details, and session-level totals. Returns null when
 * no session resolves to the given id. `sessionId` matches the value produced by
 * SESSION_ID_EXPR (gen_ai.conversation.id | session.id |
 * copilot_chat.chat_session_id | trace_id).
 */
export function getSessionSummary(db: QueryableDB, sessionId: string): SessionSummary | null {
  if (!sessionId?.trim()) { return null; }
  const id = sessionId.trim();

  // 1) Resolve this session's traces (turns) with per-trace rollups.
  const turnRows = db.prepare(`
    WITH trace_session AS (
      SELECT
        trace_id,
        ${SESSION_ID_EXPR}                                   AS session_id,
        ${AGENT_SERVICE_NAME}                                AS service_name,
        MIN(start_time_unix_nano)                            AS trace_start,
        MAX(end_time_unix_nano)                              AS trace_end,
        ${AGENT_SPAN_COUNT}                                  AS span_count,
        SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END)     AS error_count,
        SUM(CASE WHEN ${LLM_PREDICATE}  THEN 1 ELSE 0 END)   AS llm_count,
        SUM(CASE WHEN ${TOOL_PREDICATE} THEN 1 ELSE 0 END)   AS tool_count,
        SUM(${TOKENS_EXPR})                                  AS token_sum,
        group_concat(DISTINCT ${MODEL_EXPR})                 AS models
      FROM spans
      WHERE ${SESSION_TRACE_FILTER}
      GROUP BY trace_id
    )
    SELECT * FROM trace_session WHERE session_id = ? ORDER BY trace_start ASC
  `).all(id);

  if (!turnRows.length) { return null; }

  const traceIds = turnRows.map(r => String(r['trace_id'] ?? ''));
  const ph = traceIds.map(() => '?').join(',');

  // 2) Best-effort root span name per trace (earliest-starting parentless span).
  //    The agent host now parents provider spans under its own session anchor,
  //    so "parentless" alone would name every turn after the host. The turn's
  //    root is the earliest span whose parent is a host span, is missing from
  //    the store (retention evicts the anchor first), or absent entirely.
  const rootName = new Map<string, string>();
  for (const r of db.prepare(`
    SELECT s.trace_id AS trace_id, s.name AS name
    FROM spans s
    LEFT JOIN spans p ON p.trace_id = s.trace_id AND p.span_id = s.parent_span_id
    WHERE s.trace_id IN (${ph})
      AND NOT ${hostSpan('s.')}
      AND (s.parent_span_id IS NULL OR s.parent_span_id = ''
           OR p.span_id IS NULL OR ${hostSpan('p.')})
    ORDER BY s.start_time_unix_nano ASC
  `).all(...traceIds)) {
    const tid = String(r['trace_id'] ?? '');
    if (!rootName.has(tid)) { rootName.set(tid, String(r['name'] ?? '')); }
  }

  // 3) Tool usage by name.
  const toolStats: SessionToolStat[] = db.prepare(`
    SELECT
      COALESCE(json_extract(attributes,'$."gen_ai.tool.name"'), name) AS tool_name,
      COUNT(*)                                          AS cnt,
      SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END)  AS err
    FROM spans
    WHERE trace_id IN (${ph}) AND ${TOOL_PREDICATE}
    GROUP BY tool_name
    ORDER BY cnt DESC
  `).all(...traceIds).map(r => ({
    toolName:   String(r['tool_name'] ?? ''),
    count:      Number(r['cnt'] ?? 0),
    errorCount: Number(r['err'] ?? 0),
  }));

  // 4) Token usage by model.
  const modelTokens: SessionModelTokens[] = db.prepare(`
    SELECT
      ${MODEL_EXPR} AS model,
      SUM(${INPUT_TOKENS_EXPR})  AS input_tokens,
      SUM(${OUTPUT_TOKENS_EXPR}) AS output_tokens,
      COUNT(*)                   AS calls
    FROM spans
    WHERE trace_id IN (${ph}) AND ${LLM_PREDICATE}
    GROUP BY model
    ORDER BY (input_tokens + output_tokens) DESC
  `).all(...traceIds)
    .filter(r => r['model'] != null)
    .map(r => {
      const input  = Number(r['input_tokens']  ?? 0);
      const output = Number(r['output_tokens'] ?? 0);
      return {
        model:        String(r['model'] ?? ''),
        inputTokens:  input,
        outputTokens: output,
        totalTokens:  input + output,
        callCount:    Number(r['calls'] ?? 0),
      };
    });

  // 5) Errored spans (capped) for the failure narrative — across every turn.
  const errors: SessionErrorDetail[] = db.prepare(`
    SELECT
      trace_id,
      name,
      status_message,
      json_extract(attributes,'$."exception.type"')    AS ex_type,
      json_extract(attributes,'$."exception.message"') AS ex_msg
    FROM spans
    WHERE trace_id IN (${ph}) AND status_code = 2
    ORDER BY start_time_unix_nano ASC
    LIMIT 100
  `).all(...traceIds).map(r => ({
    traceId:          String(r['trace_id'] ?? ''),
    spanName:         String(r['name'] ?? ''),
    statusMessage:    r['status_message'] != null ? String(r['status_message']) : null,
    exceptionType:    r['ex_type'] != null ? String(r['ex_type']) : null,
    exceptionMessage: r['ex_msg'] != null ? String(r['ex_msg']) : null,
  }));

  // 6) Every distinct failure in the session, split per turn.
  const failures = loadSessionFailures(db, [id]).get(id) ?? [];
  const failuresByTrace = new Map<string, SessionFailure[]>();
  for (const f of failures) {
    const list = failuresByTrace.get(f.traceId) ?? [];
    list.push(f);
    failuresByTrace.set(f.traceId, list);
  }

  // 7) Assemble turns + session-level totals.
  const turns: SessionTurn[] = turnRows.map(r => {
    const startNano = String(r['trace_start'] ?? '0');
    const endNano   = String(r['trace_end']   ?? '0');
    const tid       = String(r['trace_id'] ?? '');
    const turnFails = failuresByTrace.get(tid) ?? [];
    return {
      traceId:          tid,
      rootName:         rootName.get(tid) ?? '',
      startTimeUnixNano: startNano,
      durationMs:       nanoSpanMs(startNano, endNano),
      spanCount:        Number(r['span_count']  ?? 0),
      llmRequestCount:  Number(r['llm_count']   ?? 0),
      toolCallCount:    Number(r['tool_count']  ?? 0),
      totalTokens:      Number(r['token_sum']   ?? 0),
      hasError:         Number(r['error_count'] ?? 0) > 0,
      errorCount:       Number(r['error_count'] ?? 0),
      failureReason:    turnFails.find(f => f.message)?.message ?? null,
      failures:         turnFails,
    };
  });

  const startNano = turnRows.reduce((min, r) => {
    const v = String(r['trace_start'] ?? '0');
    return min === '' || BigIntSafeLt(v, min) ? v : min;
  }, '');
  const endNano = turnRows.reduce((max, r) => {
    const v = String(r['trace_end'] ?? '0');
    return max === '' || BigIntSafeLt(max, v) ? v : max;
  }, '');

  const models = dedupeModels(turnRows.map(r => r['models']).filter(v => v != null).join(','));
  const failureReason = failures.find(f => f.message)?.message ?? null;

  return {
    sessionId:         id,
    title:             loadSessionTitles(db, [id]).get(id) ?? null,
    serviceName:       String(turnRows[0]['service_name'] ?? ''),
    models,
    startTimeUnixNano: startNano || '0',
    endTimeUnixNano:   endNano || '0',
    durationMs:        nanoSpanMs(startNano || '0', endNano || '0'),
    traceCount:        turns.length,
    spanCount:         turns.reduce((s, t) => s + t.spanCount, 0),
    llmRequestCount:   turns.reduce((s, t) => s + t.llmRequestCount, 0),
    toolCallCount:     turns.reduce((s, t) => s + t.toolCallCount, 0),
    totalTokens:       turns.reduce((s, t) => s + t.totalTokens, 0),
    hasError:          turns.some(t => t.hasError),
    errorCount:        turns.reduce((s, t) => s + t.errorCount, 0),
    failureReason,
    failures,
    inputTokens:       modelTokens.reduce((s, m) => s + m.inputTokens, 0),
    outputTokens:      modelTokens.reduce((s, m) => s + m.outputTokens, 0),
    turns,
    toolStats,
    modelTokens,
    errors,
  };
}

/** True when nanosecond string `a` is strictly less than `b` (BigInt-safe). */
function BigIntSafeLt(a: string, b: string): boolean {
  try {
    return BigInt(a) < BigInt(b);
  } catch {
    return Number(a) < Number(b);
  }
}

/** Concatenated text parts of one captured chat message, or ''. */
function messageText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') { return ''; }
  const m = msg as { parts?: unknown; content?: unknown };
  if (Array.isArray(m.parts)) {
    return m.parts
      .map((p: unknown) => {
        if (p && typeof p === 'object') {
          const part = p as { type?: unknown; content?: unknown; text?: unknown };
          return part.type === 'text' ? String(part.content ?? part.text ?? '') : '';
        }
        return typeof p === 'string' ? p : '';
      })
      .join(' ')
      .trim();
  }
  return typeof m.content === 'string' ? m.content.trim() : '';
}

/** Text of the first or last `user`-role message in a raw
 *  `gen_ai.input.messages` JSON string, capped to `max` chars, or null. */
function userPrompt(inputMessagesJson: unknown, from: 'first' | 'last', max: number): string | null {
  if (typeof inputMessagesJson !== 'string') { return null; }
  let arr: unknown;
  try { arr = JSON.parse(inputMessagesJson); } catch { return null; }
  if (!Array.isArray(arr)) { return null; }

  const order = from === 'last'
    ? arr.map((_, i) => arr.length - 1 - i)
    : arr.map((_, i) => i);

  for (const i of order) {
    const msg = arr[i] as { role?: unknown };
    if (!msg || typeof msg !== 'object' || msg.role !== 'user') { continue; }
    const text = messageText(msg);
    if (text) { return text.length > max ? text.slice(0, max) + '…' : text; }
  }
  return null;
}

/** Latest user prompt, anchoring each assistant turn to the prompt that
 *  produced it. */
function lastUserPrompt(inputMessagesJson: unknown): string | null {
  return userPrompt(inputMessagesJson, 'last', 500);
}

/** Opening user prompt, used as a session label when no title was reported. */
function firstUserPrompt(inputMessagesJson: unknown): string | null {
  const text = userPrompt(inputMessagesJson, 'first', 120);
  return text ? text.replace(/\s+/g, ' ') : null;
}

/**
 * The ordered model responses within a session — one entry per chat/LLM span
 * that recorded captured `gen_ai.output.messages`. Returns null when no session
 * resolves to `sessionId`. When the session exists but has no captured content,
 * `captureEnabled` is false and `turns` is empty. `sessionId` matches the value
 * produced by SESSION_ID_EXPR.
 */
export function getSessionMessages(db: QueryableDB, sessionId: string): SessionMessages | null {
  if (!sessionId?.trim()) { return null; }
  const id = sessionId.trim();

  const traceRows = db.prepare(`
    WITH trace_session AS (
      SELECT trace_id, ${SESSION_ID_EXPR} AS session_id
      FROM spans
      WHERE ${SESSION_TRACE_FILTER}
      GROUP BY trace_id
    )
    SELECT trace_id FROM trace_session WHERE session_id = ?
  `).all(id);

  if (!traceRows.length) { return null; }

  const traceIds = traceRows.map(r => String(r['trace_id'] ?? ''));
  const ph = traceIds.map(() => '?').join(',');

  const rows = db.prepare(`
    SELECT
      trace_id,
      span_id,
      name,
      start_time_unix_nano,
      status_code,
      json_extract(attributes,'$."gen_ai.request.model"')   AS model,
      json_extract(attributes,'$."gen_ai.output.messages"')  AS output_messages,
      json_extract(attributes,'$."gen_ai.input.messages"')   AS input_messages
    FROM spans
    WHERE trace_id IN (${ph})
      AND ${LLM_PREDICATE}
      AND json_extract(attributes,'$."gen_ai.output.messages"') IS NOT NULL
    ORDER BY start_time_unix_nano ASC
  `).all(...traceIds);

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

  return { sessionId: id, captureEnabled: turns.length > 0, turns };
}
