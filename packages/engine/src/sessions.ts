import type { QueryableDB, Session, SessionFailure, SessionMessages, SessionMessageTurn, BackgroundTraceStats } from '@agent-insights/types';

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
import { SESSION_TITLE_SPAN_NAME, SESSION_URI_ATTR } from '@agent-insights/receiver';

/** Conversation key the agent host and every provider agree on. */
const SESSION_ID_ATTR = 'gen_ai.conversation.id';

/** Codex's content log events — see `codexLogTurns` for what they carry. */
const CODEX_PROMPT_EVENT = 'codex.user_prompt';
const CODEX_TOOL_EVENT   = 'codex.tool_result';

/** The scheme of a session URI (`claude:/…` → `claude`), or NULL. Mirrors the
 *  receiver's projection into `session_titles`, applied to any span carrying the
 *  URI rather than only the title span — see `loadSessionAgents`. */
const SESSION_URI_SCHEME_EXPR = `NULLIF(
  substr(
    json_extract(attributes, '$."${SESSION_URI_ATTR}"'),
    1,
    instr(COALESCE(json_extract(attributes, '$."${SESSION_URI_ATTR}"'), ''), ':') - 1
  ), '')`;

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

  // Codex emits no title span and captures no span content, so neither source
  // above ever fires for it and every Codex session would list as untitled. Its
  // opening prompt is a log record instead — as Claude's is when its span
  // recorded none.
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
 * Kept separate from `loadSessionTitles` because that one falls back to the
 * opening prompt when no title span exists; agent kind has no such fallback —
 * a session with no URI anywhere simply has none and is reported by service name.
 *
 * Not derivable from `service_name`, which is whatever resource name the agent
 * stamped on itself (`claude` → `claude-code`, `copilotcli` → `github-copilot`,
 * `codex` → `codex-app-server`). This is the host's own name for the plugin,
 * joined to the session on the conversation id.
 *
 * `session_titles` is the durable source — it outlives the span it came from —
 * but it is fed only by title spans, which the host emits for some agents and
 * not others (Codex gets none). The session anchor span carries the same URI, so
 * it is the fallback: less durable, since retention can evict it, but it is the
 * difference between an agent badge and none at all.
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
 * Opening user prompt per session, from the session's earliest prompt log
 * records.
 *
 * Logs are the only content channel some harnesses have: Codex captures no span
 * content at all, and Claude records a prompt on its span only sometimes. So
 * this is the last label source before a session lists as untitled.
 *
 * Reads the first few records rather than only the first, and takes the earliest
 * one with anything user-authored left after cleaning — a session commonly opens
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

/**
 * Whether a trace carries a user prompt in its log records.
 *
 * Agent activity is measured over span attributes, which is blind to a harness
 * that reports conversation content as logs only — Codex's spans are Rust
 * `tracing` internals with no gen_ai attributes at all. Without this, a Codex
 * turn that asked a question and got prose back (no tools, no usable span)
 * would read as housekeeping and be hidden.
 *
 * Resolved through PROMPT_TRACES_CTE rather than a correlated subquery: the
 * predicate is evaluated per *span*, so scanning the log table inline would cost
 * one pass per span in the trace.
 */
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
 * Keeps a session out of the Sessions tab when nothing ever happened in it.
 *
 * Two different things manufacture empty rows, and both are Codex:
 *
 *  - `SESSION_ID_EXPR` falls back to `trace_id` for a trace with no conversation
 *    key, minting one "session" per trace. Codex's app-server emits a trace for
 *    each piece of its own housekeeping — config reads, `list_models`,
 *    `skills/list`, RPC queue drains — and a single day of use manufactured 261
 *    phantom single-trace sessions that buried the 6 real ones.
 *
 *  - The agent host mints a conversation id and emits its session anchor when a
 *    chat is *created*, not when it is first used. Every Codex thread the user
 *    opened and never typed into arrives fully keyed, with ~37 spans of
 *    `session_init.*` / `app_server.thread_start.*` startup and nothing else.
 *
 * So a conversation key is not evidence of a conversation, and the rule is
 * about evidence of use instead: keep a session that did agent work, or that
 * captured a user prompt, or that the host gave a title. A trace that did real
 * work is kept even when it is unlabelled — that case is genuine telemetry
 * whose `vscode.agent_host.session` anchor was pruned by retention or never
 * arrived, and hiding it would lose a real conversation.
 *
 * Nothing is deleted: every excluded trace stays fully browsable in the Traces
 * tab, which applies no session filter. `getBackgroundTraceStats` counts them so
 * the UI can point there.
 */
