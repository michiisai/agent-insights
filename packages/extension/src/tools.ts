import * as vscode from 'vscode';
import type { TelemetryStore } from '@agent-insights/receiver';
import {
  getRecentErrorTraces,
  getSpansByTraceId,
  getTraces,
  getMetricsData,
  getLogs,
  getServiceNames,
  getServiceSummary,
  getSessions,
  getSessionIdForTrace,
  getSessionSummary,
  getSessionMessages,
  normalizeModelName,
  parseSinceNano,
  parseUntilNano,
  type GetTracesOptions,
} from '@agent-insights/engine';

// Upper bound on how long a single tool invocation may run before it is aborted.
// A long-running or never-resolving tool call is what surfaces to an IDE-integrated
// client (e.g. Claude Code) as a hung request / "permission stream closed" — so we
// guarantee every invoke() settles quickly with a result instead of hanging.
const TOOL_TIMEOUT_MS = 15_000;

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

/**
 * Runs a tool's work with three guarantees, so a tool call can never hang or reject:
 *   1. Cancellation — resolves promptly if the caller cancels (before or during the call).
 *   2. Timeout — resolves with an explanatory message if work exceeds TOOL_TIMEOUT_MS.
 *   3. Error isolation — a thrown error becomes a text result instead of a rejected promise.
 *
 * Note: the underlying SQLite queries are synchronous, so the timeout cannot preempt a
 * single in-flight query mid-execution; it bounds any awaited work and, together with the
 * try/catch, ensures invoke() always settles with a LanguageModelToolResult.
 */
async function executeTool(
  toolName: string,
  token: vscode.CancellationToken,
  work: () => vscode.LanguageModelToolResult | Promise<vscode.LanguageModelToolResult>,
): Promise<vscode.LanguageModelToolResult> {
  if (token.isCancellationRequested) {
    return textResult(`Tool "${toolName}" was cancelled before it started.`);
  }

  return new Promise<vscode.LanguageModelToolResult>((resolve) => {
    let settled = false;
    const finish = (result: vscode.LanguageModelToolResult): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      cancelSub.dispose();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(textResult(
        `Tool "${toolName}" timed out after ${TOOL_TIMEOUT_MS / 1000}s and was aborted. ` +
        `The telemetry store may be very large or busy — try narrowing the time window ` +
        `(since/until) or lowering the limit.`,
      ));
    }, TOOL_TIMEOUT_MS);

    const cancelSub = token.onCancellationRequested(() => {
      finish(textResult(`Tool "${toolName}" was cancelled.`));
    });

    // Defer to a microtask so the timer/cancel subscription are registered before work runs.
    Promise.resolve()
      .then(work)
      .then(finish)
      .catch((err: unknown) => {
        finish(textResult(
          `Tool "${toolName}" failed: ${err instanceof Error ? err.message : String(err)}`,
        ));
      });
  });
}

// Generates a markdown URI link that opens the Agent Insights panel at a specific trace/span.
// Uses vscode.env.uriScheme so the link works in both stable ("vscode") and Insiders ("vscode-insiders") builds.
function traceDeeplink(traceId: string, spanId?: string, label?: string): string {
  const query = spanId
    ? `traceId=${encodeURIComponent(traceId)}&spanId=${encodeURIComponent(spanId)}`
    : `traceId=${encodeURIComponent(traceId)}`;
  const text = label ?? (spanId
    ? `↗ Open span ${spanId} in Agent Insights`
    : `↗ Open trace ${traceId} in Agent Insights`);
  return `[${text}](${vscode.env.uriScheme}://michiisai.agent-otel/navigate?${query})`;
}

function sessionDeeplink(sessionId: string, label?: string): string {
  const text = label ?? `↗ Open session ${sessionId} in Agent Insights`;
  const query = `sessionId=${encodeURIComponent(sessionId)}`;
  return `[${text}](${vscode.env.uriScheme}://michiisai.agent-otel/navigate?${query})`;
}

/**
 * The agent host names the plugin it launched (`claude`, `copilotcli`, `codex`);
 * each agent separately names itself in OTel (`claude-code`, `github-copilot`,
 * `codex-app-server`). `session.agent` is the former and is authoritative — the
 * host doesn't control what resource name an agent picks. Fall back to the
 * service name when it's absent: sessions whose title span was never seen, and
 * harnesses running outside the host.
 *
 * Must stay in step with `agentLabel` in media/webview.js, or these tools would
 * name a session differently from the panel.
 */
const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude', codex: 'Codex', copilotcli: 'Copilot CLI',
};

/** An unrecognized scheme is still more use than a raw resource name. */
function agentLabel(s: { agent?: string | null; serviceName?: string }): string {
  return (s.agent ? AGENT_LABELS[s.agent] ?? s.agent : '') || s.serviceName || '';
}

function nanoToDate(nano: string): string {
  try {
    const ms = Number(BigInt(nano) / 1_000_000n);
    return new Date(ms).toISOString();
  } catch {
    return nano;
  }
}

function severityLabel(n: number): string {
  if (n === 0)  { return 'UNSPEC'; }
  if (n <= 4)   { return 'TRACE'; }
  if (n <= 8)   { return 'DEBUG'; }
  if (n <= 12)  { return 'INFO'; }
  if (n <= 16)  { return 'WARN'; }
  if (n <= 20)  { return 'ERROR'; }
  return 'FATAL';
}

const SPAN_KIND: Record<number, string> = {
  0: 'UNSPECIFIED', 1: 'INTERNAL', 2: 'SERVER', 3: 'CLIENT', 4: 'PRODUCER', 5: 'CONSUMER',
};

const SPAN_STATUS: Record<number, string> = { 0: 'UNSET', 1: 'OK', 2: 'ERROR' };

interface TokenSummary {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  callCount: number;
}

// Attribute-key precedence mirrors the SQL COALESCE chains in engine/src/metrics.ts.
const INPUT_TOKEN_KEYS = ['gen_ai.usage.input_tokens', 'llm.usage.prompt_tokens', 'input_tokens'];
const CACHE_READ_KEYS = [
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_read_input_tokens',
  'gen_ai.usage.cached_tokens',
  'llm.usage.cache_read_input_tokens',
  'llm.usage.cached_tokens',
  'cache_read_tokens',
];
const CACHE_CREATION_KEYS = [
  'gen_ai.usage.cache_creation.input_tokens',
  'gen_ai.usage.cache_creation_input_tokens',
  'llm.usage.cache_creation_input_tokens',
  'cache_creation_tokens',
];

/** First present (non-null) attribute value among `keys`, coerced to a number. */
function firstNum(a: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    if (a[k] != null) { return Number(a[k]) || 0; }
  }
  return 0;
}

