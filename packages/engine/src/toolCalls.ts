/**
 * Tool-call semantics have exactly one definition, and the receiver owns it:
 * the durable session summaries are projected during ingestion, which cannot
 * depend on the engine, so a second copy here would be the copy that drifts.
 */
export {
  CLAUDE_TOOL_SPAN,
  CLAUDE_TOOL_EXECUTION_SPAN,
  toolErrorSql as toolCallErrorSql,
} from '@agent-insights/receiver';
