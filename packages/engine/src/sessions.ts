import type {
  QueryableDB,
  Session,
  SessionFailure,
  SessionMessages,
  SessionMessageTurn,
  SessionMessageDetail,
  SessionMessageDetailItem,
  BackgroundTraceStats,
} from '@agent-insights/types';
import {
  SESSION_TITLE_SPAN_NAME,
  SESSION_URI_ATTR,
  SESSION_ID_ATTR,
  CODEX_LLM_SPAN,
  CODEX_TOOL_SPAN,
  hostSpanSql,
  llmSpanSql,
  toolSpanSql,
  unkeyedUtilityTraceSql,
} from '@agent-insights/receiver';
import {
  CLAUDE_TOOL_EXECUTION_SPAN,
  CLAUDE_TOOL_SPAN,
  toolCallErrorSql,
} from './toolCalls';
import { outputTokensExprSql, promptTokensExprSql } from './tokenRows';

export { SESSION_TITLE_SPAN_NAME } from '@agent-insights/receiver';

/** One trace within a session. */
export interface SessionTurn {
  traceId: string;
  rootName: string;
  startTimeUnixNano: string;
  durationMs: number;
  spanCount: number;
  llmRequestCount: number;
  toolCallCount: number;
  totalTokens: number;
  hasError: boolean;
  errorCount: number;
  failureReason: string | null;
  failures: SessionFailure[];
}

export interface SessionToolStat {
  toolName: string;
  count: number;
  errorCount: number;
}

export interface SessionModelTokens {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  callCount: number;
}

export interface SessionErrorDetail {
  traceId: string;
  spanName: string;
  statusMessage: string | null;
  exceptionType: string | null;
  exceptionMessage: string | null;
}

/** Durable session totals with raw-backed details. */
export interface SessionSummary extends Session {
  inputTokens: number;
  outputTokens: number;
  turns: SessionTurn[];
  toolStats: SessionToolStat[];
  modelTokens: SessionModelTokens[];
  errors: SessionErrorDetail[];
}

const CODEX_PROMPT_EVENT       = 'codex.user_prompt';
const CODEX_TOOL_EVENT         = 'codex.tool_result';
const CODEX_DECISION_EVENT     = 'codex.tool_decision';
const CODEX_SANDBOX_EVENT      = 'codex.sandbox_outcome';
const CODEX_SSE_EVENT          = 'codex.sse_event';
const CODEX_START_EVENT        = 'codex.conversation_starts';
const CODEX_TURN_COST_EVENT    = 'codex.turn_cost';
const CODEX_API_EVENT          = 'codex.api_request';

const CLAUDE_PROMPT_EVENT        = 'user_prompt';
const CLAUDE_RESPONSE_EVENT      = 'assistant_response';
const CLAUDE_TOOL_EVENT          = 'tool_result';
const CLAUDE_DECISION_EVENT      = 'tool_decision';
const CLAUDE_API_EVENT           = 'api_request';
const CLAUDE_API_ERROR_EVENT     = 'api_error';
const CLAUDE_API_REFUSAL_EVENT   = 'api_refusal';
const CLAUDE_REQUEST_BODY_EVENT  = 'api_request_body';
const CLAUDE_RESPONSE_BODY_EVENT = 'api_response_body';

/** Session URI scheme, such as `claude`. */
const SESSION_URI_SCHEME_EXPR = `NULLIF(
  substr(
    json_extract(attributes, '$."${SESSION_URI_ATTR}"'),
    1,
    instr(COALESCE(json_extract(attributes, '$."${SESSION_URI_ATTR}"'), ''), ':') - 1
  ), '')`;

/** Receiver-owned predicate for LLM request spans. */
export const llmPredicate = (alias = ''): string => llmSpanSql(alias);
export const LLM_PREDICATE = llmPredicate();

const hostSpan = (alias = ''): string => hostSpanSql(alias);


/** Resolve durable trace summaries to sessions, excluding utilities and echoes. */
const TRACE_SESSION_SELECT = `
  SELECT f.trace_id                                            AS trace_id,
         COALESCE(f.key_conversation, f.key_session, f.key_chat,
                  c.session_id, f.trace_id)                     AS session_id,
         f.service_name                                         AS service_name,
         f.start_unix_nano                                      AS trace_start,
         f.end_unix_nano                                        AS trace_end,
         f.root_name                                            AS root_name,
         f.span_count                                           AS span_count,
         f.llm_count                                            AS llm_count,
         f.tool_count                                           AS tool_count,
        f.error_count                                          AS error_count,
        f.input_tokens                                         AS input_tokens,
        f.output_tokens                                        AS output_tokens,
        f.input_tokens + f.output_tokens                       AS token_sum,
        f.has_user_prompt                                      AS has_user_prompt
   FROM session_trace_facts f
   LEFT JOIN codex_trace_sessions c ON c.trace_id = f.trace_id
   WHERE f.span_count > 0
     AND NOT ${unkeyedUtilityTraceSql()}
     AND NOT (f.has_content_log = 1
              AND f.has_conversation_log = 0
              AND f.llm_count = 0)`;

export const TRACE_SESSION_CTE = `trace_session AS (${TRACE_SESSION_SELECT})`;

/** Trace ids for a session. Bind the session id twice. */
export const SESSION_TRACE_IDS_SQL = `
  SELECT trace_id FROM (${TRACE_SESSION_SELECT}) WHERE session_id = ?
  UNION
  SELECT trace_id FROM spans
  WHERE name = '${SESSION_TITLE_SPAN_NAME}'
    AND json_extract(attributes,'$."gen_ai.conversation.id"') = ?
`;

/** Resolve a trace, including title metadata, to its durable session. */
export function getSessionIdForTrace(db: QueryableDB, traceId: string): string | null {
  const id = traceId?.trim();
  if (!id) { return null; }

  const row = db.prepare(`
    SELECT COALESCE(f.key_conversation, f.key_session, f.key_chat,
                    c.session_id, f.trace_id) AS session_id
      FROM session_trace_facts f
      LEFT JOIN codex_trace_sessions c ON c.trace_id = f.trace_id
     WHERE f.trace_id = ?
       AND NOT ${unkeyedUtilityTraceSql()}
  `).get(id);
  if (row?.['session_id'] != null) { return String(row['session_id']); }

  // Title metadata uses an unsummarized synthetic trace.
  const title = db.prepare(`
    SELECT json_extract(attributes,'$."${SESSION_ID_ATTR}"') AS session_id
      FROM spans
     WHERE trace_id = ?
       AND name = '${SESSION_TITLE_SPAN_NAME}'
       AND json_extract(attributes,'$."${SESSION_ID_ATTR}"') IS NOT NULL
     LIMIT 1
  `).get(id);
  return title?.['session_id'] != null ? String(title['session_id']) : null;
}

type HarnessKind = 'copilot' | 'claude' | 'codex';

interface ConversationSourceSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  toolName: string;
  callId: string;
}

export interface ConversationSourceResolver {
  modelCall(
    harness: Exclude<HarnessKind, 'copilot'>,
    traceId: string,
    contextSpanId: unknown,
    timestampUnixNano: unknown,
    requestId?: unknown,
  ): string | null;
  toolCall(
    harness: HarnessKind,
    traceId: string,
    opts: {
      callId?: unknown;
      toolName?: unknown;
      timestampUnixNano?: unknown;
      ownerSpanId?: unknown;
    },
  ): string | null;
  enrichSpanMessages(traceId: string, ownerSpanId: string, outputMessages: string): string;
}

const normalizedToolName = (value: unknown): string =>
  value == null ? '' : String(value).trim().toLowerCase();