/** Aggregate gen_ai / llm token attributes across a set of spans, grouped by model. */
function aggregateTokens(spans: { attributes: Record<string, unknown> }[]): TokenSummary[] {
  const byModel = new Map<string, TokenSummary>();

  for (const s of spans) {
    const a = s.attributes;
    const model = normalizeModelName(String(
      a['gen_ai.request.model'] ?? a['llm.model'] ?? ''
    ));
    const prompt = Number(a['gen_ai.usage.input_tokens'] ?? a['llm.usage.prompt_tokens'] ?? a['input_tokens'] ?? 0);
    const completion = Number(a['gen_ai.usage.output_tokens'] ?? a['llm.usage.completion_tokens'] ?? a['output_tokens'] ?? 0);
    const cacheRead = firstNum(a, CACHE_READ_KEYS);
    const cacheCreation = firstNum(a, CACHE_CREATION_KEYS);

    if (!model && prompt === 0 && completion === 0) { continue; }

    const key = model || 'unknown';
    const existing = byModel.get(key);
    if (existing) {
      existing.promptTokens        += prompt;
      existing.completionTokens    += completion;
      existing.totalTokens         += prompt + completion;
      existing.cachedTokens        += cacheRead;
      existing.cacheCreationTokens += cacheCreation;
      existing.callCount           += 1;
    } else {
      byModel.set(key, {
        model: key,
        promptTokens:        prompt,
        completionTokens:    completion,
        totalTokens:         prompt + completion,
        cachedTokens:        cacheRead,
        cacheCreationTokens: cacheCreation,
        callCount:           1,
      });
    }
  }

  return [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

/**
 * Convention-aware cache-hit rate for a set of spans (mirrors engine/src/metrics.ts).
 *    - Standard/OTel semconv: input_tokens is the TOTAL prompt, cache_read a subset → denom = input.
 *    - Anthropic/Claude Code: input_tokens is only fresh tokens, cache_read/creation are additive →
 *      denom = input + read + creation. Detected by the bare cache_read_tokens/cache_creation_tokens keys.
 * Returns -1 when there is no prompt volume to divide by.
 */
function traceCacheHitRate(spans: { attributes: Record<string, unknown> }[]): number {
  let readTotal = 0;
  let promptTotal = 0;
  for (const s of spans) {
    const a = s.attributes;
    if (a['gen_ai.request.model'] == null && a['llm.model'] == null) { continue; }
    const input = firstNum(a, INPUT_TOKEN_KEYS);
    const read = firstNum(a, CACHE_READ_KEYS);
    const creation = firstNum(a, CACHE_CREATION_KEYS);
    const isAdditive = a['cache_read_tokens'] != null || a['cache_creation_tokens'] != null;
    readTotal += read;
    promptTotal += isAdditive ? input + read + creation : input;
  }
  return promptTotal > 0 ? readTotal / promptTotal : -1;
}


interface FindRecentErrorsInput {
  limit?: number;
  since?: string;
  until?: string;
}

class FindRecentErrorsTool implements vscode.LanguageModelTool<FindRecentErrorsInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FindRecentErrorsInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('findRecentErrors', token, () => this.run(options));
  }

  private run(
    options: vscode.LanguageModelToolInvocationOptions<FindRecentErrorsInput>,
  ): vscode.LanguageModelToolResult {
    const limit = options.input.limit ?? 5;
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const errors = getRecentErrorTraces(this.store.getDb(), limit, sinceNano ?? undefined, untilNano ?? undefined);

    if (!errors.length) {
      const qualifier = (sinceNano || untilNano) ? ` in the requested time window` : '';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`No error traces found${qualifier} in the telemetry store.`),
      ]);
    }

    const lines: string[] = [`Found ${errors.length} error trace(s) — most recent first:\n`];

    for (const t of errors) {
      lines.push(`## ${t.rootSpanName} [${t.serviceName}]`);
      lines.push(`- traceId: ${t.traceId}`);
      lines.push(`- time: ${nanoToDate(t.startTimeUnixNano)}`);
      lines.push(`- duration: ${t.durationMs}ms | spans: ${t.spanCount} | errors: ${t.errorSpans.length}`);
      lines.push(`- ${traceDeeplink(t.traceId, undefined, `↗ Open trace ${t.traceId} in Agent Insights`)}`);

      for (const es of t.errorSpans) {
        lines.push(`\n  ❌ span: ${es.name} (${es.durationMs}ms)`);
        lines.push(`     ${traceDeeplink(t.traceId, es.spanId, `↗ Open error span ${es.spanId} in Agent Insights`)}`);
        if (es.statusMessage)   { lines.push(`     status: ${es.statusMessage}`); }
        if (es.exceptionType)   { lines.push(`     exception.type: ${es.exceptionType}`); }
        if (es.exceptionMessage) { lines.push(`     exception.message: ${es.exceptionMessage}`); }
      }
      lines.push('');
    }

    lines.push('To inspect the full span tree for a trace, call getTrace with its traceId.');

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

interface GetErrorTraceInput {
  traceId: string;
}

/** Attributes surfaced in the trace drill-down. */
const NOTABLE_ATTRS = [
  'exception.type', 'exception.message', 'exception.stacktrace',
  'gen_ai.request.model', 'gen_ai.tool.name',
  'http.method', 'http.url', 'http.status_code',
  'db.system', 'db.statement',
  'rpc.method', 'rpc.service',
];

