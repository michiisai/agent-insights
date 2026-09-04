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
  /** Wall-clock lifetime used for timeline positioning. */
  wallDurationMs?: number;
  /** OTLP StatusCode: 0=UNSET 1=OK 2=ERROR */
  statusCode: number;
  statusMessage?: string | null;
  attributes: Record<string, unknown>;
  serviceName: string;
  /** Original `{ resource, scope, span }` OTLP entity. */
  raw?: Record<string, unknown>;
}

export type TraceCategory =
  | 'agentActivity'
  | 'utilityModelCall'
  | 'hostActivity'
  | 'other';

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
  /** Mutually exclusive category derived from positive trace signals. */
  category: TraceCategory;
  /** Positively identified standalone host housekeeping. */
  isBackground?: boolean;
  /** The segment root has not arrived yet or was removed by retention. */
  isPartial?: boolean;
  spanCount: number;
  hasError: boolean;
}

export interface TraceMatch {
  traceId: string;
  spanId: string;
  spanName: string;
  field: 'name' | 'spanId' | 'attr' | 'traceId';
  /** Matched attribute key when `field` is `attr`. */
  attrKey?: string;
  /** Context window around the hit (not the full field value). */
  snippet: string;
  /** Unicode code-point offset within `snippet`, matching SQLite semantics. */
  matchOffset: number;
  truncatedStart: boolean;
  truncatedEnd: boolean;
}

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
    /** Cache read / input, or read / (input + read + creation) for additive providers; -1 without prompt data. */
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
  /** Original `{ resource, scope, logRecord }` OTLP entity. */
  raw?: Record<string, unknown>;
}

export interface QueryableDB {
  prepare(sql: string): {
    all(...args: unknown[]): Record<string, unknown>[];
    get(...args: unknown[]): Record<string, unknown> | undefined;
    run(...args: unknown[]): void;
  };
  exec(sql: string): void;
}

export interface SessionFailure {
  traceId: string;
  /** Logical trace containing the span after host-trace segmentation. */
  targetTraceId: string;
  spanId: string;
  spanName: string;
  /** Status or exception message. */
  message: string | null;
  /** Errored spans sharing this name and message. */
  count: number;
}

/** Conversation spanning one or more traces; excludes unkeyed utility calls. */
export interface Session {
  sessionId: string;
  /** Agent-host title, or null when no title span was reported. */
  title?: string | null;
  /** Agent-host plugin scheme; null outside the agent host. */
  agent?: string | null;
  serviceName: string;
  /** Distinct request models seen across the session's LLM requests. */
  models: string[];
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  /** Wall-clock time from first start to last end, in ms. */
  durationMs: number;
  traceCount: number;
  spanCount: number;
  llmRequestCount: number;
  toolCallCount: number;
  /** Reported input and output tokens; zero when unavailable. */
  totalTokens: number;
  hasError: boolean;
  errorCount: number;
  /** Representative retained error, or null after its raw span expires. */
  failureReason?: string | null;
  /** Retained distinct failures, oldest first. */
  failures: SessionFailure[];
  /** Raw spans are all retained (`complete`), partly retained, or gone (`expired`); summaries remain. */
  detailsState: 'complete' | 'partial' | 'expired';
}

/** Traces excluded from sessions for lacking work, prompts, or a title. */
export interface BackgroundTraceStats {
  traceCount: number;
  spanCount: number;
  serviceNames: string[];
}

export interface SessionMessageDetailItem {
  label: string;
  value: string;
  format?: 'text' | 'json' | 'code';
}

export interface SessionMessageDetail {
  title: string;
  items: SessionMessageDetailItem[];
  /** Matching tool-call part ID; attaches details to that tool's chip. */
  partId?: string;
}

