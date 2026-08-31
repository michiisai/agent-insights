import {
  AGENT_HOST_SERVICE_NAME,
  TOKEN_ADDITIVE_CACHE_ATTRIBUTE_KEYS,
  TOKEN_ATTRIBUTE_KEYS,
} from '@agent-insights/types';

export const SESSION_TITLE_SPAN_NAME = 'vscode.agent_host.session.title_changed';
export const SESSION_URI_ATTR = 'vscode.agent_host.session.uri';
export const SESSION_ID_ATTR = 'gen_ai.conversation.id';
export const CODEX_LLM_SPAN = 'run_sampling_request';
export const CODEX_TOOL_SPAN = 'handle_tool_call';
export const CLAUDE_TOOL_SPAN = 'claude_code.tool';
export const CLAUDE_TOOL_EXECUTION_SPAN = 'claude_code.tool.execution';

const UTILITY_SERVICE_NAME = 'copilot-chat';
const SESSION_KEY_ATTRIBUTES = [
  SESSION_ID_ATTR,
  'session.id',
  'copilot_chat.chat_session_id',
] as const;

const attrSql = (key: string, prefix = ''): string =>
  `json_extract(${prefix}attributes,'$."${key}"')`;

const firstAttrSql = (keys: readonly string[], fallback: string, prefix = ''): string =>
  `COALESCE(${keys.map(key => attrSql(key, prefix)).join(', ')}, ${fallback})`;

const hasAttrSql = (keys: readonly string[], prefix = ''): string =>
  `(${keys.map(key => `${attrSql(key, prefix)} IS NOT NULL`).join(' OR ')})`;

export const hostSpanSql = (prefix = ''): string =>
  `(COALESCE(${prefix}service_name = '${AGENT_HOST_SERVICE_NAME}'
             OR ${prefix}name LIKE 'vscode.agent_host.%', 0) = 1)`;

export const llmSpanSql = (prefix = ''): string => `(
  ${prefix}name LIKE 'chat %'
  OR ${prefix}name = 'chat'
  OR ${prefix}name LIKE '%llm_request%'
  OR ${prefix}name = '${CODEX_LLM_SPAN}'
)`;

export const toolSpanSql = (prefix = ''): string => `(
  ${prefix}name LIKE 'execute_tool%'
  OR ${prefix}name = '${CLAUDE_TOOL_SPAN}'
  OR ${prefix}name = '${CODEX_TOOL_SPAN}'
)`;

export const toolErrorSql = (prefix: string): string => `(
  ${prefix}status_code = 2
  OR (
    ${prefix}name = '${CLAUDE_TOOL_SPAN}'
    AND EXISTS (
      SELECT 1
        FROM spans tool_execution
       WHERE tool_execution.trace_id = ${prefix}trace_id
         AND tool_execution.parent_span_id = ${prefix}span_id
         AND tool_execution.name = '${CLAUDE_TOOL_EXECUTION_SPAN}'
         AND tool_execution.status_code = 2
    )
  )
)`;

export const promptTokensSql = (alias = 's'): string => {
  const prefix = alias ? `${alias}.` : '';
  const input = firstAttrSql(TOKEN_ATTRIBUTE_KEYS.input, '0', prefix);
  const cacheRead = firstAttrSql(TOKEN_ATTRIBUTE_KEYS.cacheRead, '0', prefix);
  const cacheCreation = firstAttrSql(TOKEN_ATTRIBUTE_KEYS.cacheCreation, '0', prefix);
  return `(CASE WHEN ${hasAttrSql(TOKEN_ADDITIVE_CACHE_ATTRIBUTE_KEYS, prefix)}
                THEN ${input} + ${cacheRead} + ${cacheCreation}
                ELSE ${input} END)`;
};

export const outputTokensSql = (alias = 's'): string =>
  firstAttrSql(TOKEN_ATTRIBUTE_KEYS.output, '0', alias ? `${alias}.` : '');

const rollupSql = (prefix = ''): string =>
  `COALESCE(${attrSql('gen_ai.operation.name', prefix)}, '') = 'invoke_agent'`;

const sessionInputTokensSql = (prefix = ''): string => {
  const alias = prefix.endsWith('.') ? prefix.slice(0, -1) : prefix;
  return `(CASE WHEN ${rollupSql(prefix)} THEN 0 ELSE ${promptTokensSql(alias)} END)`;
};

const sessionOutputTokensSql = (prefix = ''): string => {
  const alias = prefix.endsWith('.') ? prefix.slice(0, -1) : prefix;
  return `(CASE WHEN ${rollupSql(prefix)} THEN 0 ELSE ${outputTokensSql(alias)} END)`;
};

