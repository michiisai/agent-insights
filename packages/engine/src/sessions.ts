import { AGENT_HOST_SERVICE_NAME } from '@agent-insights/types';
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
 * Standalone metadata span the agent host emits when a session's title changes.
 * Carries `gen_ai.conversation.id` plus the title on its own synthetic trace id.
 * Requires `chat.agentHost.otel.captureContent` and is absent on older VS Code
 * builds, so titles are always optional.
 */
export { SESSION_TITLE_SPAN_NAME } from '@agent-insights/receiver';
import { SESSION_TITLE_SPAN_NAME, SESSION_URI_ATTR } from '@agent-insights/receiver';
import {
  CLAUDE_TOOL_EXECUTION_SPAN,
  CLAUDE_TOOL_SPAN,
  toolCallErrorSql,
} from './toolCalls';

/** Conversation key the agent host and every provider agree on. */
const SESSION_ID_ATTR = 'gen_ai.conversation.id';

/** Codex's content log events — see `codexLogTurns` for what they carry. */
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

/** Scheme of a session URI (`claude:/…` → `claude`), or NULL. Mirrors the
 *  receiver's projection into `session_titles`, but applied to any span carrying
 *  the URI rather than only the title span — see `loadSessionAgents`. */
const SESSION_URI_SCHEME_EXPR = `NULLIF(
  substr(
    json_extract(attributes, '$."${SESSION_URI_ATTR}"'),
    1,
    instr(COALESCE(json_extract(attributes, '$."${SESSION_URI_ATTR}"'), ''), ':') - 1
  ), '')`;

/**
 * Resolves a grouped trace to a span key, Codex log alias, or trace id.
 * Requires `GROUP BY trace_id` because the span-key arms use MAX.
 */
export const sessionIdExpr = (alias = 'spans'): string => `COALESCE(
  MAX(json_extract(attributes,'$."gen_ai.conversation.id"')),
  MAX(json_extract(attributes,'$."session.id"')),
  MAX(json_extract(attributes,'$."copilot_chat.chat_session_id"')),
  (SELECT c.session_id FROM codex_trace_sessions c WHERE c.trace_id = ${alias}.trace_id),
  trace_id
)`;

export const SESSION_ID_EXPR = sessionIdExpr();

/**
 * Whether any span in a trace carries a conversation/session id. Resolved at
 * trace level (the key is on `chat`, not `permission`/`execute_tool`) as an
 * uncorrelated subquery, so it works in a per-span WHERE where aggregates don't.
 */
const TRACE_IS_KEYED = `trace_id IN (
  SELECT trace_id FROM spans
  GROUP BY trace_id
  HAVING MAX(json_extract(attributes,'$."gen_ai.conversation.id"'))       IS NOT NULL
      OR MAX(json_extract(attributes,'$."session.id"'))                   IS NOT NULL
      OR MAX(json_extract(attributes,'$."copilot_chat.chat_session_id"')) IS NOT NULL
)`;

/**
 * Codex wraps one model call in a chain of same-count nested spans
 * (`run_sampling_request` → `try_run_sampling_request` → `stream_request` →
 * `model_client.stream_responses_api` → `responses.stream_request`). Only the
 * outermost is counted; matching the chain would report five requests per call.
 */
const CODEX_LLM_SPAN = 'run_sampling_request';

/**
 * Span-name predicate: an LLM request/chat turn. Covers the agent host and
 * Copilot (`chat <model>`), Claude (`claude_code.llm_request`) and Codex.
 * Takes an alias for queries joining a second copy of `spans`, where a bare
 * `name` is ambiguous.
 */
export const llmPredicate = (alias = '') => `(
  ${alias}name LIKE 'chat %'
  OR ${alias}name = 'chat'
  OR ${alias}name LIKE '%llm_request%'
  OR ${alias}name = '${CODEX_LLM_SPAN}'
)`;
export const LLM_PREDICATE = llmPredicate();

/** Log events that show a conversation happened on a trace: someone typed
 *  something, or the model was called — including the calls that failed. */
const CONVERSATION_EVENTS = [
  CODEX_PROMPT_EVENT, CODEX_API_EVENT,
  CLAUDE_PROMPT_EVENT, CLAUDE_RESPONSE_EVENT, CLAUDE_API_EVENT,
  CLAUDE_API_ERROR_EVENT, CLAUDE_API_REFUSAL_EVENT,
];

/** Every log event a harness reports conversation content on. The trace-less
 *  SSE stream is left out: it joins by conversation, never by trace. */
const CONTENT_EVENTS = [
  ...CONVERSATION_EVENTS,
  CODEX_TOOL_EVENT, CODEX_DECISION_EVENT, CODEX_SANDBOX_EVENT,
  CODEX_START_EVENT, CODEX_TURN_COST_EVENT,
  CLAUDE_TOOL_EVENT, CLAUDE_DECISION_EVENT,
  CLAUDE_REQUEST_BODY_EVENT, CLAUDE_RESPONSE_BODY_EVENT,
];

const sqlList = (values: string[]): string => values.map(v => `'${v}'`).join(',');

/**
 * Excludes duplicate tool-only traces with content but no prompt, round trip, or
 * model call. The model-call check preserves conversations whose logs were pruned.
 */