// Token + tool-call statistics reconstructed from SPANS (gen_ai/llm attributes).
// This is distinct from the OTLP metric instruments in otlpMetrics.ts / the
// webview Metrics tab — do not conflate the two.
class GetTokenAndToolUsageTool implements vscode.LanguageModelTool<{ since?: string; until?: string }> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ since?: string; until?: string }>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('getTokenAndToolUsage', token, () => this.run(options));
  }

  private run(
    options: vscode.LanguageModelToolInvocationOptions<{ since?: string; until?: string }>,
  ): vscode.LanguageModelToolResult {
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const { tokenUsage, toolCalls, summary } = getMetricsData(this.store.getDb(), sinceNano ?? undefined, untilNano ?? undefined);

    const hasTokens = tokenUsage.length > 0;
    const hasTools  = toolCalls.length > 0;

    if (!hasTokens && !hasTools) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'No token or tool-call usage found. Make sure your LLM spans include ' +
          'gen_ai.usage.input_tokens / gen_ai.usage.output_tokens (token usage) ' +
          'and gen_ai.tool.name or tool.name (tool calls).',
        ),
      ]);
    }

    const totalTokens   = tokenUsage.reduce((s, r) => s + r.totalTokens, 0);
    const totalInput    = tokenUsage.reduce((s, r) => s + r.promptTokens, 0);
    const totalOutput   = tokenUsage.reduce((s, r) => s + r.completionTokens, 0);
    const totalLLMCalls = tokenUsage.reduce((s, r) => s + r.callCount, 0);
    const totalToolCalls  = toolCalls.reduce((s, r) => s + r.count, 0);
    const totalToolErrors = toolCalls.reduce((s, r) => s + r.errorCount, 0);
    const toolErrorRate = totalToolCalls > 0
      ? ((totalToolErrors / totalToolCalls) * 100).toFixed(1)
      : '0.0';
    const models = tokenUsage.map(r => r.model).join(', ');

    const lines: string[] = ['# Token & Tool Usage\n'];

    lines.push('## Summary');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    if (hasTokens) {
      lines.push(`| total tokens | ${totalTokens.toLocaleString()} |`);
      lines.push(`| input tokens | ${totalInput.toLocaleString()} |`);
      lines.push(`| output tokens | ${totalOutput.toLocaleString()} |`);
      if (summary.cachedTokens > 0 || summary.cacheCreationTokens > 0) {
        const cacheHitPct = summary.cacheHitRate >= 0
          ? ` (${(summary.cacheHitRate * 100).toFixed(1)}% hit rate)`
          : '';
        lines.push(`| cache hits (read) | ${summary.cachedTokens.toLocaleString()}${cacheHitPct} |`);
        lines.push(`| cache writes (creation) | ${summary.cacheCreationTokens.toLocaleString()} |`);
      }
      lines.push(`| llm calls | ${totalLLMCalls} |`);
      lines.push(`| models | ${models} |`);
    }
    if (hasTools) {
      lines.push(`| tool calls | ${totalToolCalls} |`);
      lines.push(`| tool errors | ${totalToolErrors} (${toolErrorRate}%) |`);
    }
    lines.push('');

    if (hasTokens) {
      lines.push('## Token Usage by Model');
      lines.push('| Model | Total | Input | Output | Calls |');
      lines.push('|---|---|---|---|---|');
      for (const r of tokenUsage) {
        lines.push(`| ${r.model} | ${r.totalTokens.toLocaleString()} | ${r.promptTokens.toLocaleString()} | ${r.completionTokens.toLocaleString()} | ${r.callCount} |`);
      }
      lines.push('');
    } else {
      lines.push('_No token usage data. Ensure LLM spans carry gen_ai.usage.input_tokens / output_tokens._\n');
    }

    if (hasTools) {
      lines.push('## Tool Calls');
      lines.push('| Tool | Calls | Errors | Error % | Avg Duration | Total Duration |');
      lines.push('|---|---|---|---|---|---|');
      for (const r of toolCalls) {
        const errorPct = r.count > 0 ? ((r.errorCount / r.count) * 100).toFixed(1) : '0.0';
        const flag = r.errorCount > 0 ? '⚠️ ' : '';
        lines.push(`| ${flag}${r.toolName} | ${r.count} | ${r.errorCount} | ${errorPct}% | ${r.avgDurationMs}ms | ${r.totalDurationMs}ms |`);
      }
      lines.push('');
    } else {
      lines.push('_No tool call data. Ensure agent spans carry gen_ai.tool.name or tool.name._\n');
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

interface GetSlowestSpansInput {
  limit?: number;
  since?: string;
  until?: string;
}

class GetSlowestSpansTool implements vscode.LanguageModelTool<GetSlowestSpansInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetSlowestSpansInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('getSlowestSpans', token, () => this.run(options));
  }

  private run(
    options: vscode.LanguageModelToolInvocationOptions<GetSlowestSpansInput>,
  ): vscode.LanguageModelToolResult {
    const limit = options.input.limit ?? 10;
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const { slowestOperations } = getMetricsData(this.store.getDb(), sinceNano ?? undefined, untilNano ?? undefined);
    const ops = slowestOperations.slice(0, limit);

    if (!ops.length) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('No span data found.'),
      ]);
    }

    const lines: string[] = [`# Latency (by average duration)\n`];

    ops.forEach((op, i) => {
      const errorPct = op.count > 0 ? ((op.errorCount / op.count) * 100).toFixed(1) : '0.0';
      const flag = op.errorCount > 0 ? ' ⚠️' : '';
      lines.push(`${i + 1}. **${op.name}**${flag}`);
      lines.push(`   avg: ${op.avgDurationMs}ms | max: ${op.maxDurationMs}ms | calls: ${op.count} | errors: ${op.errorCount} (${errorPct}%)`);
    });

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

interface SearchLogsInput {
  query: string;
  minSeverity?: number;
  limit?: number;
  since?: string;
  until?: string;
}

class SearchLogsTool implements vscode.LanguageModelTool<SearchLogsInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SearchLogsInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('searchLogs', token, () => this.run(options));
  }

  private run(
    options: vscode.LanguageModelToolInvocationOptions<SearchLogsInput>,
  ): vscode.LanguageModelToolResult {
    const { query = '', minSeverity = 0, limit = 50 } = options.input;
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const logs = getLogs(this.store.getDb(), { filter: query, minSeverity, limit, sinceNano: sinceNano ?? undefined, untilNano: untilNano ?? undefined });

    if (!logs.length) {
      const qualifier = query ? ` matching "${query}"` : '';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`No logs found${qualifier}.`),
      ]);
    }

    const lines: string[] = [
      `# Log Search${query ? `: "${query}"` : ''} — ${logs.length} result(s)\n`,
    ];

    for (const log of logs) {
      const time = nanoToDate(log.timestampUnixNano);
      const sev  = severityLabel(log.severityNumber);
      lines.push(`[${time}] [${sev}] [${log.serviceName}] ${log.body}`);
      if (log.traceId) { lines.push(`  → traceId: ${log.traceId}`); }
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

// high-level overview of recent telemetry data, including counts, health metrics, slowest operations, token usage, and tool calls.
class SummarizeRecentActivityTool implements vscode.LanguageModelTool<{ since?: string; until?: string }> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ since?: string; until?: string }>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('summarizeRecentActivity', token, () => this.run(options));
  }

  private run(
    options: vscode.LanguageModelToolInvocationOptions<{ since?: string; until?: string }>,
  ): vscode.LanguageModelToolResult {
    const db = this.store.getDb();
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const { summary, slowestOperations, tokenUsage, toolCalls } = getMetricsData(db, sinceNano ?? undefined, untilNano ?? undefined);

    if (summary.totalSpans === 0 && summary.totalLogs === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'No telemetry data yet. Point your OTLP exporter at the receiver to start collecting data.',
        ),
      ]);
    }

    const timeAndParts: string[] = [];
    const timeParam: unknown[] = [];
    if (sinceNano) { timeAndParts.push('AND start_time_unix_nano >= ?'); timeParam.push(sinceNano); }
    if (untilNano) { timeAndParts.push('AND start_time_unix_nano <= ?'); timeParam.push(untilNano); }
    const timeAnd = timeAndParts.join(' ');

    const errorStats = db.prepare(`
      SELECT
        SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END)             AS error_spans,
        COUNT(DISTINCT CASE WHEN status_code = 2 THEN trace_id END)  AS error_traces
      FROM spans
      WHERE 1=1 ${timeAnd}
    `).get(...timeParam);

    const errorSpans  = Number(errorStats?.['error_spans']  ?? 0);
    const errorTraces = Number(errorStats?.['error_traces'] ?? 0);
    const errorRate   = summary.totalSpans > 0
      ? ((errorSpans / summary.totalSpans) * 100).toFixed(1)
      : '0.0';

    // p95 latency from root spans, computed in JS to avoid SQLite dynamic OFFSET
    const durationRows = db.prepare(`
      SELECT duration_ms FROM spans
      WHERE (parent_span_id IS NULL OR parent_span_id = '') ${timeAnd}
      ORDER BY duration_ms ASC
    `).all(...timeParam);
    const durations = durationRows.map(r => Number(r['duration_ms'] ?? 0));
    const p95 = durations.length > 0
      ? durations[Math.floor(durations.length * 0.95)] ?? durations[durations.length - 1]
      : 0;

    const lines: string[] = ['# Recent Activity Summary\n'];

    lines.push('## Counts');
    lines.push(`- Traces: ${summary.totalTraces}`);
    lines.push(`- Spans: ${summary.totalSpans}`);
    lines.push(`- Logs: ${summary.totalLogs}`);
    lines.push(`- Metric points: ${summary.totalMetricPoints}`);

    lines.push('\n## Health');
    lines.push(`- Error traces: ${errorTraces} / ${summary.totalTraces}`);
    lines.push(`- Span error rate: ${errorRate}% (${errorSpans} errored span(s))`);
    lines.push(`- p95 trace duration: ${p95}ms`);

    if (slowestOperations.length) {
      const top = slowestOperations[0];
      lines.push('\n## Slowest operation');
      lines.push(`- ${top.name} — avg ${top.avgDurationMs}ms, max ${top.maxDurationMs}ms (${top.count} call(s))`);
    }

    if (tokenUsage.length) {
      const totalTokens = tokenUsage.reduce((s, r) => s + r.totalTokens, 0);
      lines.push('\n## LLM token usage');
      lines.push(`- Total: ${totalTokens.toLocaleString()} tokens across ${tokenUsage.length} model(s)`);
      lines.push(`- Models: ${tokenUsage.map(r => r.model).join(', ')}`);
    }

    if (toolCalls.length) {
      const totalToolCalls = toolCalls.reduce((s, r) => s + r.count, 0);
      const failingTools   = toolCalls.filter(r => r.errorCount > 0).map(r => r.toolName);
      lines.push('\n## Tool calls');
      lines.push(`- Total: ${totalToolCalls} call(s) across ${toolCalls.length} tool(s)`);
      if (failingTools.length) {
        lines.push(`- Tools with errors: ${failingTools.join(', ')}`);
      }
    }

    lines.push(
      '\n---\n' +
      'For deeper analysis use: findRecentErrors, getTrace, getSlowestSpans, ' +
      'searchLogs, getTokenAndToolUsage, getServiceSummary.',
    );

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