const modelSql = (prefix = ''): string =>
  firstAttrSql(TOKEN_ATTRIBUTE_KEYS.model, 'NULL', prefix);

/**
 * Facts stay per trace because a conversation key can arrive after the spans it
 * names. The key columns retain their priority regardless of batch order.
 */
export const SESSION_FACTS_TABLES = [
  `CREATE TABLE IF NOT EXISTS session_trace_facts (
     trace_id              TEXT PRIMARY KEY,
     key_conversation      TEXT,
     key_session           TEXT,
     key_chat              TEXT,
     service_name          TEXT,
     start_unix_nano       TEXT,
     end_unix_nano         TEXT,
     root_name             TEXT,
     root_start_nano       TEXT,
     span_count            INTEGER NOT NULL DEFAULT 0,
     llm_count             INTEGER NOT NULL DEFAULT 0,
     tool_count            INTEGER NOT NULL DEFAULT 0,
     error_count           INTEGER NOT NULL DEFAULT 0,
     input_tokens          REAL    NOT NULL DEFAULT 0,
     output_tokens         REAL    NOT NULL DEFAULT 0,
     has_content_log       INTEGER NOT NULL DEFAULT 0,
     has_conversation_log  INTEGER NOT NULL DEFAULT 0,
     has_user_prompt       INTEGER NOT NULL DEFAULT 0,
     last_log_nano         TEXT,
     facts_v               INTEGER NOT NULL,
     updated_at            INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS session_trace_models (
     trace_id TEXT NOT NULL,
     model    TEXT NOT NULL,
     PRIMARY KEY (trace_id, model)
   )`,
  `CREATE TABLE IF NOT EXISTS session_facts_meta (
     id               INTEGER PRIMARY KEY CHECK (id = 1),
     last_span_row_id INTEGER NOT NULL,
     last_log_row_id  INTEGER NOT NULL,
     facts_v          INTEGER NOT NULL
   )`,
] as const;

export const SESSION_FACTS_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_session_facts_key
     ON session_trace_facts(COALESCE(key_conversation, key_session, key_chat))`,
  'CREATE INDEX IF NOT EXISTS idx_session_facts_end ON session_trace_facts(end_unix_nano)',
  'CREATE INDEX IF NOT EXISTS idx_session_models_name ON session_trace_models(model)',
] as const;

export const SESSION_FACTS_TRACE_TABLES = [
  'session_trace_models',
  'session_trace_facts',
] as const;

// Version 1 was exercised only by the unshipped persistence draft. Version 2
// is the fresh-start contract used by the internal release.
export const SESSION_FACTS_VERSION = 2;

export const unkeyedUtilityTraceSql = (
  facts = 'f.', codex = 'c.',
): string => `(
  COALESCE(${facts}service_name, '') = '${UTILITY_SERVICE_NAME}'
  AND ${facts}key_conversation IS NULL
  AND ${facts}key_session IS NULL
  AND ${facts}key_chat IS NULL
  AND ${codex}session_id IS NULL
)`;

const NEW_SPANS_WHERE = `
  s.id > :since
  AND COALESCE(s.trace_id, '') <> ''
  AND s.name <> '${SESSION_TITLE_SPAN_NAME}'`;

const ROOT_CANDIDATES_CTE = `
  session_fact_roots AS MATERIALIZED (
    SELECT trace_id, name, start_nano FROM (
      SELECT s.trace_id AS trace_id,
             s.name AS name,
             s.start_time_unix_nano AS start_nano,
             ROW_NUMBER() OVER (
               PARTITION BY s.trace_id
               ORDER BY CAST(s.start_time_unix_nano AS INTEGER), s.span_id
             ) AS rn
        FROM spans s
        LEFT JOIN spans p
          ON p.trace_id = s.trace_id AND p.span_id = s.parent_span_id
       WHERE ${NEW_SPANS_WHERE}
         AND NOT ${hostSpanSql('s.')}
         AND (s.parent_span_id IS NULL OR s.parent_span_id = ''
              OR p.span_id IS NULL OR ${hostSpanSql('p.')})
    ) WHERE rn = 1
  )`;

const HARVEST_TRACE_FACTS_SQL = `
WITH ${ROOT_CANDIDATES_CTE},
new_facts AS MATERIALIZED (
  SELECT s.trace_id,
         MAX(${attrSql(SESSION_KEY_ATTRIBUTES[0], 's.')}) AS key_conversation,
         MAX(${attrSql(SESSION_KEY_ATTRIBUTES[1], 's.')}) AS key_session,
         MAX(${attrSql(SESSION_KEY_ATTRIBUTES[2], 's.')}) AS key_chat,
         MAX(CASE WHEN ${hostSpanSql('s.')} THEN NULL ELSE s.service_name END) AS service_name,
         MIN(s.start_time_unix_nano) AS start_nano,
         MAX(s.end_time_unix_nano) AS end_nano,
         SUM(CASE WHEN ${hostSpanSql('s.')} THEN 0 ELSE 1 END) AS span_count,
         SUM(CASE WHEN ${llmSpanSql('s.')} THEN 1 ELSE 0 END) AS llm_count,
         SUM(CASE WHEN ${toolSpanSql('s.')} THEN 1 ELSE 0 END) AS tool_count,
         SUM(CASE WHEN s.status_code = 2 THEN 1 ELSE 0 END) AS error_count,
         SUM(${sessionInputTokensSql('s.')}) AS input_tokens,
         SUM(${sessionOutputTokensSql('s.')}) AS output_tokens
    FROM spans s
   WHERE ${NEW_SPANS_WHERE}
   GROUP BY +s.trace_id
)
INSERT INTO session_trace_facts (
  trace_id, key_conversation, key_session, key_chat, service_name,
  start_unix_nano, end_unix_nano, root_name, root_start_nano,
  span_count, llm_count, tool_count, error_count, input_tokens, output_tokens,
  facts_v, updated_at
)
SELECT n.trace_id, n.key_conversation, n.key_session, n.key_chat, n.service_name,
       n.start_nano, n.end_nano, r.name, r.start_nano,
       n.span_count, n.llm_count, n.tool_count, n.error_count,
       n.input_tokens, n.output_tokens, ${SESSION_FACTS_VERSION}, unixepoch()
  FROM new_facts n
  LEFT JOIN session_fact_roots r ON r.trace_id = n.trace_id
 WHERE true