const ECHO_TRACE = `(trace_id IN (
    SELECT l.trace_id FROM logs l
    WHERE json_extract(l.attributes,'$."event.name"') IN (${sqlList(CONTENT_EVENTS)})
    GROUP BY l.trace_id
    HAVING SUM(json_extract(l.attributes,'$."event.name"')
               IN (${sqlList(CONVERSATION_EVENTS)})) = 0
  ) AND trace_id NOT IN (
    SELECT trace_id FROM spans WHERE ${LLM_PREDICATE}
  ))`;

/**
 * Excludes unkeyed utility traces, title metadata, and duplicate tool echoes.
 * Keyed copilot-chat traces remain because they can represent real sessions.
 */
export const SESSION_TRACE_FILTER =
  `(service_name != 'copilot-chat' OR ${TRACE_IS_KEYED})
   AND name != '${SESSION_TITLE_SPAN_NAME}'
   AND NOT ${ECHO_TRACE}`;

/** Host metadata on provider traces: retain for identity, exclude from activity. */
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

  // Mirrors SESSION_TRACE_FILTER, correlated to this one trace instead of
  // scanning every trace in the store.
  const row = db.prepare(`
    SELECT ${sessionIdExpr('s')} AS session_id
      FROM spans s
     WHERE s.trace_id = ?
        AND (s.service_name != 'copilot-chat'
             OR s.name = '${SESSION_TITLE_SPAN_NAME}'
             OR EXISTS (
               SELECT 1 FROM spans k
               WHERE k.trace_id = s.trace_id
                 AND (json_extract(k.attributes,'$."gen_ai.conversation.id"')       IS NOT NULL
                   OR json_extract(k.attributes,'$."session.id"')                   IS NOT NULL
                   OR json_extract(k.attributes,'$."copilot_chat.chat_session_id"') IS NOT NULL)
             ))
     GROUP BY s.trace_id
  `).get(id);
  return row?.['session_id'] != null ? String(row['session_id']) : null;
}

/**
 * Codex's per-tool-call span, emitted once per call the model asked for, under
 * `handle_output_item_done`. Two nearby spans are deliberately not used:
 * `build_tool_call` fires while assembling calls off the stream and overcounts,
 * and `handle_tool_call_with_source` also appears as an orphaned root for
 * standalone tool invocations no model turn drove — counting those would make
 * `AGENT_ACTIVITY` promote background traces into the session list. Within real
 * conversation traces this matches Codex's own `codex.tool_result` log records
 * exactly.
 */
const CODEX_TOOL_SPAN = 'handle_tool_call';

/**
 * Claude's per-tool-call span. Its children (`claude_code.tool.execution`,
 * `claude_code.tool.blocked_on_user`) are deliberately excluded: matching the
 * subtree would treble the count, and counting `.execution` alone silently
 * drops every tool call denied at the permission prompt — those produce a
 * `claude_code.tool` span with no execution child. Matched exactly, never as a
 * prefix, for the same reason.
 */
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

/**
 * Resolves navigation provenance independently from transcript provenance.
 * A log's span id only says where it was recorded; these methods return a span
 * only when one candidate represents the particular model/tool call.
 */
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
    // Codex's provider spans overlap broadly; without ancestry, a timestamp can
    // land inside an unrelated sampling request and is not proof of identity.
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

// Attribute the `Agent` tool span carries naming the kind of subagent it launched.
const SUBAGENT_TYPE_ATTR = 'subagent_type';

// Attribute stamped on every span a subagent produces; presence, not value, is
// the test — the main agent's spans lack it entirely.
export const SUBAGENT_ID_ATTR = 'agent_id';

// Copilot only ever *names* a delegated agent — the user's own gets
// `github.copilot.default` and no name — so a named `invoke_agent` is the marker.
export const AGENT_NAME_ATTR = 'gen_ai.agent.name';

/** Columns `spanTurnOrigin` reads. Requires the turn's span aliased `s`, its parent `p`. */
export const SUBAGENT_SELECT = `
      json_extract(s.attributes,'$."${SUBAGENT_ID_ATTR}"')  AS agent_id,
      p.name                                                AS parent_name,
      json_extract(p.attributes,'$."${AGENT_NAME_ATTR}"')   AS parent_agent_name`;

export const SUBAGENT_JOIN = `LEFT JOIN spans p ON p.trace_id = s.trace_id AND p.span_id = s.parent_span_id`;

/**
 * Whether a span-attribute turn came from a subagent, and of what kind. Claude
 * stamps `agent_id` on the subagent's spans; Copilot nests the run under
 * `invoke_agent <name>`. Codex is in neither arm — it delegates to nothing.
 *
 * The `invoke_agent` parent is required: Copilot's utility LM callers
 * (`copilotLanguageModelWrapper`, `XtabProvider`) carry an agent name on the
 * chat span itself and are nobody's subagent.
 */
export function spanTurnOrigin(row: Record<string, unknown>): { isSubagent: boolean; subagentType: string | null } {
  if (row['agent_id'] != null) { return { isSubagent: true, subagentType: null }; }

  const agentName = row['parent_agent_name'] != null ? String(row['parent_agent_name']).trim() : '';
  const underInvoke = String(row['parent_name'] ?? '').startsWith('invoke_agent');
  return agentName && underInvoke
    ? { isSubagent: true, subagentType: agentName }
    : { isSubagent: false, subagentType: null };
}

