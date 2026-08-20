import * as vscode from 'vscode';
import {
  normalizeModelName,
  parseSinceNano,
  parseUntilNano,
  type GetTracesOptions,
} from '@agent-insights/engine';
import {
  AGENT_HOST_SERVICE_NAME,
  isVisibleModel,
  TOKEN_CHAT_OPERATION,
  TOKEN_ATTRIBUTE_KEYS,
  TOKEN_OPERATION_ATTRIBUTE,
  firstNumericAttribute,
  firstStringAttribute,
  isAdditiveTokenAccounting,
  type ModelVisibilityOptions,
  type Span,
} from '@agent-insights/types';
import type { TelemetryDatabase } from './database/service';
import { getModelVisibility } from './modelVisibility';

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
 * The database runs in a worker, so timeout/cancellation can settle the tool promptly
 * without blocking the extension host. sql.js still cannot interrupt a query already
 * executing in that worker; its eventual result is simply ignored.
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
        `Tool "${toolName}" timed out after ${TOOL_TIMEOUT_MS / 1000}s. ` +
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

function millisToDate(millis: number): string {
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? String(millis) : date.toISOString();
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

function markdownTableCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function formatMetricNumber(value: number): string {
  if (!Number.isFinite(value)) { return String(value); }
  const magnitude = Math.abs(value);
  if ((magnitude > 0 && magnitude < 0.001) || magnitude >= 1_000_000_000) {
    return value.toExponential(3);
  }
  return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function formatMetricValue(value: number, unit: string): string {
  return `${formatMetricNumber(value)}${unit ? ` ${unit}` : ''}`;
}

function formatBucketWidth(bucketMs: number): string {
  if (bucketMs % 86_400_000 === 0) { return `${bucketMs / 86_400_000}d`; }
  if (bucketMs % 3_600_000 === 0) { return `${bucketMs / 3_600_000}h`; }
  if (bucketMs % 60_000 === 0) { return `${bucketMs / 60_000}m`; }
  if (bucketMs % 1_000 === 0) { return `${bucketMs / 1_000}s`; }
  return `${bucketMs}ms`;
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

/** Aggregate gen_ai / llm token attributes across a set of spans, grouped by model. */
function aggregateTokens(
  spans: Span[],
  visibility?: ModelVisibilityOptions,
): TokenSummary[] {
  const byModel = new Map<string, TokenSummary>();
  const bySpanId = new Map(spans.map(span => [span.spanId, span]));

  for (const s of spans) {
    const a = s.attributes;
    const operation = firstStringAttribute(a, [TOKEN_OPERATION_ATTRIBUTE]);
    const hasTokenValue = [
      ...TOKEN_ATTRIBUTE_KEYS.input,
      ...TOKEN_ATTRIBUTE_KEYS.output,
      ...TOKEN_ATTRIBUTE_KEYS.cacheRead,
      ...TOKEN_ATTRIBUTE_KEYS.cacheCreation,
    ].some(key => a[key] !== null && a[key] !== undefined);
    const hasDirectModel = TOKEN_ATTRIBUTE_KEYS.model.some(
      key => a[key] !== null && a[key] !== undefined,
    );
    const isLegacyLeaf = operation === ''
      && (
        s.name === 'chat'
        || s.name.startsWith('chat ')
        || s.name.includes('llm_request')
        || s.name === 'handle_responses'
      );
    if (
      s.serviceName === AGENT_HOST_SERVICE_NAME
      || s.name.startsWith('vscode.agent_host.')
      || (!hasTokenValue && !hasDirectModel)
      || (operation !== TOKEN_CHAT_OPERATION && !isLegacyLeaf)
    ) {
      continue;
    }

    let model = firstStringAttribute(a, TOKEN_ATTRIBUTE_KEYS.model);
    let parentSpanId = s.parentSpanId;
    for (let depth = 0; !model && parentSpanId && depth < 64; depth++) {
      const parent = bySpanId.get(parentSpanId);
      if (!parent) { break; }
      model = firstStringAttribute(parent.attributes, TOKEN_ATTRIBUTE_KEYS.model);
      parentSpanId = parent.parentSpanId;
    }
    model = normalizeModelName(model);
    if (!isVisibleModel(model || 'unknown', visibility)) { continue; }
    const input = firstNumericAttribute(a, TOKEN_ATTRIBUTE_KEYS.input);
    const completion = firstNumericAttribute(a, TOKEN_ATTRIBUTE_KEYS.output);
    const cacheRead = firstNumericAttribute(a, TOKEN_ATTRIBUTE_KEYS.cacheRead);
    const cacheCreation = firstNumericAttribute(a, TOKEN_ATTRIBUTE_KEYS.cacheCreation);
    const prompt = isAdditiveTokenAccounting(a)
      ? input + cacheRead + cacheCreation
      : input;

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

interface FindRecentErrorsInput {
  limit?: number;
  since?: string;
  until?: string;
}

class FindRecentErrorsTool implements vscode.LanguageModelTool<FindRecentErrorsInput> {
  constructor(private readonly database: TelemetryDatabase) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FindRecentErrorsInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('findRecentErrors', token, () => this.run(options));
  }

  private async run(
    options: vscode.LanguageModelToolInvocationOptions<FindRecentErrorsInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const limit = options.input.limit ?? 5;
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const errors = await this.database.request('getRecentErrorTraces', {
      limit,
      sinceNano: sinceNano ?? undefined,
      untilNano: untilNano ?? undefined,
    });

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

/** Attributes surfaced in the trace drill-down. */
const NOTABLE_ATTRS = [
  'exception.type', 'exception.message', 'exception.stacktrace',
  'gen_ai.request.model', 'gen_ai.tool.name',
  'http.method', 'http.url', 'http.status_code',
  'db.system', 'db.statement',
  'rpc.method', 'rpc.service',
];

// Token + tool-call statistics reconstructed from SPANS (gen_ai/llm attributes).
// This is distinct from the OTLP metric instruments in metrics.ts / the
// webview Metrics tab — do not conflate the two.
class GetTokenAndToolUsageTool implements vscode.LanguageModelTool<{ since?: string; until?: string }> {
  constructor(private readonly database: TelemetryDatabase) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ since?: string; until?: string }>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('getTokenAndToolUsage', token, () => this.run(options));
  }

  private async run(
    options: vscode.LanguageModelToolInvocationOptions<{ since?: string; until?: string }>,
  ): Promise<vscode.LanguageModelToolResult> {
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const { tokenUsage, toolCalls, summary } = await this.database.request('getAgentAnalytics', {
      sinceNano: sinceNano ?? undefined,
      untilNano: untilNano ?? undefined,
      visibility: getModelVisibility(),
    });

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
  constructor(private readonly database: TelemetryDatabase) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetSlowestSpansInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('getSlowestSpans', token, () => this.run(options));
  }

  private async run(
    options: vscode.LanguageModelToolInvocationOptions<GetSlowestSpansInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const limit = options.input.limit ?? 10;
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const { slowestOperations } = await this.database.request('getAgentAnalytics', {
      sinceNano: sinceNano ?? undefined,
      untilNano: untilNano ?? undefined,
      visibility: getModelVisibility(),
    });
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
  constructor(private readonly database: TelemetryDatabase) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SearchLogsInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('searchLogs', token, () => this.run(options));
  }

  private async run(
    options: vscode.LanguageModelToolInvocationOptions<SearchLogsInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const { query = '', minSeverity = 0, limit = 50 } = options.input;
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const logs = await this.database.request('getLogs', {
      filter: query,
      minSeverity,
      limit,
      sinceNano: sinceNano ?? undefined,
      untilNano: untilNano ?? undefined,
    });

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

interface ListMetricsInput {
  name?: string;
  serviceName?: string;
  metricType?: string;
  since?: string;
  until?: string;
  limit?: number;
}

class ListMetricsTool implements vscode.LanguageModelTool<ListMetricsInput> {
  constructor(private readonly database: TelemetryDatabase) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ListMetricsInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('listMetrics', token, () => this.run(options));
  }

  private async run(
    options: vscode.LanguageModelToolInvocationOptions<ListMetricsInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const nameFilter = options.input.name?.trim().toLowerCase() ?? '';
    const serviceName = options.input.serviceName?.trim();
    const metricType = options.input.metricType?.trim().toLowerCase();
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const limit = Math.max(1, Math.min(options.input.limit ?? 30, 100));

    let instruments = await this.database.request('getMetricInstruments', {
      sinceNano: sinceNano ?? undefined,
      untilNano: untilNano ?? undefined,
    });
    if (nameFilter) {
      instruments = instruments.filter(instrument => instrument.name.toLowerCase().includes(nameFilter));
    }
    if (serviceName !== undefined) {
      instruments = instruments.filter(instrument => instrument.serviceName === serviceName);
    }
    if (metricType) {
      instruments = instruments.filter(instrument => instrument.metricType.toLowerCase() === metricType);
    }

    if (!instruments.length) {
      const qualifiers = [
        options.input.name ? `name containing "${options.input.name}"` : '',
        serviceName !== undefined ? `service "${serviceName || '(none)'}"` : '',
        metricType ? `type "${metricType}"` : '',
        options.input.since ? `since ${options.input.since}` : '',
        options.input.until ? `until ${options.input.until}` : '',
      ].filter(Boolean);
      return textResult(`No OTLP metric instruments found${qualifiers.length ? ` for ${qualifiers.join(', ')}` : ''}.`);
    }

    const visible = instruments.slice(0, limit);
    const lines = [
      `# OTLP Metric Instruments (${visible.length}${instruments.length > visible.length ? ` of ${instruments.length}` : ''} shown)\n`,
      '| Name | Service | Type | Unit | Series | Points | Last report |',
      '|---|---|---|---|---:|---:|---|',
    ];
    for (const instrument of visible) {
      lines.push(
        `| ${markdownTableCell(instrument.name)} | ` +
        `${markdownTableCell(instrument.serviceName || '(none)')} | ` +
        `${markdownTableCell(instrument.metricType)} | ` +
        `${markdownTableCell(instrument.unit || '(unitless)')} | ` +
        `${instrument.seriesCount} | ${instrument.pointCount} | ` +
        `${nanoToDate(instrument.lastTimestampNano)} |`,
      );
    }
    if (instruments.length > visible.length) {
      lines.push(`\n${instruments.length - visible.length} more instrument(s) omitted. Narrow the filters or increase limit.`);
    }
    lines.push(
      '\nCall getMetric with an exact name and serviceName from this table to inspect its values, trend, comparison, and dimensions. ' +
      'For a service shown as "(none)", pass an empty serviceName.',
    );
    return textResult(lines.join('\n'));
  }
}

interface GetMetricInput {
  name: string;
  serviceName: string;
  since?: string;
  until?: string;
}

class GetMetricTool implements vscode.LanguageModelTool<GetMetricInput> {
  constructor(private readonly database: TelemetryDatabase) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetMetricInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('getMetric', token, () => this.run(options));
  }

  private async run(
    options: vscode.LanguageModelToolInvocationOptions<GetMetricInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const name = options.input.name?.trim();
    const serviceName = options.input.serviceName?.trim() ?? '';
    if (!name) { return textResult('A metric name is required. Call listMetrics to discover available instruments.'); }

    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const detail = await this.database.request('getMetricDetail', {
      name,
      serviceName,
      sinceNano: sinceNano ?? undefined,
      untilNano: untilNano ?? undefined,
    });
    if (detail.stats.seriesCount === 0) {
      const window = options.input.since || options.input.until
        ? ' in the requested time window'
        : '';
      return textResult(
        `No data found for OTLP metric "${name}" from service "${serviceName || '(none)'}"${window}. ` +
        'Call listMetrics to verify the exact name and service.',
      );
    }

    const isDistribution = detail.metricType === 'histogram'
      || detail.metricType === 'exponentialHistogram'
      || detail.metricType === 'summary';
    const temporality = detail.metricType === 'sum' || isDistribution
      ? (detail.isCumulative ? 'cumulative' : 'delta')
      : 'not applicable';
    const lines: string[] = [
      `# OTLP Metric: ${name}\n`,
      `- Service: ${serviceName || '(none)'}`,
      `- Type: ${detail.metricType}`,
      `- Unit: ${detail.unit || '(unitless)'}`,
      `- Temporality: ${temporality}`,
      `- Series: ${detail.stats.seriesCount}`,
    ];
    if (options.input.since || options.input.until) {
      lines.push(`- Window: ${options.input.since ? `since ${options.input.since}` : 'unbounded start'}; ${options.input.until ? `until ${options.input.until}` : 'through now'}`);
    }
    if (detail.observedWindow.sinceNano && detail.observedWindow.untilNano) {
      lines.push(
        `- Reports: ${nanoToDate(detail.observedWindow.sinceNano)} to ` +
        `${nanoToDate(detail.observedWindow.untilNano)}`,
      );
    }

    lines.push('\n## Summary');
    if (detail.chart.kind === 'activity') {
      const totalLabel = detail.isCumulative
        ? (detail.window.sinceNano || detail.window.untilNano ? 'Window total' : 'Cumulative total')
        : 'Activity total';
      lines.push(`- ${totalLabel}: ${formatMetricValue(detail.chart.total ?? 0, detail.unit)}`);
    } else if (detail.chart.kind === 'average') {
      lines.push(`- Average: ${formatMetricValue(detail.stats.avg, detail.unit)}`);
    } else {
      const latest = detail.chart.series[detail.chart.series.length - 1];
      if (latest) {
        lines.push(`- Latest displayed value: ${formatMetricValue(latest.value, detail.unit)} at ${millisToDate(latest.t)}`);
      }
    }
    if (isDistribution) {
      lines.push(`- Observations: ${formatMetricNumber(detail.stats.totalCount)}`);
      lines.push(`- Sum: ${formatMetricValue(detail.stats.sum, detail.unit)}`);
    }
    if ((detail.metricType === 'histogram' || detail.metricType === 'exponentialHistogram')
        && !(detail.isCumulative && (detail.window.sinceNano || detail.window.untilNano))) {
      lines.push(`- Range: ${formatMetricValue(detail.stats.min, detail.unit)} to ${formatMetricValue(detail.stats.max, detail.unit)}`);
    }
    if (detail.chart.kind === 'activity' && detail.chart.unattributed) {
      lines.push(`- Value at first report: ${formatMetricValue(detail.chart.unattributed, detail.unit)} (included in the total but not assigned to a chart interval)`);
    } else if (detail.chart.kind === 'average' && detail.chart.unattributedCount) {
      lines.push(
        `- First-report observations: ${formatMetricNumber(detail.chart.unattributedCount)} totaling ` +
        `${formatMetricValue(detail.chart.unattributed ?? 0, detail.unit)} ` +
        '(included in summary statistics but not assigned to a chart interval)',
      );
    }

    if (detail.comparison) {
      lines.push('\n## Previous-window comparison');
      if (!detail.comparison.hasPreviousData) {
        lines.push('- No data was recorded in the immediately preceding equal-duration window.');
      } else {
        lines.push(`- Previous value: ${formatMetricValue(detail.comparison.previousValue, detail.unit)}`);
        if (detail.comparison.changePercent !== undefined) {
          const direction = detail.comparison.changePercent > 0 ? '+' : '';
          lines.push(`- Change: ${direction}${detail.comparison.changePercent.toFixed(1)}%`);
        }
      }
    }

    const recentPoints = detail.chart.series.slice(-20);
    if (recentPoints.length) {
      const valueLabel = detail.chart.kind === 'activity'
        ? 'Activity'
        : detail.chart.kind === 'average' ? 'Average' : 'Value';
      const bucket = detail.chart.bucketMs ? ` per ${formatBucketWidth(detail.chart.bucketMs)}` : '';
      lines.push(`\n## Time series (${valueLabel.toLowerCase()}${bucket}; ${recentPoints.length}${detail.chart.series.length > recentPoints.length ? ` of ${detail.chart.series.length}` : ''} most recent point(s))`);
      lines.push(`| Time | ${valueLabel} |`);
      lines.push('|---|---:|');
      for (const point of recentPoints) {
        lines.push(`| ${millisToDate(point.t)} | ${formatMetricValue(point.value, detail.unit)} |`);
      }
    }

    if (detail.chart.breakdowns?.length) {
      lines.push('\n## Time-series breakdowns');
      for (const breakdown of detail.chart.breakdowns) {
        lines.push(`### ${breakdown.label}`);
        lines.push('| Series | Total |');
        lines.push('|---|---:|');
        for (const series of breakdown.series) {
          const total = series.points.reduce((sum, point) => sum + point.value, 0);
          lines.push(`| ${markdownTableCell(series.label)} | ${formatMetricValue(total, detail.unit)} |`);
        }
      }
    }

    if (detail.dimensions.length) {
      lines.push('\n## Top attribute dimensions');
      for (const dimension of detail.dimensions.slice(0, 8)) {
        lines.push(`### ${dimension.key}`);
        lines.push('| Value | Count | Contribution |');
        lines.push('|---|---:|---:|');
        for (const value of dimension.values.slice(0, 5)) {
          lines.push(
            `| ${markdownTableCell(value.value)} | ${formatMetricNumber(value.count)} | ` +
            `${formatMetricValue(value.total, detail.unit)} |`,
          );
        }
      }
    }

    return textResult(lines.join('\n'));
  }
}

// high-level overview of recent telemetry data, including counts, health indicators, slowest operations, token usage, and tool calls.
class SummarizeRecentActivityTool implements vscode.LanguageModelTool<{ since?: string; until?: string }> {
  constructor(private readonly database: TelemetryDatabase) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ since?: string; until?: string }>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('summarizeRecentActivity', token, () => this.run(options));
  }

  private async run(
    options: vscode.LanguageModelToolInvocationOptions<{ since?: string; until?: string }>,
  ): Promise<vscode.LanguageModelToolResult> {
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const {
      analytics: { summary, slowestOperations, tokenUsage, toolCalls },
      errorSpans,
      errorTraces,
      p95DurationMs,
    } = await this.database.request('getRecentActivity', {
      sinceNano: sinceNano ?? undefined,
      untilNano: untilNano ?? undefined,
      visibility: getModelVisibility(),
    });

    if (summary.totalSpans === 0 && summary.totalLogs === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'No telemetry data yet. Point your OTLP exporter at the receiver to start collecting data.',
        ),
      ]);
    }

    const errorRate   = summary.totalSpans > 0
      ? ((errorSpans / summary.totalSpans) * 100).toFixed(1)
      : '0.0';

    const lines: string[] = ['# Recent Activity Summary\n'];

    lines.push('## Counts');
    lines.push(`- Traces: ${summary.totalTraces}`);
    lines.push(`- Spans: ${summary.totalSpans}`);
    lines.push(`- Logs: ${summary.totalLogs}`);
    lines.push(`- Metric points: ${summary.totalMetricPoints}`);

    lines.push('\n## Health');
    lines.push(`- Error traces: ${errorTraces} / ${summary.totalTraces}`);
    lines.push(`- Span error rate: ${errorRate}% (${errorSpans} errored span(s))`);
    lines.push(`- p95 trace duration: ${p95DurationMs}ms`);

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
      'searchLogs, listMetrics, getTokenAndToolUsage, getServiceSummary.',
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
  constructor(private readonly database: TelemetryDatabase) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetServiceSummaryInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('getServiceSummary', token, () => this.run(options));
  }

  private async run(
    options: vscode.LanguageModelToolInvocationOptions<GetServiceSummaryInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const { serviceName } = options.input;
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);

    // No serviceName → list available services so the caller can pick
    if (!serviceName?.trim()) {
      const names = await this.database.request('getServiceNames', undefined);
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

    const summary = await this.database.request('getServiceSummary', {
      serviceName: serviceName.trim(),
      sinceNano: sinceNano ?? undefined,
      untilNano: untilNano ?? undefined,
      visibility: getModelVisibility(),
    });
    if (!summary) {
      const names = await this.database.request('getServiceNames', undefined);
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
  constructor(private readonly database: TelemetryDatabase) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ListTracesInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('listTraces', token, () => this.run(options));
  }

  private async run(
    options: vscode.LanguageModelToolInvocationOptions<ListTracesInput>,
  ): Promise<vscode.LanguageModelToolResult> {
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
    let traces = await this.database.request('getTraces', tracesOpts);

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
  constructor(private readonly database: TelemetryDatabase) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetTraceInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('getTrace', token, () => this.run(options));
  }

  private async run(
    options: vscode.LanguageModelToolInvocationOptions<GetTraceInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const { traceId } = options.input;
    if (!traceId?.trim()) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('Error: traceId is required.'),
      ]);
    }

    const normalizedTraceId = traceId.trim();
    const { spans, sessionId } = await this.database.request('getTraceDetails', {
      traceId: normalizedTraceId,
    });

    if (!spans.length) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`No spans found for traceId: ${traceId}`),
      ]);
    }

    const spanIds = new Set(spans.map(span => span.spanId));
    const root = spans.find(s => !s.parentSpanId || !spanIds.has(s.parentSpanId)) ?? spans[0]!;
    const hasErrors = spans.some(s => s.statusCode === 2);
    const errorCount = spans.filter(s => s.statusCode === 2).length;

    // Aggregate token usage across all LLM spans in this trace
    const visibility = getModelVisibility();
    const tokensByModel = aggregateTokens(spans, visibility);
    const totalTokens  = tokensByModel.reduce((s, t) => s + t.totalTokens, 0);
    const totalInput   = tokensByModel.reduce((s, t) => s + t.promptTokens, 0);
    const totalOutput  = tokensByModel.reduce((s, t) => s + t.completionTokens, 0);
    const totalCached  = tokensByModel.reduce((s, t) => s + t.cachedTokens, 0);
    const totalCacheCreation = tokensByModel.reduce((s, t) => s + t.cacheCreationTokens, 0);
    const totalLLMCalls = tokensByModel.reduce((s, t) => s + t.callCount, 0);
    const cacheHitRate = totalInput > 0 ? totalCached / totalInput : -1;
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
  constructor(private readonly database: TelemetryDatabase) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetSessionSummaryInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('getSessionSummary', token, () => this.run(options));
  }

  private async run(
    options: vscode.LanguageModelToolInvocationOptions<GetSessionSummaryInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const { sessionId } = options.input;

    // No sessionId → list recent sessions so the caller can pick one.
    if (!sessionId?.trim()) {
      const limit = Math.max(1, Math.min(Number(options.input.limit) || 20, 100));
      const sessions = await this.database.request('getSessions', { limit });
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

    const summary = await this.database.request('getSessionSummary', {
      sessionId: sessionId.trim(),
    });
    if (!summary) {
      const recent = await this.database.request('getSessions', { limit: 10 });
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
  constructor(private readonly database: TelemetryDatabase) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetSessionMessagesInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return executeTool('getSessionMessages', token, () => this.run(options));
  }

  private async run(
    options: vscode.LanguageModelToolInvocationOptions<GetSessionMessagesInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const { sessionId } = options.input;

    // No sessionId → list recent sessions so the caller can pick one.
    if (!sessionId?.trim()) {
      const limit = Math.max(1, Math.min(Number(options.input.limit) || 20, 100));
      const sessions = await this.database.request('getSessions', { limit });
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

    const messages = await this.database.request('getSessionMessages', {
      sessionId: sessionId.trim(),
    });
    if (!messages) {
      const recent = await this.database.request('getSessions', { limit: 10 });
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
      const by     = t.isSubagent ? ` — ${t.subagentType ? `${t.subagentType} subagent` : 'subagent'}` : '';
      block.push(`## Turn ${i + 1}${model}${by}${status}`);
      block.push(`_trace \`${t.traceId}\` · span \`${t.spanId}\` · ${nanoToDate(t.startTimeUnixNano)}_`);

      block.push(`\n**User:** ${t.inputPreview ? truncate(t.inputPreview, maxChars) : '_(no user prompt captured for this turn)_'}`);

      const speaker = t.isSubagent ? 'Subagent' : 'Assistant';
      if (flat.text.trim()) {
        block.push(`\n**${speaker}:** ${truncate(flat.text.trim(), maxChars)}`);
      } else {
        block.push(`\n**${speaker}:** _(no text — the model replied with tool calls only)_`);
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

/**
 * Wraps a tool so the host is told, once per invocation, that *some* Agent
 * Insights tool ran. The panel uses that as its "the staged chat context was
 * actually sent" signal — VS Code exposes no chat-submit event to extensions.
 * The notification never affects the tool's own result.
 */
function withInvocationNotice<T>(
  tool: vscode.LanguageModelTool<T>,
  onInvoked: () => void,
): vscode.LanguageModelTool<T> {
  return {
    ...(tool.prepareInvocation
      ? {
        prepareInvocation: (
          options: vscode.LanguageModelToolInvocationPrepareOptions<T>,
          token: vscode.CancellationToken,
        ) => tool.prepareInvocation!(options, token),
      }
      : {}),
    invoke: (options, token) => {
      try { onInvoked(); } catch { /* a listener must never break a tool call */ }
      return tool.invoke(options, token);
    },
  };
}

export function registerTools(
  context: vscode.ExtensionContext,
  database: TelemetryDatabase,
  onToolInvoked: () => void = () => { /* no-op */ },
): void {
  const tools: [string, vscode.LanguageModelTool<never>][] = [
    ['agent-insights_findRecentErrors',        new FindRecentErrorsTool(database)],
    ['agent-insights_getTokenAndToolUsage',    new GetTokenAndToolUsageTool(database)],
    ['agent-insights_getSlowestSpans',         new GetSlowestSpansTool(database)],
    ['agent-insights_searchLogs',              new SearchLogsTool(database)],
    ['agent-insights_listMetrics',             new ListMetricsTool(database)],
    ['agent-insights_getMetric',               new GetMetricTool(database)],
    ['agent-insights_summarizeRecentActivity', new SummarizeRecentActivityTool(database)],
    ['agent-insights_getServiceSummary',       new GetServiceSummaryTool(database)],
    ['agent-insights_getSessionSummary',       new GetSessionSummaryTool(database)],
    ['agent-insights_getSessionMessages',      new GetSessionMessagesTool(database)],
    ['agent-insights_listTraces',              new ListTracesTool(database)],
    ['agent-insights_getTrace',                new GetTraceTool(database)],
  ];

  context.subscriptions.push(
    ...tools.map(([name, tool]) =>
      vscode.lm.registerTool(name, withInvocationNotice(tool, onToolInvoked))),
  );
}