ON CONFLICT(trace_id) DO UPDATE SET
  key_conversation = COALESCE(session_trace_facts.key_conversation, excluded.key_conversation),
  key_session      = COALESCE(session_trace_facts.key_session, excluded.key_session),
  key_chat         = COALESCE(session_trace_facts.key_chat, excluded.key_chat),
  service_name     = COALESCE(MAX(session_trace_facts.service_name, excluded.service_name),
                              session_trace_facts.service_name, excluded.service_name),
  start_unix_nano  = COALESCE(MIN(session_trace_facts.start_unix_nano, excluded.start_unix_nano),
                              session_trace_facts.start_unix_nano, excluded.start_unix_nano),
  end_unix_nano    = COALESCE(MAX(session_trace_facts.end_unix_nano, excluded.end_unix_nano),
                              session_trace_facts.end_unix_nano, excluded.end_unix_nano),
  root_name        = CASE WHEN excluded.root_start_nano IS NOT NULL
                               AND (session_trace_facts.root_start_nano IS NULL
                                    OR CAST(excluded.root_start_nano AS INTEGER)
                                       < CAST(session_trace_facts.root_start_nano AS INTEGER))
                          THEN excluded.root_name ELSE session_trace_facts.root_name END,
  root_start_nano  = CASE WHEN excluded.root_start_nano IS NOT NULL
                               AND (session_trace_facts.root_start_nano IS NULL
                                    OR CAST(excluded.root_start_nano AS INTEGER)
                                       < CAST(session_trace_facts.root_start_nano AS INTEGER))
                          THEN excluded.root_start_nano ELSE session_trace_facts.root_start_nano END,
  span_count       = session_trace_facts.span_count + excluded.span_count,
  llm_count        = session_trace_facts.llm_count + excluded.llm_count,
  tool_count       = session_trace_facts.tool_count + excluded.tool_count,
  error_count      = session_trace_facts.error_count + excluded.error_count,
  input_tokens     = session_trace_facts.input_tokens + excluded.input_tokens,
  output_tokens    = session_trace_facts.output_tokens + excluded.output_tokens,
  facts_v          = excluded.facts_v,
  updated_at       = excluded.updated_at`;

const HARVEST_TRACE_MODELS_SQL = `
INSERT OR IGNORE INTO session_trace_models (trace_id, model)
SELECT DISTINCT s.trace_id, TRIM(CAST(${modelSql('s.')} AS TEXT))
  FROM spans s
 WHERE ${NEW_SPANS_WHERE}
   AND ${modelSql('s.')} IS NOT NULL
   AND TRIM(CAST(${modelSql('s.')} AS TEXT)) NOT IN ('', 'null')`;

const CONVERSATION_EVENTS = [
  'codex.user_prompt', 'codex.api_request',
  'user_prompt', 'assistant_response', 'api_request', 'api_error', 'api_refusal',
] as const;

const CONTENT_EVENTS = [
  ...CONVERSATION_EVENTS,
  'codex.tool_result', 'codex.tool_decision', 'codex.sandbox_outcome',
  'codex.conversation_starts', 'codex.turn_cost',
  'tool_result', 'tool_decision', 'api_request_body', 'api_response_body',
] as const;

const USER_PROMPT_EVENTS = ['user_prompt', 'codex.user_prompt'] as const;
const sqlList = (values: readonly string[]): string => values.map(v => `'${v}'`).join(', ');

export const SESSION_FACTS_LOG_HARVEST_SQL = `
INSERT INTO session_trace_facts (
  trace_id, has_content_log, has_conversation_log, has_user_prompt,
  last_log_nano, facts_v, updated_at
)
SELECT l.trace_id,
       MAX(CASE WHEN ${attrSql('event.name', 'l.')} IN (${sqlList(CONTENT_EVENTS)}) THEN 1 ELSE 0 END),
       MAX(CASE WHEN ${attrSql('event.name', 'l.')} IN (${sqlList(CONVERSATION_EVENTS)}) THEN 1 ELSE 0 END),
       MAX(CASE WHEN ${attrSql('event.name', 'l.')} IN (${sqlList(USER_PROMPT_EVENTS)}) THEN 1 ELSE 0 END),
       CAST(MAX(CAST(COALESCE(l.timestamp_unix_nano, '0') AS INTEGER)) AS TEXT),
       ${SESSION_FACTS_VERSION}, unixepoch()
  FROM logs l
 WHERE l.id > :since
   AND COALESCE(l.trace_id, '') <> ''
 GROUP BY +l.trace_id