const BACKGROUND_TRACE_FILTER =
  `(${AGENT_ACTIVITY} OR MAX(has_user_prompt) = 1 OR ${SESSION_IS_TITLED})`;

/**
 * Traces excluded from the Sessions tab by BACKGROUND_TRACE_FILTER — an agent
 * runtime's own background work, or a chat that was created and never used,
 * rather than a conversation. Reported so the UI can disclose that they exist
 * and are browsable in Traces, instead of silently dropping them.
 */
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
 * Latest user prompt, anchoring each assistant turn to the prompt that
 * produced it.
 *
 * Left as captured, scaffolding and all: the webview renders the harness's
 * `<snake_case>` context blocks as collapsed, labelled sections, so a
 * transcript is better off keeping them than being handed a pre-stripped
 * string. Only labels (see `promptLabel`) strip them.
 */
function lastUserPrompt(inputMessagesJson: unknown): string | null {
  const text = userMessageTexts(inputMessagesJson, 'last')[0];
  if (!text) { return null; }
  return text.length > 500 ? text.slice(0, 500) + '…' : text;
}

/**
 * Opening user prompt, used as a session label when no title was reported.
 *
 * A message that is nothing but injected context cleans away to nothing, so the
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
 * Claude Code reports conversation content across two channels, and a complete
 * transcript needs both:
 *
 * - The user's actual message is a `user_prompt` span attribute on the
 *   `claude_code.interaction` span for the turn.
 * - The model's reply is an OTel LOG record (`assistant_response`, carrying the
 *   full `response` text), stamped with that same interaction span id — which is
 *   what lets the two be joined back into turns.
 *
 * Both are gated on the same `chat.agentHost.otel.captureContent` setting as
 * Copilot's span content (the agent host maps it to `OTEL_LOG_USER_PROMPTS` /
 * `OTEL_LOG_ASSISTANT_RESPONSES`).
 *
 * The agent host deliberately does not store provider logs — microsoft/vscode#328529
 * routes `/v1/logs` past it and straight to the user's collector — so this
 * receiver is the only place a Claude transcript exists. Without this fallback a
 * fully captured Claude session renders as "no captured model responses".
 *
 * Matched on event name plus content attribute rather than `service.name`: the
 * host sets `OTEL_SERVICE_NAME=claude-code`, but users can override it.
 */
const CLAUDE_PROMPT_EVENT   = 'user_prompt';
const CLAUDE_RESPONSE_EVENT = 'assistant_response';

const AGENT_REPOSITORY_CONTEXT_BLOCK = [
  'Repository name:[^\\r\\n]*',
  'Owner:[^\\r\\n]*',
  'Current branch:[^\\r\\n]*',
  'Default branch:[^\\r\\n]*',
].join('\\r?\\n');

/**
 * One or more repository-metadata blocks standing alone as their own paragraph.
 *
 * Anchoring on paragraph boundaries rather than only on the end of the prompt is
 * what makes this safe to apply mid-message: four lines in exactly this order,
 * each opening with its own keyword, fenced by blank lines on both sides, is the
 * host's injection and not something a person writes. Requiring a *trailing*
 * boundary was too strict — the host appends its block before any file
 * references the user attached, which left the metadata stranded in the middle
 * and rendered in full.
 */
const AGENT_REPOSITORY_CONTEXT = new RegExp(
  `(^|\\r?\\n\\r?\\n)` +
  `${AGENT_REPOSITORY_CONTEXT_BLOCK}(?:(?:\\r?\\n){2}${AGENT_REPOSITORY_CONTEXT_BLOCK})*` +
  `(?=(?:\\r?\\n){2}|\\s*$)`,
  'g',
);

/**
 * A recorded prompt combines what the user typed with context messages injected
 * by Agent Host. The latter currently appear as `<system-reminder>` blocks or
 * repository metadata blocks. Neither is user-authored, so strip both before
 * displaying the turn.
 *
 * The injection is the host's, not the provider's, so the same two shapes turn
 * up verbatim in Claude's `user_prompt` and Codex's `codex.user_prompt` — hence
 * one cleaner for both rather than one per agent.
 *
 * Ordinary prose that merely mentions a repository or branch is preserved: only
 * a complete, isolated block matches. A prompt made entirely of injected context
 * collapses to empty and is skipped.
 */
