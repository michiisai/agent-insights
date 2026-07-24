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
  durationMs: number;
  /** OTLP StatusCode: 0=UNSET 1=OK 2=ERROR */
  statusCode: number;
  statusMessage?: string | null;
  attributes: Record<string, unknown>;
  serviceName: string;
  /** Full self-contained OTLP entity ({ resource, scope, span }) as received. */
  raw?: Record<string, unknown>;
}

/** Trace summary row — aggregated across all spans sharing a traceId. */
export interface Trace {
  traceId: string;
  rootSpanName: string;
  serviceName: string;
  startTimeUnixNano: string;
  durationMs: number;
  spanCount: number;
  hasError: boolean;
}

/** Aggregated metrics for the Performance panel. */
export interface MetricsData {
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
  /** Emitting service (github-copilot | claude-code). */
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
  /** A representative error status message when the session has a failure. */
  failureReason?: string | null;
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
  stats: {
    seriesCount: number;
    totalCount: number;  // lifetime observations (histograms)
    sum: number;
    avg: number;
    min: number;
    max: number;
    total: number;       // summed latest value (counters/gauges)
  };
  series: MetricSeriesPoint[];      // raw data-point values over time (downsampled)
  dimensions: MetricDimension[];    // breakdown by each attribute key
}

/** Messages sent from the webview to the extension host. */
export type WebviewToExtension =
  | { type: 'ready' }
  | { type: 'getTraces'; search?: string; service?: string; errorsOnly?: boolean; sortOrder?: 'asc' | 'desc'; sessionId?: string }
  | { type: 'getServices' }
  | { type: 'getSessions' }
  | { type: 'getUtilityCalls' }
  | { type: 'getLogServices' }
  | { type: 'getSpans'; traceId: string }
  | { type: 'getMetrics' }
  | { type: 'getMetricInstruments' }
  | { type: 'getMetricDetail'; name: string; serviceName: string }
  | { type: 'getLogs'; filter?: string; excludes?: string[]; sinceNano?: string; untilNano?: string; minSeverity?: number; serviceName?: string; sortOrder?: 'asc' | 'desc' }
  | { type: 'clearData' }
  | { type: 'tabChanged'; tab: TabId }
  | { type: 'addItemsToChat'; traces: Record<string, unknown>[]; spans: Record<string, unknown>[] };

/** Messages sent from the extension host to the webview. */
export type ExtensionToWebview =
  | { type: 'traces'; data: Trace[] }
  | { type: 'services'; data: string[] }
  | { type: 'sessions'; data: Session[] }
  | { type: 'utilityCalls'; data: UtilityCallsData }
  | { type: 'logServices'; data: string[] }
  | { type: 'spans'; traceId: string; data: Span[] }
  | { type: 'metrics'; data: MetricsData }
  | { type: 'metricInstruments'; data: MetricInstrument[] }
  | { type: 'metricDetail'; data: MetricDetail }
  | { type: 'logs'; data: LogRecord[] }
  | { type: 'status'; connected: boolean; port: number }
  | { type: 'cleared' }
  | { type: 'error'; message: string }
  | { type: 'navigateToTrace'; traceId: string; spanId?: string }
  | { type: 'switchTab'; tab: TabId };

/** Top-level views, in sidebar order. Driven by the activity-bar navigation. */
export type TabId = 'home' | 'sessions' | 'traces' | 'metrics' | 'logs';
