export const CLAUDE_TOOL_SPAN = 'claude_code.tool';
export const CLAUDE_TOOL_EXECUTION_SPAN = 'claude_code.tool.execution';

/**
 * A Claude tool's wrapper span remains OK when its execution child fails.
 * Count the wrapper once, but inherit the execution outcome for tool statistics.
 */
export function toolCallErrorSql(alias: string): string {
  return `(
    ${alias}status_code = 2
    OR (
      ${alias}name = '${CLAUDE_TOOL_SPAN}'
      AND EXISTS (
        SELECT 1
        FROM spans tool_execution
        WHERE tool_execution.trace_id = ${alias}trace_id
          AND tool_execution.parent_span_id = ${alias}span_id
          AND tool_execution.name = '${CLAUDE_TOOL_EXECUTION_SPAN}'
          AND tool_execution.status_code = 2
      )
    )
  )`;
}
