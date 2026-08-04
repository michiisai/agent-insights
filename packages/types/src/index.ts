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
  /**
   * Human-readable chat title, when the agent host reported one via a
   * `vscode.agent_host.session.title_changed` span. Null for harnesses that
   * don't emit titles, when content capture is off, or on older VS Code builds.
   */
  title?: string | null;
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

/** One captured model-response turn within a session — a single chat/LLM span
 * that recorded `gen_ai.output.messages`. `outputMessages` is the raw JSON
 * string (an array of `{ role, parts, finish_reason }`) so the webview can
 * render it with the shared gen_ai message renderer. `inputPreview` is the last
 * user prompt (best-effort) that produced this response, used to anchor the
 * turn in the conversation transcript. */
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
}

/** The ordered model responses captured within a session. `captureEnabled` is
 * false when the session has chat turns but none carry captured content
 * (captureContent was off), so the UI can show an explanatory empty state. */
export interface SessionMessages {
  sessionId: string;
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
  | { type: 'getTraces'; search?: string; service?: string; errorsOnly?: boolean; sortOrder?: 'asc' | 'desc'; sessionId?: string; seq?: number; limit?: number }
  | { type: 'getServices' }
  | { type: 'getSessions' }
  | { type: 'getUtilityCalls' }
  | { type: 'getLogServices' }
  | { type: 'getSpans'; traceId: string }
  | { type: 'getSessionMessages'; sessionId: string }
  | { type: 'getSessionLogs'; sessionId: string }
  | { type: 'getMetrics' }
  | { type: 'getMetricInstruments'; sinceNano?: string; untilNano?: string }
  | { type: 'getMetricDetail'; name: string; serviceName: string; sinceNano?: string; untilNano?: string }
  | { type: 'getLogs'; filter?: string; excludes?: string[]; sinceNano?: string; untilNano?: string; minSeverity?: number; serviceName?: string; sortOrder?: 'asc' | 'desc'; seq?: number }
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
  | { type: 'sessionLogs'; sessionId: string; data: LogRecord[]; hasMore: boolean }
  | { type: 'metrics'; data: MetricsData }
  | { type: 'metricInstruments'; data: MetricInstrument[] }
  | { type: 'metricDetail'; data: MetricDetail }
  | { type: 'logs'; data: LogRecord[]; seq?: number }
  | { type: 'status'; connected: boolean; port: number }
  | { type: 'cleared' }
  | { type: 'error'; message: string; requestType?: string; sessionId?: string }
  | { type: 'navigateToTrace'; traceId: string; spanId?: string }
  | { type: 'navigateToSession'; sessionId: string }
  | { type: 'switchTab'; tab: TabId };

/** Top-level views, in sidebar order. Driven by the activity-bar navigation. */
export type TabId = 'home' | 'sessions' | 'traces' | 'metrics' | 'logs';