interface GetServiceSummaryInput {
  serviceName?: string;
  since?: string;
  until?: string;
}

class GetServiceSummaryTool implements vscode.LanguageModelTool<GetServiceSummaryInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetServiceSummaryInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('getServiceSummary', token, () => this.run(options));
  }

  private run(
    options: vscode.LanguageModelToolInvocationOptions<GetServiceSummaryInput>,
  ): vscode.LanguageModelToolResult {
    const db = this.store.getDb();
    const { serviceName } = options.input;
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);

    // No serviceName → list available services so the caller can pick
    if (!serviceName?.trim()) {
      const names = getServiceNames(db);
      if (!names.length) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'No telemetry data found. Point your OTLP exporter at the receiver to start collecting data.',
          ),
        ]);
      }
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `# Available Services (${names.length})\n\n` +
          names.map(n => `- ${n}`).join('\n') +
          '\n\nCall this tool again with a serviceName to see its detailed summary.',
        ),
      ]);
    }

    const summary = getServiceSummary(db, serviceName.trim(), sinceNano ?? undefined, untilNano ?? undefined);
    if (!summary) {
      const names = getServiceNames(db);
      const hint = names.length
        ? `\n\nAvailable services: ${names.join(', ')}`
        : '\n\nNo telemetry data found at all.';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Service "${serviceName}" not found in telemetry.${hint}`),
      ]);
    }

    const errorTraceRate = summary.totalTraces > 0
      ? ((summary.errorTraces / summary.totalTraces) * 100).toFixed(1)
      : '0.0';
    const errorSpanRate = summary.totalSpans > 0
      ? ((summary.errorSpans / summary.totalSpans) * 100).toFixed(1)
      : '0.0';
    const totalTokens  = summary.tokenUsage.reduce((s, r) => s + r.totalTokens, 0);
    const totalInput   = summary.tokenUsage.reduce((s, r) => s + r.promptTokens, 0);
    const totalOutput  = summary.tokenUsage.reduce((s, r) => s + r.completionTokens, 0);
    const totalLLMCalls = summary.tokenUsage.reduce((s, r) => s + r.callCount, 0);
    const totalToolCalls  = summary.toolCalls.reduce((s, r) => s + r.count, 0);
    const totalToolErrors = summary.toolCalls.reduce((s, r) => s + r.errorCount, 0);
    const toolErrorRate = totalToolCalls > 0
      ? ((totalToolErrors / totalToolCalls) * 100).toFixed(1)
      : '0.0';
    const models = summary.tokenUsage.map(r => r.model).join(', ');

    const lines: string[] = [`# Service Summary: ${summary.serviceName}\n`];

    lines.push('## Summary');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    lines.push(`| service | ${summary.serviceName} |`);
    lines.push(`| traces | ${summary.totalTraces} |`);
    lines.push(`| error traces | ${summary.errorTraces} (${errorTraceRate}%) |`);
    lines.push(`| spans | ${summary.totalSpans} |`);
    lines.push(`| error spans | ${summary.errorSpans} (${errorSpanRate}%) |`);
    lines.push(`| p50 duration | ${summary.p50Ms}ms |`);
    lines.push(`| p95 duration | ${summary.p95Ms}ms |`);
    if (summary.tokenUsage.length) {
      lines.push(`| total tokens | ${totalTokens.toLocaleString()} |`);
      lines.push(`| input tokens | ${totalInput.toLocaleString()} |`);
      lines.push(`| output tokens | ${totalOutput.toLocaleString()} |`);
      lines.push(`| llm calls | ${totalLLMCalls} |`);
      lines.push(`| models | ${models} |`);
    }
    if (summary.toolCalls.length) {
      lines.push(`| tool calls | ${totalToolCalls} |`);
      lines.push(`| tool errors | ${totalToolErrors} (${toolErrorRate}%) |`);
    }
    lines.push('');

    if (summary.slowestOperations.length) {
      lines.push('## Latency');
      lines.push('| # | Operation | Avg | Max | Calls | Errors |');
      lines.push('|---|---|---|---|---|---|');
      summary.slowestOperations.forEach((op, i) => {
        const flag = op.errorCount > 0 ? ' ⚠️' : '';
        lines.push(`| ${i + 1} | ${op.name}${flag} | ${op.avgDurationMs}ms | ${op.maxDurationMs}ms | ${op.count} | ${op.errorCount} |`);
      });
      lines.push('');
    }

    if (summary.tokenUsage.length) {
      lines.push('## Token Usage by Model');
      lines.push('| Model | Total | Input | Output | Calls |');
      lines.push('|---|---|---|---|---|');
      for (const r of summary.tokenUsage) {
        lines.push(`| ${r.model} | ${r.totalTokens.toLocaleString()} | ${r.promptTokens.toLocaleString()} | ${r.completionTokens.toLocaleString()} | ${r.callCount} |`);
      }
      lines.push('');
    }

    if (summary.toolCalls.length) {
      lines.push('## Tool Calls');
      lines.push('| Tool | Calls | Errors | Error % | Avg Duration |');
      lines.push('|---|---|---|---|---|');
      for (const r of summary.toolCalls) {
        const errorPct = r.count > 0 ? ((r.errorCount / r.count) * 100).toFixed(1) : '0.0';
        const flag = r.errorCount > 0 ? '⚠️ ' : '';
        lines.push(`| ${flag}${r.toolName} | ${r.count} | ${r.errorCount} | ${errorPct}% | ${r.avgDurationMs}ms |`);
      }
      lines.push('');
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

interface ListTracesInput {
  serviceName?: string;
  since?: string;
  until?: string;
  limit?: number;
  errorsOnly?: boolean;
  attributeKey?: string;
  attributeValue?: string;
}

class ListTracesTool implements vscode.LanguageModelTool<ListTracesInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ListTracesInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('listTraces', token, () => this.run(options));
  }

  private run(
    options: vscode.LanguageModelToolInvocationOptions<ListTracesInput>,
  ): vscode.LanguageModelToolResult {
    const { serviceName, errorsOnly = false, attributeKey, attributeValue } = options.input;
    const limit     = options.input.limit ?? 20;
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);

    const tracesOpts: GetTracesOptions = {
      limit,
      sinceNano:      sinceNano ?? undefined,
      untilNano:      untilNano ?? undefined,
      serviceName:    serviceName?.trim() || undefined,
      attributeKey:   attributeKey?.trim() || undefined,
      attributeValue: attributeValue?.trim() || undefined,
    };
    let traces = getTraces(this.store.getDb(), tracesOpts);

    if (errorsOnly) { traces = traces.filter(t => t.hasError); }

    if (!traces.length) {
      const qualifiers: string[] = [];
      if (serviceName)    { qualifiers.push(`service "${serviceName}"`); }
      if (sinceNano)      { qualifiers.push(`after ${options.input.since}`); }
      if (untilNano)      { qualifiers.push(`before ${options.input.until}`); }
      if (attributeKey)   { qualifiers.push(`${attributeKey}=${attributeValue ?? '*'}`); }
      else if (attributeValue) { qualifiers.push(`attribute contains "${attributeValue}"`); }
      if (errorsOnly)     { qualifiers.push(`errors only`); }
      const qualifier = qualifiers.length ? ` for ${qualifiers.join(', ')}` : '';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`No traces found${qualifier}.`),
      ]);
    }

    const header = [
      `# Traces (${traces.length} shown, most recent first)`,
      serviceName ? `Service: ${serviceName}` : '',
      options.input.since ? `Since: ${options.input.since}` : '',
      options.input.until ? `Until: ${options.input.until}` : '',
      attributeKey ? `Attribute: ${attributeKey}=${attributeValue ?? '*'}` : (attributeValue ? `Attribute contains: ${attributeValue}` : ''),
    ].filter(Boolean).join(' · ') + '\n';

    const lines: string[] = [header];

    for (const t of traces) {
      const status  = t.hasError ? '❌' : '✅';
      const time    = nanoToDate(t.startTimeUnixNano);
      lines.push(`${status} **${t.rootSpanName}** [${t.serviceName}]`);
      lines.push(`   traceId: \`${t.traceId}\``);
      lines.push(`   time: ${time} | duration: ${t.durationMs}ms | spans: ${t.spanCount}`);
      lines.push(`   ${traceDeeplink(t.traceId, undefined, `↗ Open trace ${t.traceId} in Agent Insights`)}`);
      lines.push('');
    }

    if (attributeValue) {
      const matchDesc = attributeKey
        ? `"${attributeKey}" = "${attributeValue}"`
        : `"${attributeValue}" (substring match across all span attributes)`;
      lines.push(`> Traces above were matched because at least one span contains ${matchDesc}.`);
      lines.push(`> The match may appear in any span — not necessarily the root. Call getTrace on a traceId to see exactly which span(s) matched.`);
      lines.push('');
    }

    lines.push(
      `Present each trace individually with its traceId. ` +
      `Do not group or summarize — list them so the user can identify specific runs. ` +
      `Call getTrace on any traceId to drill into its full span tree.`
    );

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