export interface SessionMessageTurn {
  traceId: string;
  spanId: string;
  /** Model-call span, or null for inherited tracing context. */
  sourceSpanId: string | null;
  spanName: string;
  startTimeUnixNano: string;
  model: string | null;
  hasError: boolean;
  /** Raw `gen_ai.output.messages` JSON. */
  outputMessages: string;
  /** Best-effort latest user prompt. */
  inputPreview: string | null;
  /** Supplemental input context, excluding rendered conversation history. */
  inputContextMessages?: string | null;
  /** Raw `gen_ai.system_instructions` JSON. */
  systemInstructions?: string | null;
  details?: SessionMessageDetail[];
  isSubagent: boolean;
  subagentType: string | null;
}

export interface SessionMessages {
  sessionId: string;
  /** False when no supported message content was found. */
  captureEnabled: boolean;
  turns: SessionMessageTurn[];
}

export interface TraceMessages {
  /** Requested logical trace ID, including a segment ID when projected. */
  traceId: string;
  /** False when no supported message content was found. */
  captureEnabled: boolean;
  turns: SessionMessageTurn[];
}

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

export interface UtilityModelStat {
  model: string;
  callCount: number;
  totalTokens: number;
  avgDurationMs: number;
  maxDurationMs: number;
  errorCount: number;
}

export interface UtilityCallsData {
  totalCalls: number;
  totalTokens: number;
  avgDurationMs: number;
  errorCount: number;
  byModel: UtilityModelStat[];
  calls: UtilityCall[];
}

export interface MetricInstrument {
  name: string;
  metricType: string;
  unit: string;
  serviceName: string;
  pointCount: number;
  seriesCount: number;
  lastTimestampNano: string;
}

export interface MetricSeriesPoint {
  /** Epoch milliseconds. */
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

export interface MetricChart {
  kind: 'activity' | 'average' | 'value';
  series: MetricSeriesPoint[];
  /** Width of each interval for activity/average charts. */
  bucketMs?: number;
  /** Sum of all interval values when `kind` is `activity`. */
  total?: number;
  /** Untimed cumulative first reports included in `total`. */
  unattributed?: number;
  /** Observations represented by untimed first reports. */
  unattributedCount?: number;
  breakdowns?: MetricChartBreakdown[];
}

/** Comparison with the immediately preceding equal-duration window. */
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

export interface MetricDimension {
  key: string;
  values: Array<{ value: string; count: number; total: number }>;
}

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
  /** First and last reports present in `window`. */
  observedWindow: {
    sinceNano?: string;
    untilNano?: string;
  };
  stats: {
    seriesCount: number;
    /** Sum of histogram counts across selected points. */
    totalCount: number;
    sum: number;
    avg: number;
    min: number;
    max: number;
    /** Sum of selected values; bounded cumulative metrics use per-series deltas. */
    total: number;
  };
  chart: MetricChart;
  comparison?: MetricComparison;
  dimensions: MetricDimension[];
}

/** Top-level views in sidebar order. */
export type TabId = 'home' | 'sessions' | 'traces' | 'metrics' | 'logs';

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
  | { type: 'openSettingsSetup' }
  | { type: 'openUtilityModelSettings' }
  | { type: 'clearData' }
  | { type: 'tabChanged'; tab: TabId }
  | { type: 'addItemsToChat'; traces: Record<string, unknown>[]; spans: Record<string, unknown>[]; sessions?: Record<string, unknown>[] };

export type ExtensionToWebview =
  /** `hasMore` is set only for limited requests with another page. */
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
  | ({ type: 'status' } & ReceiverStatus)
  | { type: 'refreshData' }
  | { type: 'cleared' }
  | { type: 'chatSelectionConsumed' }
  | { type: 'error'; message: string; requestType?: string; sessionId?: string; traceId?: string }
  | { type: 'navigateToTrace'; traceId: string; spanId?: string }
  | { type: 'navigateToSession'; sessionId: string }
  | { type: 'switchTab'; tab: TabId };

export type ReceiverStatusState =
  | 'starting'
  | 'listening'
  | 'following'
  | 'reconnecting'
  | 'unknown'
  | 'error';

export interface ReceiverStatus {
  state: ReceiverStatusState;
  port: number;
}