/** Resolve the source span for transcript navigation. */
export function createConversationSourceResolver(
  db: QueryableDB,
  traceIds: string[],
): ConversationSourceResolver {
  if (!traceIds.length) {
    return {
      modelCall: () => null,
      toolCall: () => null,
      enrichSpanMessages: (_traceId, _ownerSpanId, outputMessages) => outputMessages,
    };
  }
  const ph = traceIds.map(() => '?').join(',');
  const spans: ConversationSourceSpan[] = db.prepare(`
    SELECT
      trace_id,
      span_id,
      parent_span_id,
      name,
      start_time_unix_nano,
      end_time_unix_nano,
      COALESCE(
        json_extract(attributes,'$."gen_ai.tool.name"'),
        json_extract(attributes,'$."tool.name"'),
        json_extract(attributes,'$."tool_name"')
      ) AS tool_name,
      COALESCE(
        json_extract(attributes,'$."gen_ai.tool.call.id"'),
        json_extract(attributes,'$."gen_ai.tool.call_id"'),
        json_extract(attributes,'$."tool_use_id"'),
        json_extract(attributes,'$."tool_call_id"'),
        json_extract(attributes,'$."call_id"'),
        json_extract(attributes,'$."request_id"')
      ) AS call_id
    FROM spans
    WHERE trace_id IN (${ph})
  `).all(...traceIds).map(row => ({
    traceId: String(row['trace_id'] ?? ''),
    spanId: String(row['span_id'] ?? ''),
    parentSpanId: String(row['parent_span_id'] ?? ''),
    name: String(row['name'] ?? ''),
    startTimeUnixNano: String(row['start_time_unix_nano'] ?? '0'),
    endTimeUnixNano: String(row['end_time_unix_nano'] ?? row['start_time_unix_nano'] ?? '0'),
    toolName: normalizedToolName(row['tool_name']),
    callId: row['call_id'] != null ? String(row['call_id']) : '',
  }));
  const byTrace = new Map<string, ConversationSourceSpan[]>();
  const byId = new Map<string, ConversationSourceSpan>();
  const keyOf = (traceId: string, spanId: string): string => `${traceId}\u0000${spanId}`;
  for (const span of spans) {
    const traceSpans = byTrace.get(span.traceId) ?? [];
    traceSpans.push(span);
    byTrace.set(span.traceId, traceSpans);
    byId.set(keyOf(span.traceId, span.spanId), span);
  }

  const unique = (candidates: ConversationSourceSpan[]): string | null =>
    candidates.length === 1 ? candidates[0].spanId : null;
  const contains = (span: ConversationSourceSpan, timestamp: unknown): boolean => {
    if (timestamp == null || String(timestamp) === '') { return false; }
    const at = nanosOf(timestamp);
    return at >= nanosOf(span.startTimeUnixNano) && at <= nanosOf(span.endTimeUnixNano);
  };
  const ancestorNamed = (traceId: string, initialSpanId: unknown, name: string): string | null => {
    let spanId = initialSpanId != null ? String(initialSpanId) : '';
    const seen = new Set<string>();
    while (spanId && !seen.has(spanId)) {
      seen.add(spanId);
      const span = byId.get(keyOf(traceId, spanId));
      if (!span) { return null; }
      if (span.name === name) { return span.spanId; }
      spanId = span.parentSpanId;
    }
    return null;
  };
  const isDescendantOf = (span: ConversationSourceSpan, ownerSpanId: string): boolean => {
    let parentId = span.parentSpanId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      if (parentId === ownerSpanId) { return true; }
      seen.add(parentId);
      parentId = byId.get(keyOf(span.traceId, parentId))?.parentSpanId ?? '';
    }
    return false;
  };

  const modelCall: ConversationSourceResolver['modelCall'] = (
    harness,
    traceId,
    contextSpanId,
    timestampUnixNano,
    requestId,
  ) => {
    const expectedName = harness === 'codex' ? CODEX_LLM_SPAN : 'claude_code.llm_request';
    const ancestor = ancestorNamed(traceId, contextSpanId, expectedName);
    if (ancestor) { return ancestor; }
    // Codex timestamps alone do not prove ancestry.
    if (harness === 'codex') { return null; }
    const candidates = (byTrace.get(traceId) ?? []).filter(span => span.name === expectedName);
    const request = requestId != null ? String(requestId) : '';
    if (request) {
      const byRequest = candidates.filter(span => span.callId === request);
      const exact = unique(byRequest);
      if (exact) { return exact; }
      if (byRequest.length > 1) { return null; }
    }
    return unique(candidates.filter(span => contains(span, timestampUnixNano)));
  };

  const toolCall: ConversationSourceResolver['toolCall'] = (harness, traceId, opts) => {
    const candidates = (byTrace.get(traceId) ?? []).filter(span =>
      harness === 'copilot'
        ? span.name.startsWith('execute_tool')
        : harness === 'claude'
          ? span.name === CLAUDE_TOOL_SPAN
          : span.name === CODEX_TOOL_SPAN);
    const callId = opts.callId != null ? String(opts.callId) : '';
    if (callId) {
      const byCallId = candidates.filter(span => span.callId === callId);
      const exact = unique(byCallId);
      if (exact) { return exact; }
      if (byCallId.length > 1) { return null; }
    }

    const wantedName = normalizedToolName(opts.toolName);
    const ownerSpanId = opts.ownerSpanId != null ? String(opts.ownerSpanId) : '';
    let scoped = candidates;
    if (harness === 'copilot') {
      if (!ownerSpanId) { return null; }
      scoped = scoped.filter(span => isDescendantOf(span, ownerSpanId));
    } else {
      scoped = scoped.filter(span => contains(span, opts.timestampUnixNano));
    }
    if (wantedName) {
      const named = scoped.filter(span => span.toolName === wantedName);
      if (named.length) { scoped = named; }
      else if (scoped.some(span => span.toolName)) { return null; }
    }
    return unique(scoped);
  };

  const enrichSpanMessages = (traceId: string, ownerSpanId: string, outputMessages: string): string => {
    let messages: unknown;
    try { messages = JSON.parse(outputMessages); } catch { return outputMessages; }
    if (!Array.isArray(messages)) { return outputMessages; }
    const sourceByCall = new Map<string, string>();
    for (const message of messages) {
      if (!message || typeof message !== 'object') { continue; }
      const parts = (message as { parts?: unknown }).parts;
      if (!Array.isArray(parts)) { continue; }
      for (const part of parts) {
        if (!part || typeof part !== 'object') { continue; }
        const tool = part as Record<string, unknown>;
        if (tool['type'] !== 'tool_call') { continue; }
        const sourceSpanId = toolCall('copilot', traceId, {
          callId: tool['id'],
          toolName: tool['name'],
          ownerSpanId,
        });
        if (!sourceSpanId) { continue; }
        tool['sourceSpanId'] = sourceSpanId;
        if (tool['id'] != null) { sourceByCall.set(String(tool['id']), sourceSpanId); }
      }
    }
    for (const message of messages) {
      if (!message || typeof message !== 'object') { continue; }
      const parts = (message as { parts?: unknown }).parts;
      if (!Array.isArray(parts)) { continue; }
      for (const part of parts) {
        if (!part || typeof part !== 'object') { continue; }
        const tool = part as Record<string, unknown>;
        if (tool['type'] !== 'tool_call_response' || tool['id'] == null) { continue; }
        const sourceSpanId = sourceByCall.get(String(tool['id']));
        if (sourceSpanId) { tool['sourceSpanId'] = sourceSpanId; }
      }
    }
    return JSON.stringify(messages);
  };

  return { modelCall, toolCall, enrichSpanMessages };
}

const SUBAGENT_TYPE_ATTR = 'subagent_type';

// Presence marks a Claude subagent span.
export const SUBAGENT_ID_ATTR = 'agent_id';

// A named Copilot invoke_agent parent marks delegated work.
export const AGENT_NAME_ATTR = 'gen_ai.agent.name';

/** Columns `spanTurnOrigin` reads. Requires the turn's span aliased `s`, its parent `p`. */
export const SUBAGENT_SELECT = `
      json_extract(s.attributes,'$."${SUBAGENT_ID_ATTR}"')  AS agent_id,
      p.name                                                AS parent_name,
      json_extract(p.attributes,'$."${AGENT_NAME_ATTR}"')   AS parent_agent_name`;

export const SUBAGENT_JOIN = `LEFT JOIN spans p ON p.trace_id = s.trace_id AND p.span_id = s.parent_span_id`;

/** Resolve Claude and Copilot subagent origin. */
export function spanTurnOrigin(row: Record<string, unknown>): { isSubagent: boolean; subagentType: string | null } {
  if (row['agent_id'] != null) { return { isSubagent: true, subagentType: null }; }

  const agentName = row['parent_agent_name'] != null ? String(row['parent_agent_name']).trim() : '';
  const underInvoke = String(row['parent_name'] ?? '').startsWith('invoke_agent');
  return agentName && underInvoke
    ? { isSubagent: true, subagentType: agentName }
    : { isSubagent: false, subagentType: null };
}

export interface GetSessionsOptions {
  limit?: number;
  errorsOnly?: boolean;
  nameSearch?: string;
  sortOrder?: 'desc' | 'asc';
}

const TOOL_PREDICATE = toolSpanSql();

const rollupPredicate = (alias = ''): string =>
  `COALESCE(json_extract(${alias}attributes,'$."gen_ai.operation.name"'), '') = 'invoke_agent'`;

const modelExpr = (alias = ''): string => `COALESCE(
  json_extract(${alias}attributes,'$."gen_ai.request.model"'),
  json_extract(${alias}attributes,'$."gen_ai.response.model"'),
  json_extract(${alias}attributes,'$."llm.model"'),
  json_extract(${alias}attributes,'$."model"')
)`;

const ANCESTOR_MODEL_EXPR = `(
  WITH RECURSIVE model_ancestors(trace_id, parent_span_id, attributes, depth) AS (
    SELECT parent.trace_id, parent.parent_span_id, parent.attributes, 1
      FROM spans parent
     WHERE parent.trace_id = s.trace_id
       AND parent.span_id = s.parent_span_id
    UNION ALL
    SELECT parent.trace_id, parent.parent_span_id, parent.attributes, ancestor.depth + 1
      FROM spans parent
      JOIN model_ancestors ancestor
        ON parent.trace_id = ancestor.trace_id
       AND parent.span_id = ancestor.parent_span_id
     WHERE ancestor.depth < 64
  )
  SELECT ${modelExpr('ancestor.')}
    FROM model_ancestors ancestor
   WHERE ${modelExpr('ancestor.')} IS NOT NULL
   ORDER BY ancestor.depth
   LIMIT 1
)`;

const TOKEN_MODEL_EXPR = `COALESCE(${modelExpr('s.')}, ${ANCESTOR_MODEL_EXPR})`;
const FAILURE_MESSAGE_EXPR =
  `COALESCE(s.status_message, json_extract(s.attributes,'$."exception.message"'))`;

const MAX_SESSION_FAILURES = 50;