function cleanAgentPrompt(raw: unknown, max = 500): string | null {
  if (typeof raw !== 'string') { return null; }
  const text = stripAgentContext(raw, false);
  if (!text) { return null; }
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * A whole `<snake_case>…</snake_case>` section standing alone in a message: the
 * `<current_datetime>` stamp the harness prefixes, and the `<system_reminder>`
 * / `<tagged_files>` sections it appends.
 *
 * Removed only when deriving a session label, never for transcripts — the
 * webview renders these as collapsed, labelled sections (see
 * `renderMessageBody`), so a transcript wants them kept. A label gets one line
 * and has to spend it on what the person actually typed.
 *
 * Requiring the open tag to start a line and its close to end one is what keeps
 * prose safe: an inline `#include <string>` or a sentence mentioning
 * `<foo_bar>` never matches. A block nested inside another goes with its
 * parent, because the lazy body stops at the first close tag of the *same*
 * name. An unbalanced tag is left alone rather than swallowing the rest of the
 * message.
 */
const AGENT_CONTEXT_BLOCK = /(^|\r?\n)[ \t]*<([a-z][a-z0-9_-]*)>[\s\S]*?<\/\2>[ \t]*(?=\r?\n|$)/g;

/** How much of a captured prompt a session label may use. */
const PROMPT_LABEL_MAX = 120;

/**
 * A session label built from a captured prompt: agent-host scaffolding removed,
 * whitespace flattened to a single line, then capped.
 *
 * Cleaning has to precede the cap, not follow it. The harness prefixes a
 * `<current_datetime>` stamp that is 66 characters on its own — more than half
 * the budget — so trimming first yields a list of sessions all labelled with
 * the same timestamp and no prose. Truncating afterwards also means the cap
 * applies to what the label actually shows.
 */
function promptLabel(raw: unknown, max = PROMPT_LABEL_MAX): string | null {
  if (typeof raw !== 'string') { return null; }
  const flat = stripAgentContext(raw, true).replace(/\s+/g, ' ').trim();
  if (!flat) { return null; }
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/**
 * Shared cleaning for both: host-injected scaffolding out, blank runs
 * collapsed. `blocks` additionally drops standalone `<snake_case>` sections,
 * which only labels want.
 */
function stripAgentContext(raw: string, blocks: boolean): string {
  let text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(AGENT_REPOSITORY_CONTEXT, '$1');
  if (blocks) { text = text.replace(AGENT_CONTEXT_BLOCK, '$1'); }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Reshapes a Claude `assistant_response` into the `gen_ai.output.messages`
 * JSON the transcript renderers already consume, so no renderer needs to know
 * that this turn came from a log record instead of a span attribute.
 */
function claudeOutputMessages(response: string): string {
  return JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: response }] }]);
}