/**
 * Span-name predicate: a single tool call. Each harness contributes exactly one
 * span per call — see the constants above for the wrapper/child spans each one
 * deliberately leaves out.
 */
const TOOL_PREDICATE = `(
  name LIKE 'execute_tool%'
  OR name = '${CLAUDE_TOOL_SPAN}'
  OR name = '${CODEX_TOOL_SPAN}'
)`;

/**
 * Prompt/completion token attributes, in priority order — emitters disagree on
 * the key: the agent host uses OTel GenAI semconv (`gen_ai.usage.*`), others
 * `llm.usage.*`, and Claude Code bare `input_tokens`/`output_tokens`. Mirrors
 * metrics.ts so sessions and Home totals agree. Cache read/creation tokens are
 * excluded: they are tracked separately, and are additive for Anthropic rather
 * than a subset.
 */
const inputTokensExpr = (alias = '') => `COALESCE(
  CAST(json_extract(${alias}attributes,'$."gen_ai.usage.input_tokens"') AS INTEGER),
  CAST(json_extract(${alias}attributes,'$."llm.usage.prompt_tokens"')   AS INTEGER),
  CAST(json_extract(${alias}attributes,'$."input_tokens"')              AS INTEGER),
  0
)`;
const outputTokensExpr = (alias = '') => `COALESCE(
  CAST(json_extract(${alias}attributes,'$."gen_ai.usage.output_tokens"')   AS INTEGER),
  CAST(json_extract(${alias}attributes,'$."llm.usage.completion_tokens"')  AS INTEGER),
  CAST(json_extract(${alias}attributes,'$."output_tokens"')                AS INTEGER),
  0
)`;
const INPUT_TOKENS_EXPR = inputTokensExpr();
const OUTPUT_TOKENS_EXPR = outputTokensExpr();

/**
 * A span reporting someone else's tokens. `invoke_agent` carries the subagent's
 * totals as an exact roll-up of the `chat` spans nested under it in the same
 * trace, so counting both doubles every subagent token. COALESCE keeps
 * `NOT (...)` from also rejecting spans that name no operation.
 */
const rollupPredicate = (alias = '') =>
  `COALESCE(json_extract(${alias}attributes,'$."gen_ai.operation.name"'), '') = 'invoke_agent'`;

/** Token attributes summed for the session token total, roll-ups excluded. */
const TOKENS_EXPR = `(CASE WHEN ${rollupPredicate()} THEN 0
                           ELSE ${INPUT_TOKENS_EXPR} + ${OUTPUT_TOKENS_EXPR} END)`;

/** Model attribute for a token-bearing span, across emitter conventions. */
const modelExpr = (alias = '') => `COALESCE(
  json_extract(${alias}attributes,'$."gen_ai.request.model"'),
  json_extract(${alias}attributes,'$."gen_ai.response.model"'),
  json_extract(${alias}attributes,'$."llm.model"'),
  json_extract(${alias}attributes,'$."model"')
)`;
const MODEL_EXPR = modelExpr();

/**
 * Nearest ancestor naming a model, for spans that carry usage but no name —
 * Codex puts usage on `handle_responses` and the model on the
 * `run_sampling_request` chain above it. Mirrors the receiver's `token_facts`
 * harvest. Correlated to `s`, so the caller must alias its spans table that way.
 */
const ANCESTOR_MODEL_EXPR = `(
  WITH RECURSIVE model_ancestors(trace_id, parent_span_id, attributes, depth) AS (
    SELECT parent.trace_id, parent.parent_span_id, parent.attributes, 1
      FROM spans parent
     WHERE parent.trace_id = s.trace_id
       AND parent.span_id  = s.parent_span_id
    UNION ALL
    SELECT parent.trace_id, parent.parent_span_id, parent.attributes, ancestor.depth + 1
      FROM spans parent
      JOIN model_ancestors ancestor
        ON parent.trace_id = ancestor.trace_id
       AND parent.span_id  = ancestor.parent_span_id
     WHERE ancestor.depth < 64
  )
  SELECT ${modelExpr('ancestor.')}
    FROM model_ancestors ancestor
   WHERE ${modelExpr('ancestor.')} IS NOT NULL
   ORDER BY ancestor.depth
   LIMIT 1
)`;

/** The model a token-bearing span reports for, named here or by an ancestor. */
const TOKEN_MODEL_EXPR = `COALESCE(${modelExpr('s.')}, ${ANCESTOR_MODEL_EXPR})`;

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
 * Every distinct failure (errored span name + message, with an occurrence
 * count) for the given sessions, oldest first. A session spans many traces and
 * each can fail more than once, so failures are collected across the whole
 * session rather than reduced to one representative message.
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

  // Codex emits no title span and captures no span content, so neither source
  // above fires and every Codex session would list as untitled. Its opening
  // prompt is a log record instead — as Claude's is when its span recorded none.
  const stillUntitled = sessionIds.filter(id => id && !titles.has(id));
  for (const [sid, prompt] of loadLoggedOpeningPrompts(db, stillUntitled)) {
    titles.set(sid, prompt);
  }
  return titles;
}