/** Load distinct retained failures for each session. */
function loadSessionFailures(db: QueryableDB, sessionIds: string[]): Map<string, SessionFailure[]> {
  const bySession = new Map<string, SessionFailure[]>();
  if (!sessionIds.length) { return bySession; }

  const ph = sessionIds.map(() => '?').join(',');
  const rows = db.prepare(`
    WITH RECURSIVE ${TRACE_SESSION_CTE},
    error_ancestors(error_span_id, trace_id, span_id, parent_span_id, depth) AS (
      SELECT s.span_id, s.trace_id, s.span_id, s.parent_span_id, 0
        FROM spans s
        JOIN trace_session ts ON ts.trace_id = s.trace_id
       WHERE s.status_code = 2 AND ts.session_id IN (${ph})
      UNION ALL
      SELECT a.error_span_id, p.trace_id, p.span_id, p.parent_span_id, a.depth + 1
        FROM error_ancestors a
        JOIN spans p ON p.trace_id = a.trace_id AND p.span_id = a.parent_span_id
       WHERE a.depth < 64
    ),
    error_segments AS (
      SELECT a.error_span_id, a.span_id AS root_span_id
        FROM error_ancestors a
        JOIN spans host
          ON host.trace_id = a.trace_id AND host.span_id = a.parent_span_id
       WHERE ${hostSpanSql('host.')}
    ),
    failure_rows AS (
      SELECT
        ts.session_id AS session_id,
        s.trace_id AS trace_id,
        s.span_id AS span_id,
        es.root_span_id AS root_span_id,
        s.name AS span_name,
        ${FAILURE_MESSAGE_EXPR} AS message,
        s.start_time_unix_nano AS start_nano,
        COUNT(*) OVER (
          PARTITION BY ts.session_id, s.trace_id, s.name, ${FAILURE_MESSAGE_EXPR}
        ) AS cnt,
        ROW_NUMBER() OVER (
          PARTITION BY ts.session_id, s.trace_id, s.name, ${FAILURE_MESSAGE_EXPR}
          ORDER BY CAST(s.start_time_unix_nano AS INTEGER), s.span_id
        ) AS occurrence
      FROM spans s
      JOIN trace_session ts ON ts.trace_id = s.trace_id
      LEFT JOIN error_segments es ON es.error_span_id = s.span_id
      WHERE s.status_code = 2 AND ts.session_id IN (${ph})
    )
    SELECT
      session_id, trace_id, span_id, root_span_id, span_name, message, cnt
    FROM failure_rows
    WHERE occurrence = 1
    ORDER BY CAST(start_nano AS INTEGER), span_name
  `).all(...sessionIds, ...sessionIds);

  for (const r of rows) {
    const sid  = String(r['session_id'] ?? '');
    const list = bySession.get(sid) ?? [];
    if (list.length >= MAX_SESSION_FAILURES) { continue; }
    const traceId = String(r['trace_id'] ?? '');
    const rootSpanId = r['root_span_id'] != null ? String(r['root_span_id']) : '';
    list.push({
      traceId,
      targetTraceId: rootSpanId ? `${traceId}:${rootSpanId}` : traceId,
      spanId:    String(r['span_id'] ?? ''),
      spanName:  String(r['span_name'] ?? ''),
      message:   r['message'] != null ? String(r['message']) : null,
      count:     Number(r['cnt'] ?? 0),
    });
    bySession.set(sid, list);
  }
  return bySession;
}

/** Load reported titles, falling back to opening prompts. */
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

  // Codex and some Claude sessions expose prompts only through logs.
  const stillUntitled = sessionIds.filter(id => id && !titles.has(id));
  for (const [sid, prompt] of loadLoggedOpeningPrompts(db, stillUntitled)) {
    titles.set(sid, prompt);
  }
  return titles;
}

/** Load agent names from durable titles, then retained session anchors. */
function loadSessionAgents(db: QueryableDB, sessionIds: string[]): Map<string, string> {
  const agents = new Map<string, string>();
  if (!sessionIds.length) { return agents; }

  const ph = sessionIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT session_id, agent FROM session_titles
     WHERE session_id IN (${ph}) AND agent IS NOT NULL AND agent <> ''
  `).all(...sessionIds);

  for (const r of rows) {
    const sid   = String(r['session_id'] ?? '');
    const agent = r['agent'] != null ? String(r['agent']).trim() : '';
    if (sid && agent) { agents.set(sid, agent); }
  }

  const unknown = sessionIds.filter(id => id && !agents.has(id));
  if (!unknown.length) { return agents; }

  const ph2 = unknown.map(() => '?').join(',');
  for (const r of db.prepare(`
    SELECT json_extract(attributes,'$."${SESSION_ID_ATTR}"') AS session_id,
           ${SESSION_URI_SCHEME_EXPR}                        AS agent
      FROM spans
     WHERE json_extract(attributes,'$."${SESSION_URI_ATTR}"') IS NOT NULL
       AND json_extract(attributes,'$."${SESSION_ID_ATTR}"') IN (${ph2})
  `).all(...unknown)) {
    const sid   = String(r['session_id'] ?? '');
    const agent = r['agent'] != null ? String(r['agent']).trim() : '';
    if (sid && agent && !agents.has(sid)) { agents.set(sid, agent); }
  }
  return agents;
}

/** Load opening prompts from captured LLM spans. */
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
      JOIN (${TRACE_SESSION_SELECT}) ts ON ts.trace_id = s.trace_id
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

/** Prompt records inspected when finding a label. */
const OPENING_PROMPT_LOOKAHEAD = 5;

/** Load the earliest authored prompt from harness logs. */
function loadLoggedOpeningPrompts(db: QueryableDB, sessionIds: string[]): Map<string, string> {
  const prompts = new Map<string, string>();
  if (!sessionIds.length) { return prompts; }

  const ph = sessionIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT session_id, prompt FROM (
      SELECT
        ts.session_id                             AS session_id,
        json_extract(l.attributes,'$."prompt"')   AS prompt,
        ROW_NUMBER() OVER (
          PARTITION BY ts.session_id
          ORDER BY CAST(l.timestamp_unix_nano AS INTEGER) ASC, l.id ASC
        ) AS rn
      FROM logs l
      JOIN (${TRACE_SESSION_SELECT}) ts ON ts.trace_id = l.trace_id
      WHERE ts.session_id IN (${ph})
        AND json_extract(l.attributes,'$."event.name"') IN (${USER_PROMPT_EVENTS})
    ) WHERE rn <= ${OPENING_PROMPT_LOOKAHEAD}
    ORDER BY rn ASC
  `).all(...sessionIds);

  for (const r of rows) {
    const sid = String(r['session_id'] ?? '');
    if (!sid || prompts.has(sid)) { continue; }
    const text = promptLabel(r['prompt']);
    if (text) { prompts.set(sid, text); }
  }
  return prompts;
}

/** Agent activity independent of conversation identity. */
const AGENT_ACTIVITY = `(
  COALESCE(SUM(llm_count), 0)   > 0
  OR COALESCE(SUM(tool_count), 0)  > 0
  OR COALESCE(SUM(token_sum), 0)   > 0
  OR COALESCE(SUM(error_count), 0) > 0
)`;

const USER_PROMPT_EVENTS = `'user_prompt', '${CODEX_PROMPT_EVENT}'`;

const SESSION_IS_TITLED = `session_id IN (SELECT session_id FROM session_titles)`;

/** Exclude background traces while retaining pruned session summaries. */
const BACKGROUND_TRACE_FILTER =
  `(COALESCE(SUM(span_count), 0) > 0
    AND (${AGENT_ACTIVITY} OR MAX(has_user_prompt) = 1 OR ${SESSION_IS_TITLED}))`;

/** Totals for traces excluded from Sessions. */
export function getBackgroundTraceStats(db: QueryableDB): BackgroundTraceStats {
  const rows = db.prepare(`
    WITH ${TRACE_SESSION_CTE},
    background AS (
      SELECT
        MAX(service_name) AS service_name,
        COUNT(*)          AS trace_count,
        SUM(span_count)   AS span_count
      FROM trace_session
      GROUP BY session_id
      HAVING NOT ${BACKGROUND_TRACE_FILTER}
    )
    SELECT
      service_name,
      SUM(trace_count) AS trace_count,
      SUM(span_count)  AS span_count
    FROM background
    GROUP BY service_name
  `).all();

  return {
    traceCount:   rows.reduce((n, r) => n + Number(r['trace_count'] ?? 0), 0),
    spanCount:    rows.reduce((n, r) => n + Number(r['span_count'] ?? 0), 0),
    serviceNames: rows.map(r => String(r['service_name'] ?? '')).filter(Boolean).sort(),
  };
}

