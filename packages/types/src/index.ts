/** A single span stored in and retrieved from the DB. */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  /** OTLP SpanKind: 0=UNSPECIFIED 1=INTERNAL 2=SERVER 3=CLIENT 4=PRODUCER 5=CONSUMER */
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  /** Work time when busy_ns is present; otherwise wall-clock duration. */
  durationMs: number;
  /** Wall-clock span lifetime, retained for positioning spans on a timeline. */
  wallDurationMs?: number;
  /** OTLP StatusCode: 0=UNSET 1=OK 2=ERROR */
  statusCode: number;
  statusMessage?: string | null;
  attributes: Record<string, unknown>;
  serviceName: string;
  /** Full self-contained OTLP entity ({ resource, scope, span }) as received. */
  raw?: Record<string, unknown>;
}

export type TraceCategory =
  | 'agentActivity'
  | 'utilityModelCall'
  | 'hostActivity'
  | 'other';

/** Trace summary row — aggregated across all spans sharing a traceId. */
export interface Trace {
  /** Stable row identity. Segments use `<physicalTraceId>:<rootSpanId>`. */
  traceId: string;
  /** Original OTLP trace id shared by every segment from the same host trace. */
  physicalTraceId?: string;
  /** Root span promoted from beneath vscode.agent_host.session. */
  rootSpanId?: string;
  rootSpanName: string;
  serviceName: string;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  /** Root work time when busy_ns is present; otherwise wall-clock duration. */
  durationMs: number;
  /** Mutually exclusive presentation category assigned from positive trace signals. */
  category: TraceCategory;
  /** Positively identified standalone host housekeeping. */
  isBackground?: boolean;
  /** The segment root has not arrived yet or was removed by retention. */
  isPartial?: boolean;
  spanCount: number;
  hasError: boolean;
}

/** A single located occurrence of a trace-search term, for rendering a
 *  VS Code Search-view-style match list under a trace row. */
export interface TraceMatch {
  traceId: string;
  spanId: string;
  spanName: string;
  /** Which part of the span the term matched in. */
  field: 'name' | 'spanId' | 'attr' | 'traceId';
  /** Attribute key the term matched in, when field === 'attr'. */
  attrKey?: string;
  /** Context window around the hit (not the full field value). */
  snippet: string;
  /** Offset of the match start within `snippet`, in Unicode CODE POINTS (SQLite
   *  substr/instr semantics) — not UTF-16 code units. Slice `snippet` by code
   *  point (e.g. `Array.from`) or astral characters will skew the position. */
  matchOffset: number;
  /** True when text was trimmed off the START of `snippet` (draw a leading ellipsis). */
  truncatedStart: boolean;
  /** True when text was trimmed off the END of `snippet` (draw a trailing ellipsis). */
  truncatedEnd: boolean;
}

/** Aggregated agent analytics for the Home panel. */
export interface AgentAnalyticsData {
  slowestOperations: Array<{
    name: string;
    avgDurationMs: number;
    maxDurationMs: number;
    count: number;
    errorCount: number;
  }>;
  tokenUsage: Array<{
    model: string;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    cacheHitRate: number;
    callCount: number;
  }>;
  toolCalls: Array<{
    toolName: string;
    count: number;
    avgDurationMs: number;
    totalDurationMs: number;
    errorCount: number;
  }>;
  summary: {
    totalSpans: number;
    totalTraces: number;
    totalLogs: number;
    totalMetricPoints: number;
    llmCalls: number;
    toolCallsTotal: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    /**
     * Fraction of prompt tokens served from cache, computed with convention-aware denominators:
     *   - Standard/OTel semconv: cache_read is a subset of input_tokens → read / input
     *   - Claude Code/Anthropic: cache_read is additive → read / (input + read + creation)
     * -1 when there is no prompt data to compute a rate.
     */
    cacheHitRate: number;
    errorTraces: number;
    p95Ms: number;
  };
}

export const TOKEN_ATTRIBUTE_KEYS = {
  model: [
    'gen_ai.request.model',
    'gen_ai.response.model',
    'llm.model',
    'model',
  ],
  input: [
    'gen_ai.usage.input_tokens',
    'llm.usage.prompt_tokens',
    'input_tokens',
  ],
  output: [
    'gen_ai.usage.output_tokens',
    'llm.usage.completion_tokens',
    'output_tokens',
  ],
  cacheRead: [
    'gen_ai.usage.cache_read.input_tokens',
    'gen_ai.usage.cache_read_input_tokens',
    'gen_ai.usage.cached_tokens',
    'llm.usage.cache_read_input_tokens',
    'llm.usage.cached_tokens',
    'cache_read_tokens',
  ],
  cacheCreation: [
    'gen_ai.usage.cache_creation.input_tokens',
    'gen_ai.usage.cache_creation_input_tokens',
    'gen_ai.usage.cache_write.input_tokens',
    'llm.usage.cache_creation_input_tokens',
    'cache_creation_tokens',
  ],
} as const;