/**
 * Which agent the VS Code agent host ran, per session id — the scheme of the
 * session URI (`claude` | `codex` | `copilotcli`).
 *
 * Separate from `loadSessionTitles`, which falls back to the opening prompt when
 * no title span exists; agent kind has no such fallback, and a session with no
 * URI anywhere is reported by service name instead.
 *
 * Not derivable from `service_name`, which is whatever the agent stamped on
 * itself (`claude` → `claude-code`, `copilotcli` → `github-copilot`, `codex` →
 * `codex-app-server`). This is the host's own name for the plugin, joined on the
 * conversation id.
 *
 * `session_titles` is the durable source — it outlives the span it came from —
 * but is fed only by title spans, which the host emits for some agents and not
 * others (Codex gets none). The session anchor carries the same URI, so it is
 * the fallback: evictable by retention, but the difference between an agent
 * badge and none at all.
 */
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

/** How many opening prompts to consider before giving up on a label. The first
 *  record is often pure context injection, which cleans away to nothing. */
const OPENING_PROMPT_LOOKAHEAD = 5;

/**
 * Opening user prompt per session, from its earliest prompt log records.
 *
 * Logs are the only content channel some harnesses have: Codex captures no span
 * content, and Claude records a prompt on its span only sometimes. So this is
 * the last label source before a session lists as untitled.
 *
 * Reads the first few records rather than only the first, taking the earliest
 * with anything user-authored left after cleaning — a session commonly opens
 * with a record that is entirely injected context.
 */
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
      JOIN (
        SELECT trace_id, ${SESSION_ID_EXPR} AS session_id
        FROM spans
        WHERE ${SESSION_TRACE_FILTER}
        GROUP BY trace_id
      ) ts ON ts.trace_id = l.trace_id
      WHERE ts.session_id IN (${ph})
        AND json_extract(l.attributes,'$."event.name"') IN (${USER_PROMPT_EVENTS})
    ) WHERE rn <= ${OPENING_PROMPT_LOOKAHEAD}
    ORDER BY rn ASC
  `).all(...sessionIds);

  for (const r of rows) {
    const sid = String(r['session_id'] ?? '');
    if (!sid || prompts.has(sid)) { continue; }   // ordered by rn: first wins
    const text = promptLabel(r['prompt']);
    if (text) { prompts.set(sid, text); }
  }
  return prompts;
}

/**
 * Signals that a trace did agent work, independent of any conversation key.
 * Used to decide whether a trace is a real (if unlabelled) session or runtime
 * housekeeping — see BACKGROUND_TRACE_FILTER.
 */
const AGENT_ACTIVITY = `(
  COALESCE(SUM(llm_count), 0)   > 0
  OR COALESCE(SUM(tool_count), 0)  > 0
  OR COALESCE(SUM(token_sum), 0)   > 0
  OR COALESCE(SUM(error_count), 0) > 0
)`;

/** Log events carrying something a person actually typed. */
const USER_PROMPT_EVENTS = `'user_prompt', '${CODEX_PROMPT_EVENT}'`;

/** Log-based prompt signal, precomputed once so per-span checks do not rescan logs. */
const TRACE_HAS_USER_PROMPT = `(trace_id IN (SELECT trace_id FROM prompt_traces))`;

/** Every trace that captured a user prompt, collected in one pass. Must be
 *  declared as the first CTE of any query using TRACE_HAS_USER_PROMPT. */
const PROMPT_TRACES_CTE = `prompt_traces AS (
  SELECT DISTINCT trace_id FROM logs
   WHERE trace_id IS NOT NULL
     AND json_extract(attributes,'$."event.name"') IN (${USER_PROMPT_EVENTS})
)`;

/** Whether the agent host ever named this session — see BACKGROUND_TRACE_FILTER. */
const SESSION_IS_TITLED = `session_id IN (SELECT session_id FROM session_titles)`;

/**
 * Keeps only sessions with agent work, a captured prompt, or a title. Excluded
 * startup and housekeeping traces remain available in the Traces tab.
 */
const BACKGROUND_TRACE_FILTER =
  `(${AGENT_ACTIVITY} OR MAX(has_user_prompt) = 1 OR ${SESSION_IS_TITLED})`;

/** Diagnostic totals for traces excluded from Sessions by BACKGROUND_TRACE_FILTER. */
export function getBackgroundTraceStats(db: QueryableDB): BackgroundTraceStats {
  const rows = db.prepare(`
    WITH ${PROMPT_TRACES_CTE},
    trace_session AS (
      SELECT
        trace_id,
        ${SESSION_ID_EXPR}                                 AS session_id,
        ${AGENT_SERVICE_NAME}                              AS service_name,
        MAX(${TRACE_HAS_USER_PROMPT})                      AS has_user_prompt,
        ${AGENT_SPAN_COUNT}                                AS span_count,
        SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END)   AS error_count,
        SUM(CASE WHEN ${LLM_PREDICATE}  THEN 1 ELSE 0 END) AS llm_count,
        SUM(CASE WHEN ${TOOL_PREDICATE} THEN 1 ELSE 0 END) AS tool_count,
        SUM(${TOKENS_EXPR})                                AS token_sum
      FROM spans
      WHERE ${SESSION_TRACE_FILTER}
      GROUP BY trace_id
    ),
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