ON CONFLICT(trace_id) DO UPDATE SET
  has_content_log      = MAX(session_trace_facts.has_content_log, excluded.has_content_log),
  has_conversation_log = MAX(session_trace_facts.has_conversation_log, excluded.has_conversation_log),
  has_user_prompt      = MAX(session_trace_facts.has_user_prompt, excluded.has_user_prompt),
  last_log_nano        = CAST(MAX(CAST(COALESCE(session_trace_facts.last_log_nano, '0') AS INTEGER),
                                  CAST(COALESCE(excluded.last_log_nano, '0') AS INTEGER)) AS TEXT),
  facts_v              = excluded.facts_v,
  updated_at           = excluded.updated_at`;

export const SESSION_FACTS_SPAN_HARVEST_SQL = [
  HARVEST_TRACE_FACTS_SQL,
  HARVEST_TRACE_MODELS_SQL,
] as const;

export const SESSION_SUMMARY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
export const UTILITY_SUMMARY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_SESSION_SUMMARIES = 10_000;

/**
 * Sessions are ranked and removed whole. Unkeyed utilities and log-only rows
 * get one day for late identity/spans to arrive, then leave independently.
 */
export const EXPIRED_SUMMARY_TRACES_SQL = `
WITH resolved AS (
  SELECT f.trace_id,
         COALESCE(f.key_conversation, f.key_session, f.key_chat, c.session_id, f.trace_id) AS session_id,
         CAST(COALESCE(f.end_unix_nano, f.start_unix_nano, f.last_log_nano, '0') AS INTEGER) AS end_nano,
         CAST(f.updated_at AS INTEGER) * 1000000000 AS updated_nano,
         CASE WHEN f.span_count = 0 OR ${unkeyedUtilityTraceSql()} THEN 1 ELSE 0 END AS is_transient
    FROM session_trace_facts f
    LEFT JOIN codex_trace_sessions c ON c.trace_id = f.trace_id
),
sessions AS (
  SELECT session_id,
         MAX(end_nano) AS last_nano,
         ROW_NUMBER() OVER (ORDER BY MAX(end_nano) DESC, session_id) AS rn
    FROM resolved
   WHERE is_transient = 0
   GROUP BY session_id
),
reference AS (
  SELECT MIN(
           CAST(:now AS INTEGER),
           COALESCE((SELECT MAX(last_nano) FROM sessions),
                    (SELECT MAX(end_nano) FROM resolved),
                    CAST(:now AS INTEGER))
         ) AS nano
),
cutoffs AS (
  SELECT nano - CAST(:window AS INTEGER) AS summary_nano,
         CAST(:now AS INTEGER) - CAST(:transientWindow AS INTEGER) AS transient_nano
    FROM reference
)
SELECT r.trace_id
  FROM resolved r
  JOIN sessions s ON s.session_id = r.session_id
 WHERE s.last_nano < (SELECT summary_nano FROM cutoffs) OR s.rn > :maxSessions
UNION
SELECT trace_id
  FROM resolved
 WHERE is_transient = 1
   AND updated_nano < (SELECT transient_nano FROM cutoffs)`;