export const TOKEN_ADDITIVE_CACHE_ATTRIBUTE_KEYS = [
  'cache_read_tokens',
  'cache_creation_tokens',
] as const;

export const DEFAULT_UTILITY_MODEL_PATTERNS = ['4o', '5.4-nano', 'copilot-nes'] as const;

export interface ModelVisibilityOptions {
  hideUtilityModels?: boolean;
  utilityModels?: readonly string[];
}

export function isUtilityModel(
  model: string,
  patterns: readonly string[] = DEFAULT_UTILITY_MODEL_PATTERNS,
): boolean {
  const normalizedModel = model.trim().toLocaleLowerCase();
  return normalizedModel.length > 0
    && patterns.some(pattern => {
      const normalizedPattern = pattern.trim().toLocaleLowerCase();
      return normalizedPattern.length > 0 && normalizedModel.includes(normalizedPattern);
    });
}

export function isVisibleModel(model: string, options?: ModelVisibilityOptions): boolean {
  return options?.hideUtilityModels !== true
    || !isUtilityModel(model, options?.utilityModels);
}

export const TOKEN_OPERATION_ATTRIBUTE = 'gen_ai.operation.name';
export const TOKEN_CHAT_OPERATION = 'chat';
/** Default `service.name` of the agent host itself (user-overridable). */
export const AGENT_HOST_SERVICE_NAME = 'vscode-agent-host';

export function firstNumericAttribute(
  attributes: Record<string, unknown>,
  keys: readonly string[],
): number {
  for (const key of keys) {
    const value = attributes[key];
    if (value === null || value === undefined) { continue; }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }
  return 0;
}

export function firstStringAttribute(
  attributes: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = attributes[key];
    if (value !== null && value !== undefined) { return String(value); }
  }
  return '';
}

export function hasAnyAttribute(
  attributes: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.some(key => attributes[key] !== null && attributes[key] !== undefined);
}

export function isAdditiveTokenAccounting(attributes: Record<string, unknown>): boolean {
  return hasAnyAttribute(attributes, TOKEN_ADDITIVE_CACHE_ATTRIBUTE_KEYS);
}

export interface DailyModelTokenUsage {
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  cacheHitRate: number;
  callCount: number;
}

export interface DailyTokenUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  cacheHitRate: number;
  callCount: number;
  models: DailyModelTokenUsage[];
}

export const TOKEN_TREND_BUCKET_COUNT = 6;

export type TokenTrendBuckets = [number, number, number, number, number, number];

export interface ModelTokenTrend {
  model: string;
  inputTokens: TokenTrendBuckets;
  outputTokens: TokenTrendBuckets;
}

export interface TokenTrend {
  inputTokens: TokenTrendBuckets;
  outputTokens: TokenTrendBuckets;
  models: ModelTokenTrend[];
}

/** A single log record. */
export interface LogRecord {
  id: number;
  timestampUnixNano: string;
  /** OTLP SeverityNumber: 1-4=TRACE, 5-8=DEBUG, 9-12=INFO, 13-16=WARN, 17-20=ERROR, 21-24=FATAL */
  severityNumber: number;
  severityText: string;
  body: string;
  attributes: Record<string, unknown>;
  traceId?: string | null;
  spanId?: string | null;
  serviceName: string;
  /** Full self-contained OTLP entity ({ resource, scope, logRecord }) as received. */
  raw?: Record<string, unknown>;
}

/**
 * Minimal DB interface the engine depends on.
 * Implemented by DatabaseAdapter (wraps sql.js) in the receiver package.
 */
export interface QueryableDB {
  prepare(sql: string): {
    all(...args: unknown[]): Record<string, unknown>[];
    get(...args: unknown[]): Record<string, unknown> | undefined;
    run(...args: unknown[]): void;
  };
  exec(sql: string): void;
}