/** List sessions from durable trace summaries. */
export function getSessions(db: QueryableDB, opts: GetSessionsOptions = {}): Session[] {
  const { limit = 500, errorsOnly, nameSearch, sortOrder = 'desc' } = opts;

  const params: unknown[] = [];

  // Search selects whole sessions without changing their aggregates.
  let searchCte = '';
  let searchClause = '';
  if (nameSearch) {
    searchCte = `,
    session_search_matches AS MATERIALIZED (
      SELECT session_id
        FROM trace_session
       WHERE session_id LIKE ? OR trace_id LIKE ? OR service_name LIKE ? OR root_name LIKE ?
      UNION
      SELECT session_id
        FROM session_titles
       WHERE title LIKE ? OR agent LIKE ?
      UNION
      SELECT t.session_id
        FROM session_trace_models m
        JOIN trace_session t ON t.trace_id = m.trace_id
       WHERE m.model LIKE ?
      UNION
      SELECT t.session_id
        FROM spans s
        JOIN trace_session t ON t.trace_id = s.trace_id
       WHERE s.name LIKE ? OR s.span_id LIKE ? OR s.attributes LIKE ?
    )`;
    searchClause = 'AND session_id IN (SELECT session_id FROM session_search_matches)';
  }

  const sql = `
    WITH ${TRACE_SESSION_CTE}${searchCte}
    SELECT
      session_id,
      MAX(service_name)   AS service_name,
      MIN(trace_start)    AS start_time_unix_nano,
      MAX(trace_end)      AS end_time_unix_nano,
      COUNT(*)            AS trace_count,
      SUM(span_count)     AS span_count,
      SUM(error_count)    AS error_count,
      SUM(llm_count)      AS llm_request_count,
      SUM(tool_count)     AS tool_call_count,
      SUM(token_sum)      AS total_tokens
    FROM trace_session
    WHERE 1 = 1 ${searchClause}
    GROUP BY session_id
    HAVING ${BACKGROUND_TRACE_FILTER}${errorsOnly ? ' AND SUM(error_count) > 0' : ''}
    ORDER BY MIN(trace_start) ${sortOrder === 'asc' ? 'ASC' : 'DESC'}
    LIMIT ?
  `;

  if (nameSearch) {
    const like = `%${nameSearch}%`;
    params.push(like, like, like, like, like, like, like, like, like, like);
  }
  params.push(limit);

  const rows = db.prepare(sql).all(...params);

  const sessionIds = rows.map(r => String(r['session_id'] ?? ''));
  const erroredIds = rows
    .filter(r => Number(r['error_count'] ?? 0) > 0)
    .map(r => String(r['session_id'] ?? ''));
  const failuresBySession = loadSessionFailures(db, erroredIds);
  const titlesBySession = loadSessionTitles(db, sessionIds);
  const agentsBySession = loadSessionAgents(db, sessionIds);
  const modelsBySession = loadSessionModels(db, sessionIds);
  const detailsBySession = loadSessionDetailsState(db, sessionIds);

  return rows.map(r => {
    const startNano = String(r['start_time_unix_nano'] ?? '0');
    const endNano   = String(r['end_time_unix_nano']   ?? '0');
    const sessionId = String(r['session_id'] ?? '');
    const failures  = failuresBySession.get(sessionId) ?? [];
    const spanCount = Number(r['span_count'] ?? 0);
    return {
      sessionId,
      title:             titlesBySession.get(sessionId) ?? null,
      agent:             agentsBySession.get(sessionId) ?? null,
      serviceName:       String(r['service_name']      ?? ''),
      models:            modelsBySession.get(sessionId) ?? [],
      startTimeUnixNano: startNano,
      endTimeUnixNano:   endNano,
      durationMs:        nanoSpanMs(startNano, endNano),
      traceCount:        Number(r['trace_count']       ?? 0),
      spanCount,
      llmRequestCount:   Number(r['llm_request_count'] ?? 0),
      toolCallCount:     Number(r['tool_call_count']   ?? 0),
      totalTokens:       Number(r['total_tokens']      ?? 0),
      hasError:          Number(r['error_count']       ?? 0) > 0,
      errorCount:        Number(r['error_count']       ?? 0),
      failureReason:     failures.find(f => f.message)?.message ?? null,
      failures,
      detailsState:      detailsState(spanCount, detailsBySession.get(sessionId) ?? 0),
    };
  });
}

/** Compare retained spans with the durable summary. */
function detailsState(summarized: number, retained: number): Session['detailsState'] {
  if (retained <= 0 && summarized > 0) { return 'expired'; }
  return retained >= summarized ? 'complete' : 'partial';
}

function loadSessionDetailsState(db: QueryableDB, sessionIds: string[]): Map<string, number> {
  const retained = new Map<string, number>();
  if (!sessionIds.length) { return retained; }

  const ph = sessionIds.map(() => '?').join(',');
  for (const r of db.prepare(`
    WITH ${TRACE_SESSION_CTE}
    SELECT ts.session_id AS session_id, COUNT(*) AS retained
      FROM spans s
      JOIN trace_session ts ON ts.trace_id = s.trace_id
     WHERE ts.session_id IN (${ph})
       AND NOT ${hostSpan('s.')}
       AND s.name <> '${SESSION_TITLE_SPAN_NAME}'
     GROUP BY ts.session_id
  `).all(...sessionIds)) {
    retained.set(String(r['session_id'] ?? ''), Number(r['retained'] ?? 0));
  }
  return retained;
}

function loadSessionModels(db: QueryableDB, sessionIds: string[]): Map<string, string[]> {
  const models = new Map<string, string[]>();
  if (!sessionIds.length) { return models; }

  const ph = sessionIds.map(() => '?').join(',');
  for (const r of db.prepare(`
    WITH ${TRACE_SESSION_CTE}
    SELECT ts.session_id AS session_id, m.model AS model
      FROM session_trace_models m
      JOIN trace_session ts ON ts.trace_id = m.trace_id
     WHERE ts.session_id IN (${ph})
     GROUP BY ts.session_id, m.model
     ORDER BY ts.session_id, m.model
  `).all(...sessionIds)) {
    const sid = String(r['session_id'] ?? '');
    const model = r['model'] != null ? String(r['model']).trim() : '';
    if (!sid || !model || model === 'null') { continue; }
    const list = models.get(sid) ?? [];
    list.push(model);
    models.set(sid, list);
  }
  return models;
}

function nanoSpanMs(startNano: string, endNano: string): number {
  try {
    const ms = (BigInt(endNano) - BigInt(startNano)) / 1_000_000n;
    return ms > 0n ? Number(ms) : 0;
  } catch {
    return 0;
  }
}