interface GetTraceInput {
  traceId: string;
}

class GetTraceTool implements vscode.LanguageModelTool<GetTraceInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetTraceInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('getTrace', token, () => this.run(options));
  }

  private run(
    options: vscode.LanguageModelToolInvocationOptions<GetTraceInput>,
  ): vscode.LanguageModelToolResult {
    const { traceId } = options.input;
    if (!traceId?.trim()) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('Error: traceId is required.'),
      ]);
    }

    const db = this.store.getDb();
    const normalizedTraceId = traceId.trim();
    const spans = getSpansByTraceId(db, normalizedTraceId);

    if (!spans.length) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`No spans found for traceId: ${traceId}`),
      ]);
    }

    const spanIds = new Set(spans.map(span => span.spanId));
    const root = spans.find(s => !s.parentSpanId || !spanIds.has(s.parentSpanId)) ?? spans[0]!;
    const sessionId = getSessionIdForTrace(db, root.traceId);
    const hasErrors = spans.some(s => s.statusCode === 2);
    const errorCount = spans.filter(s => s.statusCode === 2).length;

    // Aggregate token usage across all LLM spans in this trace
    const tokensByModel = aggregateTokens(spans);
    const totalTokens  = tokensByModel.reduce((s, t) => s + t.totalTokens, 0);
    const totalInput   = tokensByModel.reduce((s, t) => s + t.promptTokens, 0);
    const totalOutput  = tokensByModel.reduce((s, t) => s + t.completionTokens, 0);
    const totalCached  = tokensByModel.reduce((s, t) => s + t.cachedTokens, 0);
    const totalCacheCreation = tokensByModel.reduce((s, t) => s + t.cacheCreationTokens, 0);
    const totalLLMCalls = tokensByModel.reduce((s, t) => s + t.callCount, 0);
    const cacheHitRate = traceCacheHitRate(spans);
    const models = tokensByModel.map(t => t.model).join(', ');

    const lines: string[] = [
      `# Trace: \`${traceId}\``,
      '',
      '## Summary',
      '| Field | Value |',
      '|---|---|',
      `| traceId | \`${traceId}\` |`,
      ...(sessionId ? [`| sessionId | \`${sessionId}\` |`] : []),
      `| service | ${root.serviceName} |`,
      `| root span | ${root.name} |`,
      `| started | ${nanoToDate(root.startTimeUnixNano)} |`,
      `| duration | ${root.durationMs}ms |`,
      `| spans | ${spans.length} |`,
      `| errors | ${errorCount} |`,
      `| status | ${hasErrors ? '❌ Has errors' : '✅ No errors'} |`,
      ...(tokensByModel.length ? [
        `| total tokens | ${totalTokens.toLocaleString()} |`,
        `| input tokens | ${totalInput.toLocaleString()} |`,
        `| output tokens | ${totalOutput.toLocaleString()} |`,
        ...(totalCached > 0 || totalCacheCreation > 0 ? [
          `| cache hits (read) | ${totalCached.toLocaleString()}${cacheHitRate >= 0 ? ` (${(cacheHitRate * 100).toFixed(1)}% hit rate)` : ''} |`,
          `| cache writes (creation) | ${totalCacheCreation.toLocaleString()} |`,
        ] : []),
        `| llm calls | ${totalLLMCalls} |`,
        `| models | ${models} |`,
      ] : []),
      '',
      ...(sessionId ? [
        sessionDeeplink(sessionId, `↗ Open session ${sessionId} in Agent Insights`),
        '',
      ] : []),
      traceDeeplink(traceId, undefined, `↗ Open trace ${traceId} in Agent Insights`),
      '',
    ];

    if (tokensByModel.length > 1) {
      const anyCache = tokensByModel.some(t => t.cachedTokens > 0 || t.cacheCreationTokens > 0);
      lines.push('### Token Breakdown by Model');
      if (anyCache) {
        lines.push('| Model | Total | Input | Output | Cache Read | Cache Write | Calls |');
        lines.push('|---|---|---|---|---|---|---|');
        for (const t of tokensByModel) {
          lines.push(`| ${t.model} | ${t.totalTokens.toLocaleString()} | ${t.promptTokens.toLocaleString()} | ${t.completionTokens.toLocaleString()} | ${t.cachedTokens.toLocaleString()} | ${t.cacheCreationTokens.toLocaleString()} | ${t.callCount} |`);
        }
      } else {
        lines.push('| Model | Total | Input | Output | Calls |');
        lines.push('|---|---|---|---|---|');
        for (const t of tokensByModel) {
          lines.push(`| ${t.model} | ${t.totalTokens.toLocaleString()} | ${t.promptTokens.toLocaleString()} | ${t.completionTokens.toLocaleString()} | ${t.callCount} |`);
        }
      }
      lines.push('');
    }

    lines.push('## Span Detail');
    lines.push('');

    for (const s of spans) {
      const isError = s.statusCode === 2;
      const prefix  = isError ? '❌' : '  ';
      const status  = SPAN_STATUS[s.statusCode] ?? String(s.statusCode);
      const kind    = SPAN_KIND[s.kind] ?? String(s.kind);
      const indent  = s.parentSpanId ? '  ' : '';

      lines.push(`${indent}${prefix} [${status}] ${s.name}  (${kind}, ${s.durationMs}ms)`);
      lines.push(`${indent}   spanId: ${s.spanId}${s.parentSpanId ? ` | parent: ${s.parentSpanId}` : ' | ROOT'}`);
      lines.push(`${indent}   started: ${nanoToDate(s.startTimeUnixNano)}`);
      lines.push(`${indent}   ${traceDeeplink(traceId, s.spanId, `↗ Open span ${s.spanId} in Agent Insights`)}`);

      if (isError && s.statusMessage) {
        lines.push(`${indent}   status message: ${s.statusMessage}`);
      }

      for (const key of NOTABLE_ATTRS) {
        const val = s.attributes[key];
        if (val != null) {
          const str = String(val);
          lines.push(`${indent}   ${key}: ${str.length > 300 ? str.slice(0, 300) + '…' : str}`);
        }
      }
      lines.push('');
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}


