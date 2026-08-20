import type {
  ErrorTrace,
  GetSessionsOptions,
  GetTraceMatchesOptions,
  GetTracesOptions,
  GetUtilityCallsOptions,
  LogQueryOptions,
  ServiceSummary,
  SessionSummary,
} from '@agent-insights/engine';
import type { LogRow, MetricRow, SpanRow } from '@agent-insights/receiver';
import type {
  AgentAnalyticsData,
  DailyTokenUsage,
  LogRecord,
  MetricDetail,
  MetricInstrument,
  ModelVisibilityOptions,
  Session,
  SessionMessages,
  Span,
  Trace,
  TraceMatch,
  TraceMessages,
  TokenTrend,
  UtilityCallsData,
} from '@agent-insights/types';

export interface RecentActivityResult {
  analytics: AgentAnalyticsData;
  errorSpans: number;
  errorTraces: number;
  p95DurationMs: number;
}

export interface TraceDetailsResult {
  spans: Span[];
  sessionId: string | null;
}

export type TokenStatusResult =
  | { writable: false }
  | {
      writable: true;
      tokenFactsVersion: number;
      usage: DailyTokenUsage;
      trend: TokenTrend;
    };

export interface DatabaseOperationMap {
  initialize: { args: undefined; result: void };
  reloadFromDisk: { args: undefined; result: void };
  enablePersistence: { args: undefined; result: void };
  relinquishPersistence: { args: undefined; result: void };
  clear: { args: undefined; result: void };
  close: { args: undefined; result: void };

  insertSpans: { args: SpanRow[]; result: void };
  insertMetrics: { args: MetricRow[]; result: void };
  insertLogs: { args: LogRow[]; result: void };

  getTraces: { args: GetTracesOptions; result: Trace[] };
  getTraceMatches: { args: GetTraceMatchesOptions; result: TraceMatch[] };
  getTraceDetails: { args: { traceId: string }; result: TraceDetailsResult };
  getServices: { args: undefined; result: string[] };
  getSessions: { args: GetSessionsOptions; result: Session[] };
  getSessionSummary: { args: { sessionId: string }; result: SessionSummary | null };
  getSessionMessages: { args: { sessionId: string }; result: SessionMessages | null };
  getTraceMessages: { args: { traceId: string }; result: TraceMessages | null };
  getLogs: { args: LogQueryOptions; result: LogRecord[] };
  getLogServiceNames: { args: undefined; result: string[] };
  getAgentAnalytics: {
    args: { sinceNano?: string; untilNano?: string; visibility?: ModelVisibilityOptions };
    result: AgentAnalyticsData;
  };
  getUtilityCalls: { args: GetUtilityCallsOptions; result: UtilityCallsData };
  getMetricInstruments: {
    args: { sinceNano?: string; untilNano?: string };
    result: MetricInstrument[];
  };
  getMetricDetail: {
    args: {
      name: string;
      serviceName: string;
      sinceNano?: string;
      untilNano?: string;
    };
    result: MetricDetail;
  };
  getRecentErrorTraces: {
    args: { limit: number; sinceNano?: string; untilNano?: string };
    result: ErrorTrace[];
  };
  getRecentActivity: {
    args: { sinceNano?: string; untilNano?: string; visibility?: ModelVisibilityOptions };
    result: RecentActivityResult;
  };
  getServiceNames: { args: undefined; result: string[] };
  getServiceSummary: {
    args: {
      serviceName: string;
      sinceNano?: string;
      untilNano?: string;
      visibility?: ModelVisibilityOptions;
    };
    result: ServiceSummary | null;
  };
  getTokenStatus: {
    args: {
      daySinceNano: string;
      dayUntilNano: string;
      trendSinceNano: string;
      trendUntilNano: string;
      visibility?: ModelVisibilityOptions;
    };
    result: TokenStatusResult;
  };
}

export type DatabaseOperation = keyof DatabaseOperationMap;
export type DatabaseArgs<K extends DatabaseOperation> = DatabaseOperationMap[K]['args'];
export type DatabaseResult<K extends DatabaseOperation> = DatabaseOperationMap[K]['result'];

export type DatabaseRequest = {
  [K in DatabaseOperation]: {
    id: number;
    operation: K;
    args: DatabaseArgs<K>;
    queuedAtMs?: number;
  };
}[DatabaseOperation];

export interface SerializedDatabaseError {
  name: string;
  message: string;
  stack?: string;
}

export type DatabaseResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: SerializedDatabaseError };