/** Return durable session totals with retained tool, model, and error details. */
export function getSessionSummary(db: QueryableDB, sessionId: string): SessionSummary | null {
  if (!sessionId?.trim()) { return null; }
  const id = sessionId.trim();

  const turnRows = db.prepare(`
    WITH ${TRACE_SESSION_CTE}
    SELECT * FROM trace_session WHERE session_id = ? ORDER BY trace_start ASC
  `).all(id);

  if (!turnRows.length) { return null; }

  const traceIds = turnRows.map(r => String(r['trace_id'] ?? ''));
  const ph = traceIds.map(() => '?').join(',');

  const toolStats: SessionToolStat[] = db.prepare(`
    SELECT
      COALESCE(
        json_extract(attributes,'$."gen_ai.tool.name"'),
        json_extract(attributes,'$."tool_name"'),
        CASE WHEN name = '${CODEX_TOOL_SPAN}' THEN (
          SELECT g.name FROM spans c
          JOIN spans g ON g.parent_span_id = c.span_id
          WHERE c.parent_span_id = spans.span_id
          ORDER BY g.start_time_unix_nano
          LIMIT 1
        ) END,
        name
      ) AS tool_name,
      COUNT(*) AS cnt,
      SUM(CASE WHEN ${toolCallErrorSql('spans.')} THEN 1 ELSE 0 END) AS err
    FROM spans
    WHERE trace_id IN (${ph}) AND ${TOOL_PREDICATE}
    GROUP BY tool_name
    ORDER BY cnt DESC, tool_name
  `).all(...traceIds).map(r => ({
    toolName:   String(r['tool_name'] ?? ''),
    count:      Number(r['cnt'] ?? 0),
    errorCount: Number(r['err'] ?? 0),
  }));

  // Model attribution expires with raw spans; turn totals remain durable.
  const modelTokens: SessionModelTokens[] = db.prepare(`
    SELECT
      model,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(calls) AS calls
    FROM (
      SELECT
        ${TOKEN_MODEL_EXPR} AS model,
        ${promptTokensExprSql('s')} AS input_tokens,
        ${outputTokensExprSql('s')} AS output_tokens,
        0 AS calls
      FROM spans s
      WHERE s.trace_id IN (${ph})
        AND ${promptTokensExprSql('s')} + ${outputTokensExprSql('s')} > 0
        AND NOT ${rollupPredicate('s.')}
      UNION ALL
      SELECT ${TOKEN_MODEL_EXPR}, 0, 0, 1
      FROM spans s
      WHERE s.trace_id IN (${ph})
        AND ${llmPredicate('s.')}
    )
    WHERE model IS NOT NULL
    GROUP BY model
    ORDER BY (input_tokens + output_tokens) DESC
  `).all(...traceIds, ...traceIds)
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

  const failures = loadSessionFailures(db, [id]).get(id) ?? [];
  const failuresByTrace = new Map<string, SessionFailure[]>();
  for (const f of failures) {
    const list = failuresByTrace.get(f.traceId) ?? [];
    list.push(f);
    failuresByTrace.set(f.traceId, list);
  }

  const turns: SessionTurn[] = turnRows.map(r => {
    const startNano = String(r['trace_start'] ?? '0');
    const endNano   = String(r['trace_end']   ?? '0');
    const tid       = String(r['trace_id'] ?? '');
    const turnFails = failuresByTrace.get(tid) ?? [];
    return {
      traceId:          tid,
      rootName:         r['root_name'] != null ? String(r['root_name']) : '',
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

  const models = loadSessionModels(db, [id]).get(id) ?? [];
  const failureReason = failures.find(f => f.message)?.message ?? null;
  const spanCount = turns.reduce((s, t) => s + t.spanCount, 0);
  const serviceName = turnRows
    .map(r => (r['service_name'] != null ? String(r['service_name']) : ''))
    .find(Boolean) ?? '';

  return {
    sessionId:         id,
    title:             loadSessionTitles(db, [id]).get(id) ?? null,
    agent:             loadSessionAgents(db, [id]).get(id) ?? null,
    serviceName,
    models,
    startTimeUnixNano: startNano || '0',
    endTimeUnixNano:   endNano || '0',
    durationMs:        nanoSpanMs(startNano || '0', endNano || '0'),
    traceCount:        turns.length,
    spanCount,
    llmRequestCount:   turns.reduce((s, t) => s + t.llmRequestCount, 0),
    toolCallCount:     turns.reduce((s, t) => s + t.toolCallCount, 0),
    totalTokens:       turns.reduce((s, t) => s + t.totalTokens, 0),
    hasError:          turns.some(t => t.hasError),
    errorCount:        turns.reduce((s, t) => s + t.errorCount, 0),
    failureReason,
    failures,
    detailsState:      detailsState(spanCount, loadSessionDetailsState(db, [id]).get(id) ?? 0),
    inputTokens:       turnRows.reduce((s, r) => s + Number(r['input_tokens'] ?? 0), 0),
    outputTokens:      turnRows.reduce((s, r) => s + Number(r['output_tokens'] ?? 0), 0),
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

/** User-message text ordered from either end of a captured conversation. */
function userMessageTexts(inputMessagesJson: unknown, from: 'first' | 'last'): string[] {
  if (typeof inputMessagesJson !== 'string') { return []; }
  let arr: unknown;
  try { arr = JSON.parse(inputMessagesJson); } catch { return []; }
  if (!Array.isArray(arr)) { return []; }

  const order = from === 'last'
    ? arr.map((_, i) => arr.length - 1 - i)
    : arr.map((_, i) => i);

  const texts: string[] = [];
  for (const i of order) {
    const msg = arr[i] as { role?: unknown };
    if (!msg || typeof msg !== 'object' || msg.role !== 'user') { continue; }
    const text = messageText(msg);
    if (text) { texts.push(text); }
  }
  return texts;
}

/** Keep context not already represented by the turn transcript. */
function supplementalInputMessages(inputMessagesJson: unknown): string | null {
  if (typeof inputMessagesJson !== 'string') { return null; }
  let messages: unknown;
  try { messages = JSON.parse(inputMessagesJson); } catch { return null; }
  if (!Array.isArray(messages)) { return null; }

  const supplemental = messages.filter(message => {
    if (!message || typeof message !== 'object') { return false; }
    const role = String((message as { role?: unknown }).role ?? '');
    if (role === 'system' || role === 'developer') { return true; }
    if (role !== 'user') { return false; }
    const text = messageText(message);
    return !!text && !stripAgentContext(text, true);
  });
  return supplemental.length ? JSON.stringify(supplemental) : null;
}

/** Latest user message with authored content, or the last captured user message. */
export function lastUserPrompt(inputMessagesJson: unknown): string | null {
  const texts = userMessageTexts(inputMessagesJson, 'last');
  for (const raw of texts) {
    if (stripAgentContext(raw, true)) { return raw; }
  }
  // Preserve the last injection-only message.
  return texts[0] ?? null;
}

/** Opening authored prompt used when no session title exists. */
function firstUserPrompt(inputMessagesJson: unknown): string | null {
  for (const raw of userMessageTexts(inputMessagesJson, 'first')) {
    const text = promptLabel(raw);
    if (text) { return text; }
  }
  return null;
}

const AGENT_REPOSITORY_CONTEXT_BLOCK = [
  'Repository name:[^\\r\\n]*',
  'Owner:[^\\r\\n]*',
  'Current branch:[^\\r\\n]*',
  'Default branch:[^\\r\\n]*',
].join('\\r?\\n');

/** Match standalone host repository context blocks. */
const AGENT_REPOSITORY_CONTEXT = new RegExp(
  `(^|(?:\\r?\\n){1,2})` +
  `${AGENT_REPOSITORY_CONTEXT_BLOCK}(?:(?:\\r?\\n){1,2}${AGENT_REPOSITORY_CONTEXT_BLOCK})*` +
  `(?=(?:\\r?\\n){2}|\\s*$)`,
  'g',
);

function cleanAgentPrompt(raw: unknown): string | null {
  if (typeof raw !== 'string') { return null; }
  return stripAgentContext(raw, false) || null;
}

/** Match balanced, standalone context tags. */
const AGENT_CONTEXT_BLOCK =
  /(^|\r?\n)[ \t]*<([a-zA-Z][a-zA-Z0-9_-]*)(?:[ \t]+[^<>\r\n]*?)?>[\s\S]*?<\/\2>[ \t]*(?=\r?\n|$)/g;

const PROMPT_LABEL_MAX = 120;

/** Match the current request inside a Copilot Chat envelope. */
const USER_REQUEST_BLOCK =
  /(?:^|\r?\n)[ \t]*<userRequest>[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*<\/userRequest>[ \t]*(?=\r?\n|$)/g;

function unwrapUserRequest(text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(USER_REQUEST_BLOCK)) { last = m[1] ?? null; }
  return last?.trim() ? last : null;
}

/** Build a bounded single-line label from an authored prompt. */
function promptLabel(raw: unknown, max = PROMPT_LABEL_MAX): string | null {
  if (typeof raw !== 'string') { return null; }
  const flat = stripAgentContext(raw, true).replace(/\s+/g, ' ').trim();
  if (!flat) { return null; }
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/** Remove host scaffolding; optionally unwrap authored request blocks. */
function stripAgentContext(raw: string, blocks: boolean): string {
  let text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(AGENT_REPOSITORY_CONTEXT, '$1');
  if (blocks) {
    text = unwrapUserRequest(text) ?? text;
    text = text.replace(AGENT_CONTEXT_BLOCK, '$1');
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

type DetailFormat = SessionMessageDetailItem['format'];
type DetailField = readonly [key: string, label: string, format?: DetailFormat];

function parsedAttributes(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) { return {}; }
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function detailValue(value: unknown): string | null {
  if (value == null || value === '') { return null; }
  if (typeof value === 'string') { return value; }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Builds one safe, explicitly whitelisted transcript detail section. */
function detailSection(
  title: string,
  attributes: Record<string, unknown>,
  fields: readonly DetailField[],
): SessionMessageDetail | null {
  const items: SessionMessageDetailItem[] = [];
  for (const [key, label, format] of fields) {
    const value = detailValue(attributes[key]);
    if (value == null) { continue; }
    items.push({ label, value, ...(format ? { format } : {}) });
  }
  return items.length ? { title, items } : null;
}

function compactDetails(
  sections: Array<SessionMessageDetail | null | undefined>,
): SessionMessageDetail[] {
  return sections.filter((section): section is SessionMessageDetail => section != null);
}

const REQUEST_DETAIL_FIELDS: readonly DetailField[] = [
  ['gen_ai.operation.name', 'Operation'],
  ['gen_ai.request.model', 'Requested model'],
  ['gen_ai.response.model', 'Response model'],
  ['gen_ai.request.max_tokens', 'Maximum tokens'],
  ['gen_ai.request.temperature', 'Temperature'],
  ['gen_ai.request.top_p', 'Top P'],
  ['gen_ai.request.top_k', 'Top K'],
  ['gen_ai.request.seed', 'Seed'],
  ['gen_ai.request.frequency_penalty', 'Frequency penalty'],
  ['gen_ai.request.presence_penalty', 'Presence penalty'],
  ['gen_ai.request.choice.count', 'Choices'],
  ['gen_ai.request.reasoning.level', 'Reasoning level'],
  ['gen_ai.request.reasoning_effort', 'Reasoning effort'],
];

const USAGE_DETAIL_FIELDS: readonly DetailField[] = [
  ['gen_ai.response.id', 'Response ID'],
  ['gen_ai.response.finish_reasons', 'Finish reasons', 'json'],
  ['gen_ai.usage.input_tokens', 'Input tokens'],
  ['gen_ai.usage.output_tokens', 'Output tokens'],
  ['gen_ai.usage.cache_read.input_tokens', 'Cache-read tokens'],
  ['gen_ai.usage.cache_write.input_tokens', 'Cache-write tokens'],
  ['gen_ai.usage.cache_creation.input_tokens', 'Cache-creation tokens'],
];

/** Rich context carried directly on a GenAI model span (Copilot/Agent Host). */
export function spanMessageRichData(row: Record<string, unknown>): Pick<
  SessionMessageTurn,
  'inputContextMessages' | 'systemInstructions' | 'details'
> {
  const attributes = parsedAttributes(row['attributes']);
  return {
    inputContextMessages: supplementalInputMessages(row['input_messages']),
    systemInstructions: row['system_instructions'] != null ? String(row['system_instructions']) : null,
    details: compactDetails([
      detailSection('Request configuration', attributes, REQUEST_DETAIL_FIELDS),
      detailSection('Response and usage', attributes, USAGE_DETAIL_FIELDS),
    ]),
  };
}

/** Convert a Claude response to captured output-message JSON. */
function claudeOutputMessages(response: string): string {
  return JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: response }] }]);
}

/** Resolve Claude subagent origin, including traces with pruned parents. */
function subagentOf(spanName: string, subagentType: unknown): { isSubagent: boolean; subagentType: string | null } {
  const type = subagentType != null ? String(subagentType).trim() : '';
  return {
    isSubagent:   !!type || spanName === CLAUDE_TOOL_EXECUTION_SPAN,
    subagentType: type || null,
  };
}

const CLAUDE_TOOL_DETAIL_FIELDS: readonly DetailField[] = [
  ['tool_use_id', 'Call ID'],
  ['success', 'Success'],
  ['duration_ms', 'Duration (ms)'],
  ['decision_type', 'Decision'],
  ['decision_source', 'Decision source'],
  ['error_type', 'Error type'],
  ['error', 'Error'],
  ['mcp_server_scope', 'MCP server scope'],
  ['tool_parameters', 'Parameters', 'json'],
  ['tool_input', 'Input', 'json'],
  ['tool_input_size_bytes', 'Input bytes'],
  ['tool_result_size_bytes', 'Result bytes'],
];

const CLAUDE_API_DETAIL_FIELDS: readonly DetailField[] = [
  ['model', 'Model'],
  ['effort', 'Effort'],
  ['speed', 'Speed'],
  ['query_source', 'Query source'],
  ['agent.name', 'Agent'],
  ['skill.name', 'Skill'],
  ['plugin.name', 'Plugin'],
  ['marketplace.name', 'Marketplace'],
  ['mcp_server.name', 'MCP server'],
  ['mcp_tool.name', 'MCP tool'],
  ['request_id', 'Request ID'],
  ['client_request_id', 'Client request ID'],
  ['attempt', 'Attempts'],
  ['duration_ms', 'Duration (ms)'],
  ['input_tokens', 'Input tokens'],
  ['output_tokens', 'Output tokens'],
  ['cache_read_tokens', 'Cache-read tokens'],
  ['cache_creation_tokens', 'Cache-creation tokens'],
  ['cost_usd', 'Estimated cost (USD)'],
  ['status_code', 'Status'],
  ['error', 'Error'],
];

/** One Claude model call reconstructed from logs. */
interface ClaudeCallDraft {
  traceId: string;
  spanId: string;
  sourceSpanId: string | null;
  spanName: string;
  startTimeUnixNano: string;
  model: string | null;
  hasError: boolean;
  /** Whether an `api_*` record has claimed this call. */
  opened: boolean;
  promptKey: string;
  fallbackPrompt: string | null;
  isSubagent: boolean;
  subagentType: string | null;
  text: string | null;
  parts: Record<string, unknown>[];
  details: SessionMessageDetail[];
}

function appendOutputParts(outputMessages: string, parts: Record<string, unknown>[]): string {
  if (!parts.length) { return outputMessages; }
  try {
    const messages: unknown = JSON.parse(outputMessages);
    if (Array.isArray(messages)) {
      const assistant = messages.find(message =>
        message && typeof message === 'object' && (message as { role?: unknown }).role === 'assistant');
      if (assistant && typeof assistant === 'object') {
        const message = assistant as { parts?: unknown };
        message.parts = [...(Array.isArray(message.parts) ? message.parts : []), ...parts];
        return JSON.stringify(messages);
      }
    }
  } catch {
    // Preserve malformed provider content below and add the structured parts.
  }
  return JSON.stringify([{ role: 'assistant', parts }]);
}

/** Conversation turns rebuilt from Claude's prompt/response records. */
export function claudeLogTurns(db: QueryableDB, traceIds: string[]): SessionMessageTurn[] {
  if (!traceIds.length) { return []; }
  const ph = traceIds.map(() => '?').join(',');
  const sources = createConversationSourceResolver(db, traceIds);

  const rows = db.prepare(`
    SELECT
      l.trace_id,
      l.span_id,
      l.timestamp_unix_nano,
      l.severity_number,
      s.name                                                  AS span_name,
      json_extract(s.attributes,'$."user_prompt"')            AS span_prompt,
      json_extract(p.attributes,'$."${SUBAGENT_TYPE_ATTR}"')  AS subagent_type,
      json_extract(l.attributes,'$."event.name"')             AS event_name,
      json_extract(l.attributes,'$."prompt.id"')              AS prompt_id,
      json_extract(l.attributes,'$."model"')                  AS model,
      json_extract(l.attributes,'$."prompt"')                 AS prompt,
      json_extract(l.attributes,'$."response"')               AS response,
      l.attributes                                             AS attributes
    FROM logs l
    LEFT JOIN spans s ON s.trace_id = l.trace_id AND s.span_id = l.span_id
    LEFT JOIN spans p ON p.trace_id = s.trace_id AND p.span_id = s.parent_span_id
    WHERE l.trace_id IN (${ph})
      AND json_extract(l.attributes,'$."event.name"') IN (${Array(9).fill('?').join(',')})
    ORDER BY CAST(l.timestamp_unix_nano AS INTEGER) ASC,
             CAST(COALESCE(json_extract(l.attributes,'$."event.sequence"'), 0) AS INTEGER) ASC
  `).all(
    ...traceIds,
    CLAUDE_PROMPT_EVENT,
    CLAUDE_RESPONSE_EVENT,
    CLAUDE_TOOL_EVENT,
    CLAUDE_DECISION_EVENT,
    CLAUDE_API_EVENT,
    CLAUDE_API_ERROR_EVENT,
    CLAUDE_API_REFUSAL_EVENT,
    CLAUDE_REQUEST_BODY_EVENT,
    CLAUDE_RESPONSE_BODY_EVENT,
  );

  // Fall back to the latest prompt when `prompt.id` is absent.
  const promptByKey = new Map<string, string>();
  const promptStateByTrace = new Map<string, {
    latestPrompt: string | null;
    currentPromptKey: string;
    anonymousPrompt: number;
  }>();
  const turns: SessionMessageTurn[] = [];
  /** Calls in log order, per prompt — the newest is the one still in flight. */
  const callsByPrompt = new Map<string, ClaudeCallDraft[]>();
  /** Every call, in the order it opened, across prompts. */
  const callOrder: ClaudeCallDraft[] = [];

  for (const r of rows) {
    const traceId = String(r['trace_id'] ?? '');
    const promptId = r['prompt_id'] != null ? String(r['prompt_id']) : '';
    const event = String(r['event_name'] ?? '');
    let state = promptStateByTrace.get(traceId);
    if (!state) {
      state = {
        latestPrompt: null,
        currentPromptKey: `${traceId}:unthreaded`,
        anonymousPrompt: 0,
      };
      promptStateByTrace.set(traceId, state);
    }

    if (event === CLAUDE_PROMPT_EVENT) {
      // Span content backs up injection-only prompt logs.
      const text = cleanAgentPrompt(r['prompt']) ?? cleanAgentPrompt(r['span_prompt']);
      const promptKey = promptId
        ? `${traceId}:prompt:${promptId}`
        : `${traceId}:anonymous:${++state.anonymousPrompt}`;
      if (text) {
        state.latestPrompt = text;
        promptByKey.set(promptKey, text);
      }
      state.currentPromptKey = promptKey;
      continue;
    }

    const spanName = String(r['span_name'] ?? CLAUDE_RESPONSE_EVENT);
    const origin   = subagentOf(spanName, r['subagent_type']);
    const promptKey = promptId ? `${traceId}:prompt:${promptId}` : state.currentPromptKey;
    const attributes = parsedAttributes(r['attributes']);

    // `api_request` boundaries preserve each model call in an agent loop.
    const known = callsByPrompt.get(promptKey);
    const calls = known ?? [];
    if (!known) { callsByPrompt.set(promptKey, calls); }
    const openCall = (): ClaudeCallDraft | null => calls[calls.length - 1] ?? null;
    const startCall = (opened: boolean): ClaudeCallDraft => {
      const draft: ClaudeCallDraft = {
        traceId,
        spanId:            String(r['span_id'] ?? ''),
        sourceSpanId:      null,
        spanName,
        startTimeUnixNano: String(r['timestamp_unix_nano'] ?? '0'),
        model:             r['model'] != null ? String(r['model']) : null,
        hasError:          false,
        opened,
        promptKey,
        fallbackPrompt:    state.latestPrompt,
        isSubagent:        origin.isSubagent,
        subagentType:      origin.subagentType,
        text:              null,
        parts:             [],
        details:           [],
      };
      calls.push(draft);
      callOrder.push(draft);
      return draft;
    };
    /** Adopt events logged before their completed API request. */
    const openApiCall = (): ClaudeCallDraft => {
      const pending = openCall();
      if (pending && !pending.opened && pending.text === null) {
        pending.opened = true;
        pending.model ??= r['model'] != null ? String(r['model']) : null;
        return pending;
      }
      return startCall(true);
    };

    if (event === CLAUDE_RESPONSE_EVENT) {
      const response = r['response'];
      if (typeof response !== 'string' || !response.trim()) { continue; }

      // Main-agent spans can recover prompts omitted from logs.
      const spanPrompt = cleanAgentPrompt(r['span_prompt']);
      if (spanPrompt) {
        state.latestPrompt = spanPrompt;
        promptByKey.set(promptKey, spanPrompt);
      }

      // Preserve a second response as a separate unlogged call.
      const inFlight = openCall();
      const call = inFlight && inFlight.text === null ? inFlight : startCall(false);
      call.text = response;
      call.model ??= r['model'] != null ? String(r['model']) : null;
      if (Number(r['severity_number'] ?? 0) >= 17) { call.hasError = true; }
      const section = detailSection('Response metadata', attributes, [
        ['request_id', 'Request ID'],
        ['message.uuid', 'Message ID'],
        ['query_source', 'Query source'],
        ['response_length', 'Response length'],
      ]);
      if (section) { call.details.push(section); }
      continue;
    }

    if (event === CLAUDE_API_EVENT
      || event === CLAUDE_API_ERROR_EVENT
      || event === CLAUDE_API_REFUSAL_EVENT) {
      // Each success, failure, or refusal opens one model call.
      const call = openApiCall();
      call.sourceSpanId = sources.modelCall(
        'claude',
        traceId,
        r['span_id'],
        r['timestamp_unix_nano'],
        attributes['request_id'],
      );
      const title = event === CLAUDE_API_EVENT
        ? 'API request'
        : (event === CLAUDE_API_ERROR_EVENT ? 'API error' : 'API refusal');
      const section = detailSection(title, attributes, CLAUDE_API_DETAIL_FIELDS);
      if (section) { call.details.push(section); }
      if (event !== CLAUDE_API_EVENT) { call.hasError = true; }
      continue;
    }

    // Attach other events to the active or next model call.
    {
      const call = openCall() ?? startCall(false);

      if (event === CLAUDE_TOOL_EVENT) {
        const toolName = detailValue(attributes['tool_name']) ?? 'tool';
        const callId = detailValue(attributes['tool_use_id']) ?? undefined;
        const args = attributes['tool_input'] ?? attributes['tool_parameters'] ?? null;
        const sourceSpanId = sources.toolCall('claude', traceId, {
          callId,
          toolName,
          timestampUnixNano: r['timestamp_unix_nano'],
        });
        call.parts.push({
          type: 'tool_call',
          name: toolName,
          id: callId,
          arguments: args,
          sourceSpanId,
        });
        call.parts.push({
          type: 'tool_call_response',
          id: callId,
          sourceSpanId,
          response: {
            success: attributes['success'] ?? null,
            duration_ms: attributes['duration_ms'] ?? null,
            error: attributes['error'] ?? attributes['error_type'] ?? null,
          },
        });
        const section = detailSection(`Tool result · ${toolName}`, attributes, CLAUDE_TOOL_DETAIL_FIELDS);
        if (section) { call.details.push(callId ? { ...section, partId: callId } : section); }
        if (!isAffirmative(attributes['success'])) { call.hasError = true; }
      } else if (event === CLAUDE_DECISION_EVENT) {
        const toolName = detailValue(attributes['tool_name']) ?? 'tool';
        const section = detailSection(`Tool decision · ${toolName}`, attributes, [
          ['tool_use_id', 'Call ID'],
          ['decision', 'Decision'],
          ['source', 'Source'],
          ['mcp_server_name', 'MCP server'],
          ['mcp_tool_name', 'MCP tool'],
        ]);
        if (section) { call.details.push(section); }
      } else if (event === CLAUDE_REQUEST_BODY_EVENT || event === CLAUDE_RESPONSE_BODY_EVENT) {
        const bodyDetails: Record<string, unknown> = { ...attributes };
        const rawBody = attributes['body'];
        if (typeof rawBody === 'string') {
          try {
            const body: unknown = JSON.parse(rawBody);
            if (body && typeof body === 'object' && !Array.isArray(body)) {
              const object = body as Record<string, unknown>;
              bodyDetails['system'] = object['system'];
              bodyDetails['max_tokens'] = object['max_tokens'];
              bodyDetails['temperature'] = object['temperature'];
              bodyDetails['top_p'] = object['top_p'];
              bodyDetails['stop_reason'] = object['stop_reason'];
              bodyDetails['usage'] = object['usage'];
              if (Array.isArray(object['tools'])) {
                bodyDetails['tool_names'] = object['tools'].map(tool =>
                  tool && typeof tool === 'object'
                    ? (tool as { name?: unknown }).name
                    : null).filter(name => name != null);
              }
            }
          } catch {
            // Body metadata remains available even when provider JSON is truncated.
          }
        }
        const section = detailSection(
          event === CLAUDE_REQUEST_BODY_EVENT ? 'API request context' : 'API response metadata',
          bodyDetails,
          [
            ['model', 'Model'],
            ['system', 'System prompt', 'json'],
            ['tool_names', 'Tools', 'json'],
            ['max_tokens', 'Maximum tokens'],
            ['temperature', 'Temperature'],
            ['top_p', 'Top P'],
            ['stop_reason', 'Stop reason'],
            ['usage', 'Usage', 'json'],
            ['body_ref', 'Body file', 'code'],
            ['body_length', 'Body length'],
            ['body_truncated', 'Truncated'],
          ],
        );
        if (section) { call.details.push(section); }
      }
    }
  }

  for (const call of callOrder) {
    // Ignore empty calls introduced by the join.
    if (call.text === null && !call.parts.length && !call.details.length) { continue; }
    turns.push({
      traceId:           call.traceId,
      spanId:            call.spanId,
      sourceSpanId:      call.sourceSpanId,
      spanName:          call.spanName,
      startTimeUnixNano: call.startTimeUnixNano,
      model:             call.model,
      hasError:          call.hasError,
      outputMessages:    call.text !== null
        ? appendOutputParts(claudeOutputMessages(call.text), call.parts)
        : JSON.stringify([{ role: 'assistant', parts: call.parts }]),
      // Prefer prompt text resolved later in the reply.
      inputPreview:      promptByKey.get(call.promptKey) ?? call.fallbackPrompt,
      inputContextMessages: null,
      systemInstructions: null,
      details:           compactDetails(call.details),
      isSubagent:        call.isSubagent,
      subagentType:      call.subagentType,
    });
  }

  return turns.sort((a, b) => {
    try {
      const left = BigInt(a.startTimeUnixNano);
      const right = BigInt(b.startTimeUnixNano);
      return left < right ? -1 : left > right ? 1 : 0;
    } catch {
      return Number(a.startTimeUnixNano) - Number(b.startTimeUnixNano);
    }
  });
}

/** One Codex model call reconstructed from logs. */
interface CodexTurnDraft {
  traceId: string;
  spanId: string;
  sourceSpanId: string | null;
  spanName: string;
  startTimeUnixNano: string;
  model: string | null;
  hasError: boolean;
  parts: Record<string, unknown>[];
  inputPreview: string | null;
  details: SessionMessageDetail[];
  /** Whether the first response event should replace the prompt timestamp. */
  awaitingReply: boolean;
}

function isAffirmative(v: unknown): boolean {
  return v === true || v === 1 || (typeof v === 'string' && v.toLowerCase() === 'true');
}

function nanosOf(value: unknown): bigint {
  try { return BigInt(String(value ?? '0')); } catch { return 0n; }
}

/** Rebuild Codex turns from prompt, tool, and usage logs. */
export function codexLogTurns(db: QueryableDB, traceIds: string[]): SessionMessageTurn[] {
  if (!traceIds.length) { return []; }
  const ph = traceIds.map(() => '?').join(',');
  const sources = createConversationSourceResolver(db, traceIds);

  const logRows = db.prepare(`
    SELECT
      id,
      trace_id,
      span_id,
      timestamp_unix_nano,
      json_extract(attributes,'$."event.name"')       AS event_name,
      json_extract(attributes,'$."model"')            AS model,
      json_extract(attributes,'$."prompt"')           AS prompt,
      json_extract(attributes,'$."tool_name"')        AS tool_name,
      json_extract(attributes,'$."call_id"')          AS call_id,
      json_extract(attributes,'$."arguments"')        AS arguments,
      json_extract(attributes,'$."output"')           AS output,
      json_extract(attributes,'$."success"')          AS success,
      json_extract(attributes,'$."conversation.id"')  AS conversation_id,
      attributes                                      AS attributes
    FROM logs
    WHERE trace_id IN (${ph})
      AND json_extract(attributes,'$."event.name"') IN (${Array(7).fill('?').join(',')})
  `).all(
    ...traceIds,
    CODEX_PROMPT_EVENT,
    CODEX_TOOL_EVENT,
    CODEX_DECISION_EVENT,
    CODEX_SANDBOX_EVENT,
    CODEX_START_EVENT,
    CODEX_TURN_COST_EVENT,
    CODEX_API_EVENT,
  );

  // Drop content-only echo traces before building turns.
  const conversational = new Set(logRows
    .filter(r => r['event_name'] === CODEX_PROMPT_EVENT || r['event_name'] === CODEX_API_EVENT)
    .map(r => String(r['trace_id'] ?? '')));
  const rows = logRows.filter(r => conversational.has(String(r['trace_id'] ?? '')));

  // Codex SSE usage has only a conversation id, so join it by conversation.
  const conversationIds = [...new Set(rows
    .map(r => (r['conversation_id'] != null ? String(r['conversation_id']) : ''))
    .filter(Boolean))];
  const usageRows = conversationIds.length ? db.prepare(`
    SELECT
      id,
      timestamp_unix_nano,
      json_extract(attributes,'$."event.name"')       AS event_name,
      json_extract(attributes,'$."model"')            AS model,
      json_extract(attributes,'$."conversation.id"')  AS conversation_id,
      attributes                                      AS attributes
    FROM logs
    WHERE json_extract(attributes,'$."conversation.id"')
          IN (${conversationIds.map(() => '?').join(',')})
      AND json_extract(attributes,'$."event.name"') = ?
      AND json_extract(attributes,'$."event.kind"') = ?
      -- Keep the completion record that carries usage.
      AND json_extract(attributes,'$."input_token_count"') IS NOT NULL
  `).all(...conversationIds, CODEX_SSE_EVENT, 'response.completed') : [];

  const ordered = [...rows, ...usageRows].sort((a, b) => {
    const left = nanosOf(a['timestamp_unix_nano']);
    const right = nanosOf(b['timestamp_unix_nano']);
    if (left !== right) { return left < right ? -1 : 1; }
    return Number(a['id'] ?? 0) - Number(b['id'] ?? 0);
  });

  const turns: SessionMessageTurn[] = [];
  const draftsByTrace = new Map<string, CodexTurnDraft>();
  const sessionDetailsByTrace = new Map<string, SessionMessageDetail[]>();
  /** Prompt shared by every model call in a reply. */
  const promptByTrace = new Map<string, string>();
  /** Pending call for conversation-scoped SSE usage. */
  const callByConversation = new Map<string, CodexTurnDraft>();

  // Keep prompt-only turns and calls with metadata but no captured prose.
  const flush = (traceId: string): void => {
    const draft = draftsByTrace.get(traceId);
    if (draft && (draft.inputPreview || draft.parts.length || draft.details.length)) {
      turns.push({
        traceId:           draft.traceId,
        spanId:            draft.spanId,
        sourceSpanId:      draft.sourceSpanId,
        spanName:          draft.spanName,
        startTimeUnixNano: draft.startTimeUnixNano,
        model:             draft.model,
        hasError:          draft.hasError,
        outputMessages:    JSON.stringify([{ role: 'assistant', parts: draft.parts }]),
        inputPreview:      draft.inputPreview,
        inputContextMessages: null,
        systemInstructions: null,
        // Keep the array live for late completion metadata.
        details:           draft.details,
        isSubagent:        false,
        subagentType:      null,
      });
    }
    draftsByTrace.delete(traceId);
  };

  for (const r of ordered) {
    const traceId = String(r['trace_id'] ?? '');
    const event = String(r['event_name'] ?? '');
    const nano  = String(r['timestamp_unix_nano'] ?? '0');
    const model = r['model'] != null ? String(r['model']) : null;
    const conversationId = r['conversation_id'] != null ? String(r['conversation_id']) : '';
    const attributes = parsedAttributes(r['attributes']);

    if (event === CODEX_START_EVENT) {
      sessionDetailsByTrace.set(traceId, compactDetails([
        detailSection('Session configuration', attributes, [
          ['provider_name', 'Provider'],
          ['model', 'Model'],
          ['slug', 'Model slug'],
          ['reasoning_effort', 'Reasoning effort'],
          ['reasoning_summary', 'Reasoning summary'],
          ['context_window', 'Context window'],
          ['auto_compact_token_limit', 'Auto-compact limit'],
          ['approval_policy', 'Approval policy'],
          ['sandbox_policy', 'Sandbox policy'],
          ['mcp_servers', 'MCP servers'],
          ['mcp_server_count', 'MCP server count'],
          ['originator', 'Originator'],
          ['terminal.type', 'Terminal'],
          ['app.version', 'Codex version'],
        ]),
      ]));
      continue;
    }

    if (event === CODEX_SSE_EVENT) {
      const call = callByConversation.get(conversationId);
      const section = call ? detailSection('Response usage', attributes, [
        ['input_token_count', 'Input tokens'],
        ['output_token_count', 'Output tokens'],
        ['cached_token_count', 'Cached tokens'],
        ['cache_write_token_count', 'Cache-write tokens'],
        ['reasoning_token_count', 'Reasoning tokens'],
        ['tool_token_count', 'Total tokens'],
        ['ttft_ms', 'Time to first token (ms)'],
        ['service_tier', 'Service tier'],
        ['model_reasoning_effort', 'Reasoning effort'],
      ]) : null;
      if (call && section) { call.details.push(section); }
      continue;
    }

    if (event === CODEX_PROMPT_EVENT) {
      flush(traceId);
      const text = cleanAgentPrompt(r['prompt']);
      if (!text) { continue; }   // pure context injection; nothing user-authored
      promptByTrace.set(traceId, text);
      draftsByTrace.set(traceId, {
        traceId,
        spanId:            String(r['span_id'] ?? ''),
        sourceSpanId:      null,
        spanName:          event,
        startTimeUnixNano: nano,
        model,
        hasError:          false,
        parts:             [],
        inputPreview:      text,
        details:           sessionDetailsByTrace.get(traceId) ?? [],
        awaitingReply:     true,
      });
      sessionDetailsByTrace.delete(traceId);
      continue;
    }

    // Split each Codex API request into a model call within the reply.
    if (event === CODEX_API_EVENT && !draftsByTrace.get(traceId)?.awaitingReply) {
      flush(traceId);
    }

    // Create a call for resumed or promptless activity when needed.
    let draft = draftsByTrace.get(traceId);
    if (!draft) {
      draft = {
        traceId,
        spanId:            String(r['span_id'] ?? ''),
        sourceSpanId:      null,
        spanName:          event,
        startTimeUnixNano: nano,
        model,
        hasError:          false,
        parts:             [],
        inputPreview:      promptByTrace.get(traceId) ?? null,
        details:           sessionDetailsByTrace.get(traceId) ?? [],
        awaitingReply:     false,
      };
      draftsByTrace.set(traceId, draft);
      sessionDetailsByTrace.delete(traceId);
    }
    if (draft.awaitingReply) {
      draft.startTimeUnixNano = nano;
      draft.awaitingReply     = false;
    }
    if (event === CODEX_API_EVENT) {
      draft.sourceSpanId = sources.modelCall('codex', traceId, r['span_id'], r['timestamp_unix_nano']);
    }
    if (!draft.model) { draft.model = model; }

    const callId = r['call_id'] != null ? String(r['call_id']) : undefined;
    const toolName = r['tool_name'] != null ? String(r['tool_name']) : 'tool';

    /** Attach metadata to its tool call when possible. */
    const pushCallDetail = (section: SessionMessageDetail | null): void => {
      if (!section) { return; }
      draft.details.push(callId ? { ...section, partId: callId } : section);
    };

    if (event === CODEX_TOOL_EVENT) {
      if (!isAffirmative(r['success'])) { draft.hasError = true; }
      const sourceSpanId = sources.toolCall('codex', traceId, {
        callId,
        toolName,
        timestampUnixNano: r['timestamp_unix_nano'],
      });

      // Match the call/result shape used by captured output messages.
      draft.parts.push({
        type:      'tool_call',
        id:        callId,
        name:      toolName,
        arguments: r['arguments'] != null ? String(r['arguments']) : null,
        sourceSpanId,
      });
      if (r['output'] != null) {
        draft.parts.push({
          type: 'tool_call_response',
          id: callId,
          response: String(r['output']),
          sourceSpanId,
        });
      }
      pushCallDetail(detailSection(`Tool result · ${toolName}`, attributes, [
        ['call_id', 'Call ID'],
        ['success', 'Success'],
        ['duration_ms', 'Duration (ms)'],
        ['mcp_server', 'MCP server'],
        ['mcp_server_origin', 'MCP server origin'],
      ]));
    } else if (event === CODEX_DECISION_EVENT) {
      pushCallDetail(detailSection(`Tool decision · ${toolName}`, attributes, [
        ['call_id', 'Call ID'],
        ['decision', 'Decision'],
        ['source', 'Source'],
      ]));
    } else if (event === CODEX_SANDBOX_EVENT) {
      pushCallDetail(detailSection(`Sandbox outcome · ${toolName}`, attributes, [
        ['call_id', 'Call ID'],
        ['outcome', 'Outcome'],
        ['initial_duration_ms', 'Initial duration (ms)'],
        ['escalated_duration_ms', 'Escalated duration (ms)'],
      ]));
    } else if (event === CODEX_API_EVENT) {
      if (conversationId) { callByConversation.set(conversationId, draft); }
      const section = detailSection('API request', attributes, [
        ['model', 'Model'],
        ['endpoint', 'Endpoint'],
        ['http.response.status_code', 'Status'],
        ['attempt', 'Attempts'],
        ['duration_ms', 'Duration (ms)'],
      ]);
      if (section) { draft.details.push(section); }
    } else if (event === CODEX_TURN_COST_EVENT) {
      const section = detailSection('Turn cost', attributes, [
        ['turn.id', 'Turn ID'],
        ['usage.estimated_usd', 'Estimated cost (USD)'],
        ['turn.interrupted', 'Interrupted'],
        ['speed', 'Speed'],
        ['reasoning_effort', 'Reasoning effort'],
      ]);
      if (section) { draft.details.push(section); }
    }
  }
  for (const traceId of draftsByTrace.keys()) { flush(traceId); }

  return turns.sort((a, b) => {
    try {
      const left = BigInt(a.startTimeUnixNano);
      const right = BigInt(b.startTimeUnixNano);
      return left < right ? -1 : left > right ? 1 : 0;
    } catch {
      return Number(a.startTimeUnixNano) - Number(b.startTimeUnixNano);
    }
  });
}

/** Returns normalized captured turns, or null when the session does not exist. */
export function getSessionMessages(db: QueryableDB, sessionId: string): SessionMessages | null {
  if (!sessionId?.trim()) { return null; }
  const id = sessionId.trim();

  const traceRows = db.prepare(`
    WITH ${TRACE_SESSION_CTE}
    SELECT trace_id FROM trace_session WHERE session_id = ?
  `).all(id);

  if (!traceRows.length) { return null; }

  const traceIds = traceRows.map(r => String(r['trace_id'] ?? ''));
  const ph = traceIds.map(() => '?').join(',');

  const rows = db.prepare(`
    SELECT
      s.trace_id,
      s.span_id,
      s.name,
      s.start_time_unix_nano,
      s.status_code,
      json_extract(s.attributes,'$."gen_ai.request.model"')   AS model,
      json_extract(s.attributes,'$."gen_ai.output.messages"')  AS output_messages,
      json_extract(s.attributes,'$."gen_ai.input.messages"')   AS input_messages,
      json_extract(s.attributes,'$."gen_ai.system_instructions"') AS system_instructions,
      s.attributes,${SUBAGENT_SELECT}
    FROM spans s
    ${SUBAGENT_JOIN}
    WHERE s.trace_id IN (${ph})
      AND ${llmPredicate('s.')}
      AND json_extract(s.attributes,'$."gen_ai.output.messages"') IS NOT NULL
    ORDER BY s.start_time_unix_nano ASC
  `).all(...traceIds);

  const sources = createConversationSourceResolver(db, traceIds);
  const turns: SessionMessageTurn[] = rows.map(r => ({
    traceId:           String(r['trace_id'] ?? ''),
    spanId:            String(r['span_id'] ?? ''),
    sourceSpanId:      r['span_id'] != null ? String(r['span_id']) : null,
    spanName:          String(r['name'] ?? ''),
    startTimeUnixNano: String(r['start_time_unix_nano'] ?? '0'),
    model:             r['model'] != null ? String(r['model']) : null,
    hasError:          Number(r['status_code'] ?? 0) === 2,
    outputMessages:    sources.enrichSpanMessages(
      String(r['trace_id'] ?? ''),
      String(r['span_id'] ?? ''),
      String(r['output_messages'] ?? ''),
    ),
    inputPreview:      lastUserPrompt(r['input_messages']),
    ...spanMessageRichData(r),
    ...spanTurnOrigin(r),
  }));

  // Prefer span content, then Claude logs, then Codex logs.
  const resolved = turns.length ? turns : (() => {
    const claude = claudeLogTurns(db, traceIds);
    return claude.length ? claude : codexLogTurns(db, traceIds);
  })();

  return { sessionId: id, captureEnabled: resolved.length > 0, turns: resolved };
}