/**
 * Lists agent sessions — conversations grouping multiple traces — newest first.
 * Each row aggregates the session's traces/spans, LLM-request and tool-call
 * counts, distinct models, token total, and failure state.
 *
 * Unidentified, inactive traces are excluded (see BACKGROUND_TRACE_FILTER); they
 * remain visible in the Traces tab.
 */
export function getSessions(db: QueryableDB, opts: GetSessionsOptions = {}): Session[] {
  const { limit = 500, errorsOnly, nameSearch, sortOrder = 'desc' } = opts;

  const params: unknown[] = [];

  // Per-trace search: match a session if any of its traces matches the term
  // (trace id, span name, span id, or attribute values). Titles are unreachable
  // that way — title spans sit on a trace SESSION_TRACE_FILTER excludes — so
  // matching sessions are resolved separately.
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
    WITH ${PROMPT_TRACES_CTE},
    trace_session AS (
      SELECT
        trace_id,
        ${SESSION_ID_EXPR}                       AS session_id,
        ${AGENT_SERVICE_NAME}                    AS service_name,
        MAX(${TRACE_HAS_USER_PROMPT})            AS has_user_prompt,
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
    HAVING ${BACKGROUND_TRACE_FILTER}${errorsOnly ? ' AND SUM(error_count) > 0' : ''}
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
  const agentsBySession = loadSessionAgents(db, rows.map(r => String(r['session_id'] ?? '')));

  return rows.map(r => {
    const startNano = String(r['start_time_unix_nano'] ?? '0');
    const endNano   = String(r['end_time_unix_nano']   ?? '0');
    const sessionId = String(r['session_id'] ?? '');
    const failures  = failuresBySession.get(sessionId) ?? [];
    return {
      sessionId,
      title:             titlesBySession.get(sessionId) ?? null,
      agent:             agentsBySession.get(sessionId) ?? null,
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
  //    The agent host parents provider spans under its own session anchor, so
  //    "parentless" alone would name every turn after the host. The turn's root
  //    is the earliest span whose parent is a host span, is missing from the
  //    store (retention evicts the anchor first), or absent entirely.
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

  // 3) Tool usage by name. Each harness names the tool somewhere different:
  //    Copilot and the agent host use `gen_ai.tool.name`, Claude a bare
  //    `tool_name`, and Codex names neither — it puts the tool in a *descendant
  //    span's name* (`handle_tool_call` → `…_with_source` → `exec`/`readPage`).
  //    Without that lookup every Codex and Claude call collapses into a single
  //    row named after the wrapper span, which is a count with no breakdown.
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
      )                                                 AS tool_name,
      COUNT(*)                                          AS cnt,
      SUM(CASE WHEN ${toolCallErrorSql('spans.')} THEN 1 ELSE 0 END) AS err
    FROM spans
    WHERE trace_id IN (${ph}) AND ${TOOL_PREDICATE}
    GROUP BY tool_name
    ORDER BY cnt DESC
  `).all(...traceIds).map(r => ({
    toolName:   String(r['tool_name'] ?? ''),
    count:      Number(r['cnt'] ?? 0),
    errorCount: Number(r['err'] ?? 0),
  }));

  // 4) Token usage by model. Codex splits the two: usage on `handle_responses`,
  //    the call itself on `run_sampling_request`. Each is counted from whichever
  //    span carries it, then folded together by model. Copilot and Claude report
  //    both on one span, which lands in exactly one branch each.
  const modelTokens: SessionModelTokens[] = db.prepare(`
    SELECT
      model,
      SUM(input_tokens)  AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(calls)         AS calls
    FROM (
      SELECT
        ${TOKEN_MODEL_EXPR}        AS model,
        ${inputTokensExpr('s.')}   AS input_tokens,
        ${outputTokensExpr('s.')}  AS output_tokens,
        0                          AS calls
      FROM spans s
      WHERE s.trace_id IN (${ph})
        AND ${inputTokensExpr('s.')} + ${outputTokensExpr('s.')} > 0
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
    agent:             loadSessionAgents(db, [id]).get(id) ?? null,
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

/** Texts of the `user`-role messages in a raw `gen_ai.input.messages` JSON
 *  string, ordered from the start or the end of the conversation. */
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

/**
 * Input context that is not already represented by the turn transcript.
 * Providers replay the full conversation on every request; returning that array
 * per turn makes payload and DOM size quadratic. Keep only system/developer
 * messages and user-role messages that contain injection but no authored prompt.
 */
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

/**
 * Latest user prompt, anchoring each assistant turn to the prompt that produced
 * it. Left as captured, scaffolding and all: the webview renders the harness's
 * context blocks as collapsed, labelled sections, so a transcript is better off
 * keeping them. Only labels (see `promptLabel`) strip them.
 *
 * The *last* user message is not always the person's: a session's opening
 * request ends with a separate, scaffolding-only user message declaring the
 * deferred tool manifest, so taking the last one outright showed a reminder and
 * silently dropped the question above it. Messages that clean away to nothing
 * are skipped, the same lookahead `firstUserPrompt` already does for labels.
 *
 * Deliberately uncapped, matching the `outputMessages` it renders beside. A cap
 * truncated from the front, and the host's injected context leads and dwarfs any
 * budget — so the cut landed inside the scaffolding and what the person actually
 * typed never survived. Length is a display concern, and the webview already
 * collapses long messages behind a "Show full message" toggle.
 */
export function lastUserPrompt(inputMessagesJson: unknown): string | null {
  const texts = userMessageTexts(inputMessagesJson, 'last');
  for (const raw of texts) {
    if (stripAgentContext(raw, true)) { return raw; }
  }
  // Every user message was pure injection: keep the last rather than render an
  // empty bubble, since something was genuinely sent.
  return texts[0] ?? null;
}

/**
 * Opening user prompt, used as a session label when no title was reported. A
 * message that is nothing but injected context cleans away to nothing, so the
 * next user message in the same span gets a turn — the span-content analogue of
 * OPENING_PROMPT_LOOKAHEAD on the log path.
 */
function firstUserPrompt(inputMessagesJson: unknown): string | null {
  for (const raw of userMessageTexts(inputMessagesJson, 'first')) {
    const text = promptLabel(raw);
    if (text) { return text; }
  }
  return null;
}

/**
 * Claude prompts come from span attributes and replies from same-span log events.
 * Match event content rather than user-overridable service names.
 */
const AGENT_REPOSITORY_CONTEXT_BLOCK = [
  'Repository name:[^\\r\\n]*',
  'Owner:[^\\r\\n]*',
  'Current branch:[^\\r\\n]*',
  'Default branch:[^\\r\\n]*',
].join('\\r?\\n');

/**
 * Matches stacked host repository blocks separated by one or two newlines.
 * The trailing paragraph/message boundary avoids stripping ordinary prose.
 */
const AGENT_REPOSITORY_CONTEXT = new RegExp(
  `(^|(?:\\r?\\n){1,2})` +
  `${AGENT_REPOSITORY_CONTEXT_BLOCK}(?:(?:\\r?\\n){1,2}${AGENT_REPOSITORY_CONTEXT_BLOCK})*` +
  `(?=(?:\\r?\\n){2}|\\s*$)`,
  'g',
);

/** Removes isolated host-injected context while preserving user-authored prose. */
function cleanAgentPrompt(raw: unknown): string | null {
  if (typeof raw !== 'string') { return null; }
  return stripAgentContext(raw, false) || null;
}

/**
 * Matches balanced, line-isolated context tags for label cleanup. Case-sensitive
 * backreferences leave mismatched or inline prose untouched.
 */
const AGENT_CONTEXT_BLOCK =
  /(^|\r?\n)[ \t]*<([a-zA-Z][a-zA-Z0-9_-]*)(?:[ \t]+[^<>\r\n]*?)?>[\s\S]*?<\/\2>[ \t]*(?=\r?\n|$)/g;

/** How much of a captured prompt a session label may use. */
const PROMPT_LABEL_MAX = 120;

/**
 * Copilot Chat wraps the turn the person actually typed in `<userRequest>`,
 * inside a message that is otherwise scaffolding (`<userMemory>`, tool docs,
 * `<reminderInstructions>`). So the label here is the contents of this one
 * block, not the message minus the others — stripping the siblings alone would
 * take the request with them. Last match wins: the envelope appends the current
 * request after the preceding instructions.
 */
const USER_REQUEST_BLOCK =
  /(?:^|\r?\n)[ \t]*<userRequest>[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*<\/userRequest>[ \t]*(?=\r?\n|$)/g;

/** The innermost user request in a Copilot Chat envelope, or null if unwrapped. */
function unwrapUserRequest(text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(USER_REQUEST_BLOCK)) { last = m[1] ?? null; }
  return last?.trim() ? last : null;
}

/**
 * A session label built from a captured prompt: agent-host scaffolding removed,
 * whitespace flattened to one line, then capped.
 *
 * Cleaning must precede the cap. The harness prefixes a `<current_datetime>`
 * stamp that is 66 characters on its own — over half the budget — so trimming
 * first would label every session with the same timestamp and no prose.
 */
function promptLabel(raw: unknown, max = PROMPT_LABEL_MAX): string | null {
  if (typeof raw !== 'string') { return null; }
  const flat = stripAgentContext(raw, true).replace(/\s+/g, ' ').trim();
  if (!flat) { return null; }
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/**
 * Shared cleaning for both: host-injected scaffolding out, blank runs
 * collapsed. `blocks` additionally unwraps a Copilot Chat `<userRequest>`
 * envelope and drops standalone context sections, which only labels want.
 */
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

/** Flattened OTel attributes are stored as a JSON object in the query views. */
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

/**
 * Reshapes a Claude `assistant_response` into the `gen_ai.output.messages` JSON
 * the transcript renderers already consume, so no renderer needs to know the
 * turn came from a log record rather than a span attribute.
 */
function claudeOutputMessages(response: string): string {
  return JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: response }] }]);
}

/**
 * Whether a Claude log turn came from a subagent. A subagent runs entirely inside
 * the `Agent` tool call that launched it, so its responses are stamped with that
 * call's `tool.execution` span while the main agent's carry `claude_code.interaction`;
 * the type name sits one level up. The span-name arm covers a pruned parent.
 */
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

/**
 * One LLM call inside a Claude reply, rebuilt from the log stream.
 *
 * A call is delimited by its `api_request` record and collects everything logged
 * around it: the tools that call issued, the permission decisions it prompted,
 * and the prose it produced. Separate `claude_code.llm_request` spans are used
 * for navigation only when timing or an id identifies one uniquely. A reply is
 * normally several calls, so a turn cannot be one `assistant_response`.
 */
interface ClaudeCallDraft {
  traceId: string;
  spanId: string;
  sourceSpanId: string | null;
  spanName: string;
  startTimeUnixNano: string;
  model: string | null;
  hasError: boolean;
  /**
   * True once an `api_*` record has claimed this call. Records that belong to a
   * call can be logged before its request is, so an unclaimed call is still
   * available for the next request to adopt.
   */
  opened: boolean;
  /** Resolved to a prompt once the whole stream is read — a prompt often names itself late. */
  promptKey: string;
  /** The running prompt when this call opened, used only if the key never resolves. */
  fallbackPrompt: string | null;
  isSubagent: boolean;
  subagentType: string | null;
  /** Assistant prose, once an `assistant_response` lands on this call. */
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

  // Claude threads each response to its prompt via `prompt.id`. Falling back to
  // the most recent prompt keeps turns anchored when that id is absent.
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
      // The logged prompt is often pure injected context, cleaning away to
      // nothing; the span it is stamped with holds what the person actually
      // typed. Without this fallback the prompt goes unrecorded and every turn
      // until the main agent replies renders with no user bubble.
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

    // The log stream is the only place a call boundary exists:
    // `api_request` opens a call and everything logged
    // afterwards belongs to it until the next one opens. Bucketing by prompt
    // instead — what this used to do — collapsed an entire agent loop into one
    // turn, so a reply that called the model seven times rendered as "2 calls"
    // with every tool piled onto the last of them.
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
    /**
     * Claude logs `api_request` when the round trip *finishes*, so a record that
     * belongs to a call can land before it — a permission decision, most often,
     * which is how two thirds of the replies in a real capture begin. The
     * request adopts the call already collecting those records instead of
     * leaving them stranded in a bubble of their own.
     */
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

      // The interaction span the response was stamped with holds what the user
      // actually typed; the log-record prompt is usually context injection only.
      // A subagent's span is a tool execution and carries none, so this only
      // fires for the main agent.
      const spanPrompt = cleanAgentPrompt(r['span_prompt']);
      if (spanPrompt) {
        state.latestPrompt = spanPrompt;
        promptByKey.set(promptKey, spanPrompt);
      }

      // Prose belongs to the call that produced it, which is the one in flight.
      // A second response against the same call means the model was called
      // again without a request being logged, so give it its own call rather
      // than overwrite what the first one said.
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
      // Each of these records one round trip to the model — a successful one, a
      // failed one, or a refused one — so each opens a call. An error opening
      // its own call is what keeps a failure attributed to the call that failed
      // instead of reddening the whole reply.
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

    // Everything else happened because of a call: the one in flight if a request
    // has already been logged, otherwise one opened here for the next request to
    // adopt.
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
    // A call that logged nothing at all is an artefact of the join, not a turn.
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
      // A prompt often only names itself once the reply is under way, so the
      // resolved text wins over whatever was current when the call opened.
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

/**
 * Codex reports conversation content only as OTel log records, and only one side
 * of it: `codex.user_prompt` carries the user's message in a `prompt` attribute
 * (with the same host context injection Claude's gets), and `codex.tool_result`
 * carries each tool call (`tool_name`, `call_id`, `arguments`, `output`,
 * `success`).
 *
 * The model's own words are never exported — Codex streams them as
 * `codex.sse_event` records whose payload is stripped before export, leaving a
 * duration, an event kind, and (on `response.completed`) the round trip's token
 * counts. So a Codex transcript is the user's turns plus everything the agent
 * *did*, and no assistant prose. Turns with no assistant text render as the
 * shared "no response captured" state rather than dropping.
 *
 * Reshaped into the same SessionMessageTurn form the span and Claude paths
 * produce, so no renderer has to know where a turn came from. Every
 * content-bearing Codex log carries `trace_id` (only the high-volume SSE stream
 * does not), so these join to a session by trace exactly like Claude's; the SSE
 * stream joins on `conversation.id` instead.
 */

/**
 * One LLM call inside a Codex reply, before it is frozen into a
 * SessionMessageTurn: the round trip itself plus the tools it went on to issue.
 *
 * A reply is normally several of these — the agent loop calls the model again
 * after every tool result — which is why a turn cannot be one user prompt. Each
 * call carries the prompt that started the reply, so the transcript still groups
 * them into a single bubble and numbers them "call 1", "call 2".
 */
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
  /** True while `startTimeUnixNano` still points at the prompt, so the first
   *  assistant-side record can move it to when the agent actually replied. */
  awaitingReply: boolean;
}

/** Whether a `success`-style attribute is affirmative, across the encodings an
 *  exporter might use (JSON boolean, `"true"`, or 1). */
function isAffirmative(v: unknown): boolean {
  return v === true || v === 1 || (typeof v === 'string' && v.toLowerCase() === 'true');
}

/** A log timestamp as a number that can be compared. Nanoseconds overflow a
 *  double, and an exporter that writes one malformed value should not decide the
 *  order of every record around it. */
function nanosOf(value: unknown): bigint {
  try { return BigInt(String(value ?? '0')); } catch { return 0n; }
}

/** Conversation turns rebuilt from Codex's prompt/tool log records. */
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

  // The same rule `ECHO_TRACE` applies to a session's accounting, applied to its
  // transcript: a trace that captured content but no prompt and no round trip
  // reports work another trace already reported, so the only turn it can produce
  // is a duplicate under an empty user bubble — which is how it read, wedged
  // between the calls it was echoing. Sessions no longer reach such a trace at
  // all; this is what keeps one out of its own trace's transcript.
  //
  // Rows are dropped by trace rather than by event, since a trace that has no
  // turn on it has nowhere to put session configuration either.
  const conversational = new Set(logRows
    .filter(r => r['event_name'] === CODEX_PROMPT_EVENT || r['event_name'] === CODEX_API_EVENT)
    .map(r => String(r['trace_id'] ?? '')));
  const rows = logRows.filter(r => conversational.has(String(r['trace_id'] ?? '')));

  // Codex's SSE stream is the one part of its telemetry exported without a trace
  // id — thousands of rows carrying only `conversation.id`. Its
  // `response.completed` records are where the token counts live, so fetching
  // them by the conversations the correlated rows belong to is the only join
  // available; filtering by trace, as this used to, silently matched nothing and
  // no Codex transcript ever reported a token.
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
      -- Every completion is logged twice: once when the stream closes, carrying
      -- only how long that took, and once with the usage. Only the second says
      -- anything, and dropping the first here keeps it from being mistaken for a
      -- second round trip.
      AND json_extract(attributes,'$."input_token_count"') IS NOT NULL
  `).all(...conversationIds, CODEX_SSE_EVENT, 'response.completed') : [];

  // Both queries feed one stream, so a completion lands against the request it
  // reports on.
  const ordered = [...rows, ...usageRows].sort((a, b) => {
    const left = nanosOf(a['timestamp_unix_nano']);
    const right = nanosOf(b['timestamp_unix_nano']);
    if (left !== right) { return left < right ? -1 : 1; }
    return Number(a['id'] ?? 0) - Number(b['id'] ?? 0);
  });

  const turns: SessionMessageTurn[] = [];
  const draftsByTrace = new Map<string, CodexTurnDraft>();
  const sessionDetailsByTrace = new Map<string, SessionMessageDetail[]>();
  /** The prompt a trace's reply is still answering, carried onto every call of
   *  that reply so the transcript groups them into one bubble. */
  const promptByTrace = new Map<string, string>();
  /** The call each conversation's next completion belongs to. Only a request
   *  registers here: the SSE record has no trace of its own, and the tool traces
   *  a conversation spawns would otherwise claim its usage. */
  const callByConversation = new Map<string, CodexTurnDraft>();

  // A prompt with nothing after it is still worth a turn — it is what the user
  // typed, and an empty part list renders as "no response captured" rather than
  // silently dropping their message. So is a round trip that only reported on
  // itself: Codex exports no assistant prose, so its metadata is all a call that
  // answered in words ever leaves behind.
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
        // Held by reference: a completion logged a moment after the tool it
        // raced still belongs to this call, and lands here.
        details:           draft.details,
        // Codex delegates to nothing.
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

    // What the round trip cost, attributed to the request that made it.
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

    // Each prompt opens a reply, so a prompt closes the one before it.
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

    // One `api_request` is one round trip to the model, and a reply is normally
    // several of them — the agent loop calls the model again after every tool
    // result. Splitting the reply here is what earns Codex the same "call 1 /
    // call 2" markers Claude and Copilot have; bucketing by prompt instead —
    // what this used to do — collapsed the whole loop into one turn with every
    // tool of the reply piled onto it. Codex logs the request once the round
    // trip *finishes*, so the tools it issued arrive after it and a call reads
    // as "one round trip plus what it went on to do". The prompt's own draft is
    // adopted rather than closed, so a reply's first call is not preceded by a
    // turn holding nothing but the prompt.
    if (event === CODEX_API_EVENT && !draftsByTrace.get(traceId)?.awaitingReply) {
      flush(traceId);
    }

    // The next call of a reply already under way, or — before any prompt (a
    // resumed conversation whose opening prompt was pruned, or one Codex started
    // itself) — a turn for activity that answers nothing on record.
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

    /** Per-call metadata is stamped with the call it describes so the transcript
     *  can hang it off that tool's chip. Without the stamp a turn's sections are
     *  an undifferentiated list — five tool calls produce five "Tool result ·"
     *  blocks that name no call. Sections with no `call_id` stay turn-level. */
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

      // Call and result are separate parts, matching how a captured
      // `gen_ai.output.messages` reports them — the renderers already chip both.
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

  // Span-attribute content is the richer source (tool calls, reasoning parts),
  // so logs are consulted only when a session recorded none. Claude first: it
  // reports both sides of the conversation, Codex only the user's.
  const resolved = turns.length ? turns : (() => {
    const claude = claudeLogTurns(db, traceIds);
    return claude.length ? claude : codexLogTurns(db, traceIds);
  })();

  return { sessionId: id, captureEnabled: resolved.length > 0, turns: resolved };
}