/**
 * One agent session — a conversation that groups multiple traces.
 * The session id is resolved at the TRACE level from any span carrying a
 * conversation/session id (gen_ai.conversation.id | session.id |
 * copilot_chat.chat_session_id), falling back to trace_id. copilot-chat
 * (vscode LM API / utility calls) is excluded from sessions entirely.
 */
export interface Session {
  sessionId: string;
  /**
   * Human-readable chat title, when the agent host reported one via a
   * `vscode.agent_host.session.title_changed` span. Null for harnesses that
   * don't emit titles, when content capture is off, or on older VS Code builds.
   */
  title?: string | null;
  /**
   * Which agent the VS Code agent host ran, taken from the scheme of the
   * `vscode.agent_host.session.uri` — `claude` | `codex` | `copilotcli`.
   *
   * This is the host's own name for the plugin it launched, so it is
   * authoritative in a way `serviceName` is not: each agent stamps its own
   * resource name (`claude` → `claude-code`, `copilotcli` → `github-copilot`,
   * `codex` → `codex-app-server`) and the host doesn't control what it picks.
   *
   * Read from the title span where there is one, and otherwise from the session
   * anchor span, which carries the same URI — Codex gets no title span at all.
   * Null for a harness running outside the agent host entirely.
   */
  agent?: string | null;
  /** Emitting service (claude-code | github-copilot | codex-app-server | …). */
  serviceName: string;
  /** Distinct request models seen across the session's LLM requests. */
  models: string[];
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  /** Wall-clock span of the session (last end − first start), in ms. */
  durationMs: number;
  traceCount: number;
  spanCount: number;
  llmRequestCount: number;
  toolCallCount: number;
  /** Summed gen_ai.usage input+output tokens across the session (0 if unreported). */
  totalTokens: number;
  hasError: boolean;
  /** Total errored spans across every trace of the session. */
  errorCount: number;
  /** A representative error status message when the session has a failure. */
  failureReason?: string | null;
  /**
   * Every distinct failure across the session's traces, oldest first. A session
   * can fail in more than one turn (and more than once per turn), so this is the
   * complete list — `failureReason` is only the first of these.
   */
  failures: SessionFailure[];
}

/**
 * Traces the Sessions tab does not show because nothing ever happened in them:
 * no LLM request, tool call, token usage, error or captured prompt anywhere in
 * the session, and no title from the agent host. In practice this is an agent
 * runtime's own background work — Codex's app-server emits a separate trace for
 * each config read, model list and RPC queue drain — plus chats that were
 * created and never used, which arrive with a conversation id and ~37 spans of
 * thread-startup and nothing more.
 *
 * Counted as a diagnostic — how much of the stored telemetry the session filter
 * classifies as noise. Nothing is deleted: they remain fully browsable in the
 * Traces tab, which applies no session filter.
 */
export interface BackgroundTraceStats {
  traceCount: number;
  spanCount: number;
  /** Services that produced them, for a "what is this?" hint. */
  serviceNames: string[];
}

/** One distinct failure (errored span name + message) within a session's trace. */
export interface SessionFailure {
  /** Trace (turn) the failure happened in. */
  traceId: string;
  /** Name of the errored span. */
  spanName: string;
  /** Status message, falling back to `exception.message`; null when neither is set. */
  message: string | null;
  /** How many errored spans in that trace share this name + message. */
  count: number;
}

/** One label/value row inside a collapsible transcript detail section. */
export interface SessionMessageDetailItem {
  label: string;
  value: string;
  /** JSON values are pretty-printed in a code block by the transcript renderer. */
  format?: 'text' | 'json' | 'code';
}

/** Provider-neutral rich telemetry attached to a conversation turn. */
export interface SessionMessageDetail {
  title: string;
  items: SessionMessageDetailItem[];
  /** The tool call this section describes, matching a `tool_call`/
   *  `tool_call_response` part's `id`. Set only by harnesses that report
   *  per-tool metadata at turn level (Codex): the transcript attaches such a
   *  section to that tool's chip instead of the turn's shared details block,
   *  where several tools' metadata would otherwise stack up unlabelled. */
  partId?: string;
}

/** One captured model-response turn within a session — a single chat/LLM span
 * that recorded `gen_ai.output.messages`. `outputMessages` is the raw JSON
 * string (an array of `{ role, parts, finish_reason }`) so the webview can
 * render it with the shared gen_ai message renderer. `inputPreview` is the last
 * user prompt (best-effort) that produced this response, used to anchor the
 * turn in the conversation transcript.
 *
 * Harnesses that report content as OTel log records rather than span attributes
 * (Claude Code, whose `assistant_response` event carries the response text) are
 * reshaped into this same form, so consumers never need to branch on the
 * source. There `spanId` is the span the log record was stamped with. */