/** Conversation turns rebuilt from Claude's prompt/response records. */
function claudeLogTurns(db: QueryableDB, traceIds: string[]): SessionMessageTurn[] {
  if (!traceIds.length) { return []; }
  const ph = traceIds.map(() => '?').join(',');

  const rows = db.prepare(`
    SELECT
      l.trace_id,
      l.span_id,
      l.timestamp_unix_nano,
      l.severity_number,
      s.name                                                  AS span_name,
      json_extract(s.attributes,'$."user_prompt"')            AS span_prompt,
      json_extract(l.attributes,'$."event.name"')             AS event_name,
      json_extract(l.attributes,'$."prompt.id"')              AS prompt_id,
      json_extract(l.attributes,'$."model"')                  AS model,
      json_extract(l.attributes,'$."prompt"')                 AS prompt,
      json_extract(l.attributes,'$."response"')               AS response
    FROM logs l
    LEFT JOIN spans s ON s.span_id = l.span_id
    WHERE l.trace_id IN (${ph})
      AND json_extract(l.attributes,'$."event.name"') IN (?, ?)
    ORDER BY CAST(l.timestamp_unix_nano AS INTEGER) ASC,
             CAST(COALESCE(json_extract(l.attributes,'$."event.sequence"'), 0) AS INTEGER) ASC
  `).all(...traceIds, CLAUDE_PROMPT_EVENT, CLAUDE_RESPONSE_EVENT);

  // Claude threads each response to its prompt via `prompt.id`. Falling back to
  // the most recent prompt keeps turns anchored when that id is absent.
  const promptById = new Map<string, string>();
  let latestPrompt: string | null = null;
  const turns: SessionMessageTurn[] = [];

  for (const r of rows) {
    const promptId = r['prompt_id'] != null ? String(r['prompt_id']) : '';

    if (String(r['event_name'] ?? '') === CLAUDE_PROMPT_EVENT) {
      const text = cleanAgentPrompt(r['prompt']);
      if (text) {
        latestPrompt = text;
        if (promptId) { promptById.set(promptId, text); }
      }
      continue;
    }

    const response = r['response'];
    if (typeof response !== 'string' || !response.trim()) { continue; }

    // The interaction span the response was stamped with holds what the user
    // actually typed; the log-record prompt is usually context injection only.
    const spanPrompt = cleanAgentPrompt(r['span_prompt']);
    if (spanPrompt) { latestPrompt = spanPrompt; }

    turns.push({
      traceId:           String(r['trace_id'] ?? ''),
      spanId:            String(r['span_id'] ?? ''),
      spanName:          String(r['span_name'] ?? CLAUDE_RESPONSE_EVENT),
      startTimeUnixNano: String(r['timestamp_unix_nano'] ?? '0'),
      model:             r['model'] != null ? String(r['model']) : null,
      hasError:          Number(r['severity_number'] ?? 0) >= 17,
      outputMessages:    claudeOutputMessages(response),
      inputPreview:      spanPrompt || (promptId && promptById.get(promptId)) || latestPrompt,
    });
  }

  return turns;
}

/**
 * Codex reports conversation content only as OTel log records, and only one
 * side of it:
 *
 * - `codex.user_prompt` carries the user's message in full, in a `prompt`
 *   attribute (with the same Agent Host context injection Claude's gets).
 * - `codex.tool_result` carries each tool call — `tool_name`, `call_id`,
 *   `arguments`, `output`, `success`.
 *
 * The model's own words are never exported. Codex streams them as
 * `codex.sse_event` records (`response.output_text.delta`,
 * `response.reasoning_summary_text.delta`) whose payload is stripped before
 * export, leaving only a duration and an event kind. So a Codex transcript is
 * the user's turns plus everything the agent *did*, and no assistant prose —
 * unlike Claude, which reports the reply text too. Turns with no assistant text
 * render as the shared "no response captured" state rather than being dropped.
 *
 * Reshaped into the same SessionMessageTurn / gen_ai message form the span and
 * Claude paths produce, so no renderer has to know where a turn came from.
 *
 * Every content-bearing Codex log carries `trace_id` — only the high-volume SSE
 * stream does not — so these join to a session by trace exactly like Claude's.
 */

/** One Codex turn under construction: a user prompt plus the tool activity that
 *  followed it, before it is frozen into a SessionMessageTurn. */
interface CodexTurnDraft {
  traceId: string;
  spanId: string;
  spanName: string;
  startTimeUnixNano: string;
  model: string | null;
  hasError: boolean;
  parts: Record<string, unknown>[];
  inputPreview: string | null;
  /** True while `startTimeUnixNano` still points at the prompt, so the first
   *  assistant-side record can move it to when the agent actually replied. */
  awaitingReply: boolean;
}

/** Whether a `success`-style attribute is affirmative, across the encodings an
 *  exporter might use (JSON boolean, `"true"`, or 1). */
function isAffirmative(v: unknown): boolean {
  return v === true || v === 1 || (typeof v === 'string' && v.toLowerCase() === 'true');
}

