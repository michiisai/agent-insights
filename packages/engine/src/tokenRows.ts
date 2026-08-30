import {
  AGENT_HOST_SERVICE_NAME,
  TOKEN_ATTRIBUTE_KEYS,
  TOKEN_CHAT_OPERATION,
  TOKEN_OPERATION_ATTRIBUTE,
  type QueryableDB,
} from '@agent-insights/types';

/** Convention-aware token volumes are owned by the receiver, which projects the
 *  same numbers into the durable session summaries during ingestion. */
export { promptTokensSql as promptTokensExprSql, outputTokensSql as outputTokensExprSql }
  from '@agent-insights/receiver';
import { outputTokensSql, promptTokensSql } from '@agent-insights/receiver';

const tokenAttr = (key: string, alias = 's'): string =>
  `json_extract(${alias}.attributes, '$."${key}"')`;
const firstTokenAttr = (keys: readonly string[], fallback: string, alias = 's'): string =>
  `COALESCE(${keys.map(key => tokenAttr(key, alias)).join(', ')}, ${fallback})`;
const hasTokenAttr = (keys: readonly string[], alias = 's'): string =>
  `(${keys.map(key => `${tokenAttr(key, alias)} IS NOT NULL`).join(' OR ')})`;


const directModelExpr = firstTokenAttr(TOKEN_ATTRIBUTE_KEYS.model, 'NULL');
const ancestorModelExpr = `(
  WITH RECURSIVE token_ancestors(trace_id, parent_span_id, attributes, depth) AS (
    SELECT parent.trace_id, parent.parent_span_id, parent.attributes, 1
      FROM spans parent
     WHERE parent.trace_id = s.trace_id
       AND parent.span_id = s.parent_span_id
    UNION ALL
    SELECT parent.trace_id, parent.parent_span_id, parent.attributes, ancestor.depth + 1
      FROM spans parent
      JOIN token_ancestors ancestor
        ON parent.trace_id = ancestor.trace_id
       AND parent.span_id = ancestor.parent_span_id
     WHERE ancestor.depth < 64
  )
  SELECT ${firstTokenAttr(TOKEN_ATTRIBUTE_KEYS.model, 'NULL', 'ancestor')}
    FROM token_ancestors ancestor
   WHERE ${hasTokenAttr(TOKEN_ATTRIBUTE_KEYS.model, 'ancestor')}
   ORDER BY ancestor.depth
   LIMIT 1
)`;
const modelExpr = `COALESCE(${directModelExpr}, ${ancestorModelExpr}, 'unknown')`;
const promptExpr = promptTokensSql();
const outputExpr = outputTokensSql();
const cacheReadExpr = firstTokenAttr(TOKEN_ATTRIBUTE_KEYS.cacheRead, '0');
const cacheCreationExpr = firstTokenAttr(TOKEN_ATTRIBUTE_KEYS.cacheCreation, '0');
const operationExpr = tokenAttr(TOKEN_OPERATION_ATTRIBUTE);
const valuePredicate = hasTokenAttr([
  ...TOKEN_ATTRIBUTE_KEYS.input,
  ...TOKEN_ATTRIBUTE_KEYS.output,
  ...TOKEN_ATTRIBUTE_KEYS.cacheRead,
  ...TOKEN_ATTRIBUTE_KEYS.cacheCreation,
]);
const tokenEvidencePredicate = `(
  ${valuePredicate}
  OR ${hasTokenAttr(TOKEN_ATTRIBUTE_KEYS.model)}
)`;
const requestLeafPredicate = `(
  ${operationExpr} = '${TOKEN_CHAT_OPERATION}'
  OR (
    ${operationExpr} IS NULL
    AND (
      s.name = 'chat'
      OR s.name LIKE 'chat %'
      OR s.name LIKE '%llm_request%'
      OR s.name = 'handle_responses'
    )
  )
)`;

export interface GetTokenUsageRowsOptions {
  serviceName?: string;
  sinceNano?: string;
  untilNano?: string;
}

export function getTokenUsageRows(
  db: QueryableDB,
  options: GetTokenUsageRowsOptions = {},
): Record<string, unknown>[] {
  const where = [
    `s.service_name != '${AGENT_HOST_SERVICE_NAME}'`,
    `s.name NOT LIKE 'vscode.agent_host.%'`,
    tokenEvidencePredicate,
    requestLeafPredicate,
  ];
  const params: unknown[] = [];
  if (options.serviceName !== undefined) {
    where.push('s.service_name = ?');
    params.push(options.serviceName);
  }
  if (options.sinceNano !== undefined) {
    where.push('s.start_time_unix_nano >= ?');
    params.push(options.sinceNano);
  }
  if (options.untilNano !== undefined) {
    where.push('s.start_time_unix_nano <= ?');
    params.push(options.untilNano);
  }

  return db.prepare(`
    SELECT
      model,
      SUM(prompt_tokens) AS prompt_tokens,
      SUM(completion_tokens) AS completion_tokens,
      SUM(cached_tokens) AS cached_tokens,
      SUM(cache_creation_tokens) AS cache_creation_tokens,
      COUNT(*) AS call_count
    FROM (
      SELECT
        ${modelExpr} AS model,
        ${promptExpr} AS prompt_tokens,
        ${outputExpr} AS completion_tokens,
        ${cacheReadExpr} AS cached_tokens,
        ${cacheCreationExpr} AS cache_creation_tokens
      FROM spans s
      WHERE ${where.join('\n        AND ')}
    ) token_calls
    GROUP BY model
    ORDER BY (prompt_tokens + completion_tokens) DESC
  `).all(...params);
}