export interface SessionMessageTurn {
  traceId: string;
  spanId: string;
  spanName: string;
  startTimeUnixNano: string;
  model: string | null;
  hasError: boolean;
  /** Raw gen_ai.output.messages JSON string (assistant response). */
  outputMessages: string;
  /** Best-effort text of the latest user prompt that produced this response. */
  inputPreview: string | null;
  /** Supplemental captured input context (system/developer and injected-only
   * messages), excluding conversation history already rendered as turns. */
  inputContextMessages?: string | null;
  /** Raw captured gen_ai.system_instructions JSON, when emitted separately. */
  systemInstructions?: string | null;
  /** Rich request, usage, tool, and session telemetry safe to expose in the UI. */
  details?: SessionMessageDetail[];
  /** True when a subagent produced this turn. Its narration threads to the
   *  user's prompt id, so without this it reads as the main agent's own words. */
  isSubagent: boolean;
  /** The subagent's kind (`Explore`) when recorded; null otherwise. */
  subagentType: string | null;
}

/** The ordered model responses captured within a session. `captureEnabled` is
 * false when the session has chat turns but none carry captured content
 * (captureContent was off), so the UI can show an explanatory empty state. */
export interface SessionMessages {
  sessionId: string;
  captureEnabled: boolean;
  turns: SessionMessageTurn[];
}

/** The same transcript, scoped to a single trace rather than a whole session,
 * so the Traces tab can read a conversation for any trace — including the many
 * that belong to no session at all (utility model calls, host activity). Shares
 * `SessionMessageTurn` so both tabs render through one code path. */
export interface TraceMessages {
  /** The logical trace id asked for — a segment id for projected host traces. */
  traceId: string;
  captureEnabled: boolean;
  turns: SessionMessageTurn[];
}

/** One standalone vscode.lm / LM-API "utility" call — a single-span, parentless
 * root LLM/embedding request with NO session/conversation id (title & summary
 * generation, embeddings, suggestions). Excluded from Sessions (#16); surfaced
 * in aggregate on Home. */
export interface UtilityCall {
  traceId: string;
  spanId: string;
  name: string;
  model: string;
  serviceName: string;
  startTimeUnixNano: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  hasError: boolean;
}

/** Aggregate stats for utility calls of one model. */
export interface UtilityModelStat {
  model: string;
  callCount: number;
  totalTokens: number;
  avgDurationMs: number;
  maxDurationMs: number;
  errorCount: number;
}

/** Utility / LM-API calls for Home: overall totals, per-model breakdown
 * (aggregate table), and individual calls (for drill-down). */
export interface UtilityCallsData {
  totalCalls: number;
  totalTokens: number;
  avgDurationMs: number;
  errorCount: number;
  byModel: UtilityModelStat[];
  calls: UtilityCall[];
}

/** One OTLP metric instrument (aggregated across its time-series/data points). */
export interface MetricInstrument {
  name: string;
  metricType: string;   // 'histogram' | 'sum' | 'gauge' | ...
  unit: string;
  serviceName: string;
  pointCount: number;   // total stored data points
  seriesCount: number;  // distinct attribute combinations
  lastTimestampNano: string;
}

/** A single point on a metric's time-series chart (t = epoch ms). */
export interface MetricSeriesPoint {
  t: number;
  value: number;
}

export interface MetricChartBreakdown {
  key: 'tokenType' | 'model';
  label: string;
  series: Array<{
    label: string;
    points: MetricSeriesPoint[];
  }>;
}

/** User-facing interpretation of an OTLP instrument's time series. */
export interface MetricChart {
  kind: 'activity' | 'average' | 'value';
  series: MetricSeriesPoint[];
  /** Width of each interval for activity/average charts. */
  bucketMs?: number;
  /** Sum of all interval values when `kind` is `activity`. */
  total?: number;
  /** Combined first-report values for cumulative series/runs; included in total but not timed. */
  unattributed?: number;
  /** Observations represented by cumulative first reports that cannot be timed. */
  unattributedCount?: number;
  /** Aligned stacked series available for additive token activity. */
  breakdowns?: MetricChartBreakdown[];
}

/** Comparison against the immediately preceding equal-duration window. */
export interface MetricComparison {
  kind: 'activity' | 'average';
  previousValue: number;
  changePercent?: number;
  hasPreviousData: boolean;
  window: {
    sinceNano: string;
    untilNano: string;
  };
}