interface GetSessionSummaryInput {
  sessionId?: string;
  limit?: number;
}

class GetSessionSummaryTool implements vscode.LanguageModelTool<GetSessionSummaryInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetSessionSummaryInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('getSessionSummary', token, () => this.run(options));
  }

  private run(
    options: vscode.LanguageModelToolInvocationOptions<GetSessionSummaryInput>,
  ): vscode.LanguageModelToolResult {
    const db = this.store.getDb();
    const { sessionId } = options.input;

    // No sessionId → list recent sessions so the caller can pick one.
    if (!sessionId?.trim()) {
      const limit = Math.max(1, Math.min(Number(options.input.limit) || 20, 100));
      const sessions = getSessions(db, { limit });
      if (!sessions.length) {
        return textResult(
          'No agent sessions found yet. Point an agent host or CLI at the receiver ' +
          'over OTLP to start collecting sessions.',
        );
      }
      const lines: string[] = [`# Recent Sessions (${sessions.length})\n`];
      lines.push('| # | Session ID | Agent | Outcome | Turns | Tools | Tokens | Duration | Models | Open |');
      lines.push('|---|---|---|---|---|---|---|---|---|---|');
      sessions.forEach((s, i) => {
        const outcome = s.hasError ? '⚠️ Failed' : 'OK';
        lines.push(
          `| ${i + 1} | \`${s.sessionId}\` | ${agentLabel(s) || '—'} | ${outcome} | ` +
          `${s.traceCount} | ${s.toolCallCount} | ${s.totalTokens.toLocaleString()} | ` +
          `${s.durationMs}ms | ${s.models.join(', ') || '—'} | ${sessionDeeplink(s.sessionId, '↗ Open session')} |`,
        );
      });
      lines.push('\nCall this tool again with a sessionId to get its full summary.');
      return textResult(lines.join('\n'));
    }

    const summary = getSessionSummary(db, sessionId.trim());
    if (!summary) {
      const recent = getSessions(db, { limit: 10 });
      const hint = recent.length
        ? `\n\nRecent sessions:\n${recent.map(s => `- \`${s.sessionId}\` (${agentLabel(s) || 'unknown'}) — ${sessionDeeplink(s.sessionId, '↗ Open session')}`).join('\n')}`
        : '\n\nNo agent sessions found at all.';
      return textResult(`Session "${sessionId}" not found.${hint}`);
    }

    const lines: string[] = [
      '# Session Summary\n',
      sessionDeeplink(summary.sessionId, `↗ Open session ${summary.sessionId} in Agent Insights`),
      '',
    ];

    // Outcome + key stats
    lines.push('## Overview');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    lines.push(`| session id | \`${summary.sessionId}\` |`);
    if (summary.agent) { lines.push(`| agent | ${agentLabel(summary)} |`); }
    lines.push(`| service | ${summary.serviceName || '—'} |`);
    lines.push(`| outcome | ${summary.hasError ? '⚠️ Failed' : 'OK'} |`);
    if (summary.failures.length) {
      lines.push(`| errored spans | ${summary.errorCount} |`);
      lines.push(`| distinct failures | ${summary.failures.length} |`);
      summary.failures.forEach((f, i) => {
        const times = f.count > 1 ? ` (×${f.count})` : '';
        lines.push(`| failure ${i + 1} | ${f.spanName}: ${f.message ?? 'no message'}${times} — trace \`${f.traceId}\` |`);
      });
    } else if (summary.failureReason) {
      lines.push(`| failure reason | ${summary.failureReason} |`);
    }
    lines.push(`| started | ${nanoToDate(summary.startTimeUnixNano)} |`);
    lines.push(`| duration | ${summary.durationMs}ms |`);
    lines.push(`| turns (traces) | ${summary.traceCount} |`);
    lines.push(`| spans | ${summary.spanCount} |`);
    lines.push(`| llm requests | ${summary.llmRequestCount} |`);
    lines.push(`| tool calls | ${summary.toolCallCount} |`);
    if (summary.totalTokens > 0) {
      lines.push(`| total tokens | ${summary.totalTokens.toLocaleString()} |`);
      lines.push(`| input tokens | ${summary.inputTokens.toLocaleString()} |`);
      lines.push(`| output tokens | ${summary.outputTokens.toLocaleString()} |`);
    }
    if (summary.models.length) {
      lines.push(`| models | ${summary.models.join(', ')} |`);
    }
    lines.push('');

    // Turn-by-turn timeline (what happened)
    if (summary.turns.length) {
      lines.push('## Timeline (turn by turn)');
      lines.push('| # | Trace | Root | Duration | LLM | Tools | Tokens | Status |');
      lines.push('|---|---|---|---|---|---|---|---|');
      summary.turns.forEach((t, i) => {
        const status = t.hasError
          ? `⚠️ ${t.errorCount} error${t.errorCount === 1 ? '' : 's'}: ${t.failures.map(f => `${f.spanName}: ${f.message ?? 'no message'}`).join('; ') || t.failureReason || 'error'}`
          : 'OK';
        lines.push(
          `| ${i + 1} | \`${t.traceId}\` | ${t.rootName || '—'} | ${t.durationMs}ms | ` +
          `${t.llmRequestCount} | ${t.toolCallCount} | ${t.totalTokens.toLocaleString()} | ${status} |`,
        );
      });
      lines.push('');
    }

    // Tool usage
    if (summary.toolStats.length) {
      lines.push('## Tool Usage');
      lines.push('| Tool | Calls | Errors |');
      lines.push('|---|---|---|');
      for (const t of summary.toolStats) {
        const flag = t.errorCount > 0 ? '⚠️ ' : '';
        lines.push(`| ${flag}${t.toolName} | ${t.count} | ${t.errorCount} |`);
      }
      lines.push('');
    }

    // Token usage by model
    if (summary.modelTokens.length) {
      lines.push('## Token Usage by Model');
      lines.push('| Model | Total | Input | Output | Calls |');
      lines.push('|---|---|---|---|---|');
      for (const m of summary.modelTokens) {
        lines.push(
          `| ${m.model} | ${m.totalTokens.toLocaleString()} | ${m.inputTokens.toLocaleString()} | ` +
          `${m.outputTokens.toLocaleString()} | ${m.callCount} |`,
        );
      }
      lines.push('');
    }

    // Errors (for the failure narrative)
    if (summary.errors.length) {
      lines.push(`## Errors (${summary.errors.length})`);
      summary.errors.forEach((e, i) => {
        const detail = e.exceptionMessage ?? e.statusMessage ?? e.exceptionType ?? 'no message';
        const type = e.exceptionType ? ` [${e.exceptionType}]` : '';
        lines.push(`${i + 1}. **${e.spanName}**${type} (trace \`${e.traceId}\`): ${detail}`);
      });
      lines.push('');
    }

    lines.push(
      '---\n' +
      'Use this data to describe what happened, the outcome, and key stats. ' +
      'Drill into any turn with getTrace using its trace id.',
    );

    return textResult(lines.join('\n'));
  }
}