/** Conversation turns rebuilt from Codex's prompt/tool log records. */
function codexLogTurns(db: QueryableDB, traceIds: string[]): SessionMessageTurn[] {
  if (!traceIds.length) { return []; }
  const ph = traceIds.map(() => '?').join(',');

  const rows = db.prepare(`
    SELECT
      trace_id,
      span_id,
      timestamp_unix_nano,
      json_extract(attributes,'$."event.name"') AS event_name,
      json_extract(attributes,'$."model"')      AS model,
      json_extract(attributes,'$."prompt"')     AS prompt,
      json_extract(attributes,'$."tool_name"')  AS tool_name,
      json_extract(attributes,'$."call_id"')    AS call_id,
      json_extract(attributes,'$."arguments"')  AS arguments,
      json_extract(attributes,'$."output"')     AS output,
      json_extract(attributes,'$."success"')    AS success
    FROM logs
    WHERE trace_id IN (${ph})
      AND json_extract(attributes,'$."event.name"') IN (?, ?)
    ORDER BY CAST(timestamp_unix_nano AS INTEGER) ASC, id ASC
  `).all(...traceIds, CODEX_PROMPT_EVENT, CODEX_TOOL_EVENT);

  const turns: SessionMessageTurn[] = [];
  let draft: CodexTurnDraft | null = null;

  // A prompt with nothing after it is still worth a turn — it is what the user
  // typed, and an empty part list renders as "no response captured" rather than
  // silently dropping their message.
  const flush = (): void => {
    if (draft && (draft.inputPreview || draft.parts.length)) {
      turns.push({
        traceId:           draft.traceId,
        spanId:            draft.spanId,
        spanName:          draft.spanName,
        startTimeUnixNano: draft.startTimeUnixNano,
        model:             draft.model,
        hasError:          draft.hasError,
        outputMessages:    JSON.stringify([{ role: 'assistant', parts: draft.parts }]),
        inputPreview:      draft.inputPreview,
      });
    }
    draft = null;
  };

  for (const r of rows) {
    const event = String(r['event_name'] ?? '');
    const nano  = String(r['timestamp_unix_nano'] ?? '0');
    const model = r['model'] != null ? String(r['model']) : null;

    // Each prompt opens a turn, so a prompt closes the one before it.
    if (event === CODEX_PROMPT_EVENT) {
      flush();
      const text = cleanAgentPrompt(r['prompt']);
      if (!text) { continue; }   // pure context injection; nothing user-authored
      draft = {
        traceId:           String(r['trace_id'] ?? ''),
        spanId:            String(r['span_id'] ?? ''),
        spanName:          event,
        startTimeUnixNano: nano,
        model,
        hasError:          false,
        parts:             [],
        inputPreview:      text,
        awaitingReply:     true,
      };
      continue;
    }

    // Tool activity before any prompt (a resumed conversation whose opening
    // prompt was pruned, or one Codex started itself) still gets a turn.
    if (!draft) {
      draft = {
        traceId:           String(r['trace_id'] ?? ''),
        spanId:            String(r['span_id'] ?? ''),
        spanName:          event,
        startTimeUnixNano: nano,
        model,
        hasError:          false,
        parts:             [],
        inputPreview:      null,
        awaitingReply:     false,
      };
    }
    if (draft.awaitingReply) {
      draft.startTimeUnixNano = nano;
      draft.awaitingReply     = false;
    }
    if (!draft.model) { draft.model = model; }

    const callId = r['call_id'] != null ? String(r['call_id']) : undefined;
    if (!isAffirmative(r['success'])) { draft.hasError = true; }

    // Call and result are separate parts, matching how a captured
    // `gen_ai.output.messages` reports them — the renderers already chip both.
    draft.parts.push({
      type:      'tool_call',
      id:        callId,
      name:      r['tool_name'] != null ? String(r['tool_name']) : 'tool',
      arguments: r['arguments'] != null ? String(r['arguments']) : null,
    });
    if (r['output'] != null) {
      draft.parts.push({ type: 'tool_call_response', id: callId, response: String(r['output']) });
    }
  }
  flush();

  return turns;
}

/**
 * The ordered model responses within a session — one entry per chat/LLM span
 * that recorded captured `gen_ai.output.messages`, or, for harnesses that report
 * content as log records instead (Claude Code, Codex), one entry per captured
 * turn. Returns null when no session resolves to `sessionId`. When the session
 * exists but has no captured content, `captureEnabled` is false and `turns` is
 * empty. `sessionId` matches the value produced by SESSION_ID_EXPR.
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

  // Span-attribute content is the richer source (tool calls, reasoning parts),
  // so logs are consulted only when a session recorded none. Claude first: it
  // reports both sides of the conversation, Codex only the user's.
  const resolved = turns.length ? turns : (() => {
    const claude = claudeLogTurns(db, traceIds);
    return claude.length ? claude : codexLogTurns(db, traceIds);
  })();

  return { sessionId: id, captureEnabled: resolved.length > 0, turns: resolved };
}