/** Breakdown of a metric by one attribute key (e.g. by model / tool). */
export interface MetricDimension {
  key: string;
  values: Array<{ value: string; count: number; total: number }>;
}

/** Detail for a single selected metric instrument. */
export interface MetricDetail {
  name: string;
  serviceName: string;
  metricType: string;
  unit: string;
  isCumulative: boolean;
  window: {
    sinceNano?: string;
    untilNano?: string;
  };
  /** First and last reports actually present inside `window`. */
  observedWindow: {
    sinceNano?: string;
    untilNano?: string;
  };
  stats: {
    seriesCount: number;
    totalCount: number;  // lifetime observations (histograms)
    sum: number;
    avg: number;
    min: number;
    max: number;
    total: number;       // summed latest value (counters/gauges)
  };
  chart: MetricChart;
  comparison?: MetricComparison;
  dimensions: MetricDimension[];    // breakdown by each attribute key
}

/** Messages sent from the webview to the extension host. */
export type WebviewToExtension =
  | { type: 'ready' }
  | { type: 'getTraces'; search?: string; service?: string; errorsOnly?: boolean; categories?: TraceCategory[]; sortOrder?: 'asc' | 'desc'; sessionId?: string; seq?: number; limit?: number }
  | { type: 'getServices' }
  | { type: 'getSessions' }
  | { type: 'getUtilityCalls' }
  | { type: 'getLogServices' }
  | { type: 'getSpans'; traceId: string }
  | { type: 'getSessionMessages'; sessionId: string }
  | { type: 'getTraceMessages'; traceId: string }
  | { type: 'getSessionLogs'; sessionId: string }
  | { type: 'getAgentAnalytics' }
  | { type: 'getMetricInstruments'; sinceNano?: string; untilNano?: string }
  | { type: 'getMetricDetail'; name: string; serviceName: string; sinceNano?: string; untilNano?: string }
  | { type: 'getLogs'; filter?: string; excludes?: string[]; sinceNano?: string; untilNano?: string; minSeverity?: number; serviceName?: string; sortOrder?: 'asc' | 'desc'; seq?: number }
  | { type: 'openUtilityModelSettings' }
  | { type: 'clearData' }
  | { type: 'tabChanged'; tab: TabId }
  | { type: 'addItemsToChat'; traces: Record<string, unknown>[]; spans: Record<string, unknown>[]; sessions?: Record<string, unknown>[] };

/** Messages sent from the extension host to the webview. */
export type ExtensionToWebview =
  /** `hasMore` reports that the store held further traces beyond `data`, so the
   *  webview can offer to load the next page. Only set when a `limit` was asked
   *  for; an unlimited request never has more to show. */
  | { type: 'traces'; data: Trace[]; matches?: TraceMatch[]; seq?: number; hasMore?: boolean; sessionId?: string }
  | { type: 'services'; data: string[] }
  | { type: 'sessions'; data: Session[] }
  | { type: 'utilityCalls'; data: UtilityCallsData }
  | { type: 'logServices'; data: string[] }
  | { type: 'spans'; traceId: string; data: Span[] }
  | { type: 'sessionMessages'; sessionId: string; data: SessionMessages }
  | { type: 'traceMessages'; traceId: string; data: TraceMessages }
  | { type: 'sessionLogs'; sessionId: string; data: LogRecord[]; hasMore: boolean }
  | { type: 'agentAnalytics'; data: AgentAnalyticsData }
  | { type: 'metricInstruments'; data: MetricInstrument[] }
  | { type: 'metricDetail'; data: MetricDetail }
  | { type: 'logs'; data: LogRecord[]; seq?: number }
  | { type: 'status'; connected: boolean; port: number }
  | { type: 'refreshData' }
  | { type: 'cleared' }
  /** The staged chat context has been used by a chat request, so the webview
   *  should empty its basket. See AgentInsightsPanel.notifyChatToolInvoked. */
  | { type: 'chatSelectionConsumed' }
  | { type: 'error'; message: string; requestType?: string; sessionId?: string; traceId?: string }
  | { type: 'navigateToTrace'; traceId: string; spanId?: string }
  | { type: 'navigateToSession'; sessionId: string }
  | { type: 'switchTab'; tab: TabId };

/** Top-level views, in sidebar order. Driven by the activity-bar navigation. */
export type TabId = 'home' | 'sessions' | 'traces' | 'metrics' | 'logs';