// Transcript caps. Captured gen_ai messages are unbounded raw JSON, so a whole
// session can be hundreds of KB — far more than a context window tolerates. The
// tool therefore returns a window of turns with each turn's text truncated, and
// tells the model how to page rather than silently dropping content.
const DEFAULT_TURN_WINDOW    = 10;
const MAX_TURN_WINDOW        = 25;
const DEFAULT_CHARS_PER_TURN = 1_500;
const MAX_CHARS_PER_TURN     = 6_000;
/** Hard ceiling on the whole result, enforced even when the per-turn caps allow more. */
const TRANSCRIPT_CHAR_BUDGET = 40_000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated, ${text.length} chars total]` : text;
}

interface FlatMessage {
  text: string;
  reasoning: string[];
  toolCalls: { name: string; args?: unknown }[];
}

/**
 * Flattens a raw `gen_ai.output.messages` JSON string into plain text, reasoning
 * blocks, and tool calls. Part shapes mirror the webview's message renderer so
 * both surfaces read the same telemetry the same way.
 */
function flattenOutputMessages(json: string): FlatMessage {
  const out: FlatMessage = { text: '', reasoning: [], toolCalls: [] };
  let arr: unknown;
  try { arr = JSON.parse(json); } catch { return out; }
  if (!Array.isArray(arr)) { return out; }

  for (const msg of arr) {
    if (!msg || typeof msg !== 'object') { continue; }
    const m = msg as { parts?: unknown; content?: unknown };
    const parts: unknown[] = Array.isArray(m.parts)
      ? m.parts
      : (m.content != null ? [{ type: 'text', content: m.content }] : []);

    for (const p of parts) {
      if (typeof p === 'string') { out.text += (out.text ? '\n' : '') + p; continue; }
      if (!p || typeof p !== 'object') { continue; }
      const part = p as { type?: unknown; content?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
      switch (part.type) {
        case 'text':
          out.text += (out.text ? '\n' : '') + String(part.content ?? part.text ?? '');
          break;
        case 'reasoning':
          out.reasoning.push(String(part.content ?? part.text ?? ''));
          break;
        case 'tool_call':
          out.toolCalls.push({ name: String(part.name ?? 'tool'), args: part.arguments });
          break;
        default:
          break;
      }
    }
  }
  return out;
}

interface GetSessionMessagesInput {
  sessionId?: string;
  fromTurn?: number;
  turnCount?: number;
  maxCharsPerTurn?: number;
  limit?: number;
}

class GetSessionMessagesTool implements vscode.LanguageModelTool<GetSessionMessagesInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetSessionMessagesInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('getSessionMessages', token, () => this.run(options));
  }

  private run(
    options: vscode.LanguageModelToolInvocationOptions<GetSessionMessagesInput>,
  ): vscode.LanguageModelToolResult {
    const db = this.store.getDb();
    const { sessionId } = options.input;

    // No sessionId → list recent sessions so the caller can pick one.
    if (!sessionId?.trim()) {
      const limit = Math.max(1, Math.min(Number(options.input.limit) || 20, 100));
      const sessions = getSessions(db, { limit });
      if (!sessions.length) {
        return textResult(
          'No agent sessions found yet. Point an agent host or CLI at the receiver ' +
          'over OTLP to start collecting sessions.',
        );
      }
      const lines: string[] = [`# Recent Sessions (${sessions.length})\n`];
      lines.push('| # | Session ID | Agent | Outcome | Turns | Models | Open |');
      lines.push('|---|---|---|---|---|---|---|');
      sessions.forEach((s, i) => {
        lines.push(
          `| ${i + 1} | \`${s.sessionId}\` | ${agentLabel(s) || '—'} | ${s.hasError ? '⚠️ Failed' : 'OK'} | ` +
          `${s.traceCount} | ${s.models.join(', ') || '—'} | ${sessionDeeplink(s.sessionId, '↗ Open session')} |`,
        );
      });
      lines.push('\nCall this tool again with a sessionId to read its transcript.');
      return textResult(lines.join('\n'));
    }

    const messages = getSessionMessages(db, sessionId.trim());
    if (!messages) {
      const recent = getSessions(db, { limit: 10 });
      const hint = recent.length
        ? `\n\nRecent sessions:\n${recent.map(s => `- \`${s.sessionId}\` (${agentLabel(s) || 'unknown'}) — ${sessionDeeplink(s.sessionId, '↗ Open session')}`).join('\n')}`
        : '\n\nNo agent sessions found at all.';
      return textResult(`Session "${sessionId}" not found.${hint}`);
    }

    // The session exists but nothing was captured — say so explicitly, since an
    // empty transcript otherwise reads as "the user and model said nothing".
    if (!messages.captureEnabled) {
      return textResult(
        `Session \`${messages.sessionId}\` has no captured message content.\n\n` +
        `${sessionDeeplink(messages.sessionId, `↗ Open session ${messages.sessionId} in Agent Insights`)}\n\n` +
        'The agent recorded this session with content capture disabled, so prompts and ' +
        'responses were never exported — only span metadata exists. Do NOT infer what was ' +
        'said. Use `agent-insights_getSessionSummary` for what happened structurally ' +
        '(timeline, tool usage, errors), and tell the user that transcript content requires ' +
        'enabling gen_ai content capture in their agent before the session runs.',
      );
    }

    const total    = messages.turns.length;
    const rawFrom  = Math.trunc(Number(options.input.fromTurn) || 1);
    const from     = Math.max(1, Math.min(rawFrom, total));
    const window   = Math.max(
      1,
      Math.min(Math.trunc(Number(options.input.turnCount) || DEFAULT_TURN_WINDOW), MAX_TURN_WINDOW),
    );
    const maxChars = Math.max(
      200,
      Math.min(Math.trunc(Number(options.input.maxCharsPerTurn) || DEFAULT_CHARS_PER_TURN), MAX_CHARS_PER_TURN),
    );
    const to = Math.min(from + window - 1, total);

    const lines: string[] = [
      '# Session Transcript\n',
      sessionDeeplink(messages.sessionId, `↗ Open session ${messages.sessionId} in Agent Insights`),
      '',
    ];
    lines.push(`Session \`${messages.sessionId}\` — ${total} captured turn${total === 1 ? '' : 's'}, showing ${from}–${to}.\n`);

    let budgetSpent = 0;
    let stoppedAt: number | null = null;

    for (let i = from - 1; i < to; i++) {
      if (budgetSpent >= TRANSCRIPT_CHAR_BUDGET) { stoppedAt = i; break; }

      const t     = messages.turns[i];
      const flat  = flattenOutputMessages(t.outputMessages);
      const block: string[] = [];

      const model  = t.model ? ` — ${normalizeModelName(t.model)}` : '';
      const status = t.hasError ? ' ⚠️ errored' : '';
      block.push(`## Turn ${i + 1}${model}${status}`);
      block.push(`_trace \`${t.traceId}\` · span \`${t.spanId}\` · ${nanoToDate(t.startTimeUnixNano)}_`);

      block.push(`\n**User:** ${t.inputPreview ? truncate(t.inputPreview, maxChars) : '_(no user prompt captured for this turn)_'}`);

      if (flat.text.trim()) {
        block.push(`\n**Assistant:** ${truncate(flat.text.trim(), maxChars)}`);
      } else {
        block.push('\n**Assistant:** _(no text — the model replied with tool calls only)_');
      }

      if (flat.reasoning.length) {
        const joined = flat.reasoning.join('\n').trim();
        if (joined) {
          block.push(`\n**Reasoning (${flat.reasoning.length} block${flat.reasoning.length === 1 ? '' : 's'}):** ${truncate(joined, Math.floor(maxChars / 2))}`);
        }
      }

      if (flat.toolCalls.length) {
        const names = flat.toolCalls.map(c => {
          const args = c.args == null ? '' : truncate(typeof c.args === 'string' ? c.args : JSON.stringify(c.args), 200);
          return args ? `\`${c.name}\`(${args})` : `\`${c.name}\``;
        });
        block.push(`\n**Tool calls (${flat.toolCalls.length}):** ${names.join(', ')}`);
      }

      const rendered = block.join('\n') + '\n';
      budgetSpent += rendered.length;
      lines.push(rendered);
    }

    if (stoppedAt !== null) {
      lines.push(
        `_Output budget reached — stopped after turn ${stoppedAt}. ` +
        `Call again with fromTurn=${stoppedAt + 1}, or lower maxCharsPerTurn._\n`,
      );
    } else if (to < total) {
      lines.push(`_${total - to} more turn${total - to === 1 ? '' : 's'} available — call again with fromTurn=${to + 1}._\n`);
    }

    lines.push(
      '---\n' +
      'This is what was actually said, so use it to explain WHY a session went the way it ' +
      'did — misunderstood intent, a wrong assumption, a repeated failing approach. ' +
      'Quote sparingly and do not invent content beyond what is shown; text marked truncated ' +
      'is incomplete. For structure (timeline, tool counts, tokens, errors) use ' +
      '`agent-insights_getSessionSummary` instead.',
    );

    return textResult(lines.join('\n'));
  }
}

export function registerTools(
  context: vscode.ExtensionContext,
  store: TelemetryStore,
): void {
  context.subscriptions.push(
    vscode.lm.registerTool('agent-insights_findRecentErrors',        new FindRecentErrorsTool(store)),
    vscode.lm.registerTool('agent-insights_getTokenAndToolUsage',    new GetTokenAndToolUsageTool(store)),
    vscode.lm.registerTool('agent-insights_getSlowestSpans',         new GetSlowestSpansTool(store)),
    vscode.lm.registerTool('agent-insights_searchLogs',              new SearchLogsTool(store)),
    vscode.lm.registerTool('agent-insights_summarizeRecentActivity', new SummarizeRecentActivityTool(store)),
    vscode.lm.registerTool('agent-insights_getServiceSummary',       new GetServiceSummaryTool(store)),
    vscode.lm.registerTool('agent-insights_getSessionSummary',       new GetSessionSummaryTool(store)),
    vscode.lm.registerTool('agent-insights_getSessionMessages',      new GetSessionMessagesTool(store)),
    vscode.lm.registerTool('agent-insights_listTraces',              new ListTracesTool(store)),
    vscode.lm.registerTool('agent-insights_getTrace',                new GetTraceTool(store)),
  );
}
