import { TelemetryStore } from '@agent-insights/receiver';
import {
  getAgentAnalytics,
  getDailyTokenUsage,
  getLogServiceNames,
  getLogs,
  getMetricDetail,
  getMetricInstruments,
  getRecentErrorTraces,
  getServiceNames,
  getServiceSummary,
  getSessionIdForTrace,
  getSessionMessages,
  getSessions,
  getSessionSummary,
  getSpansByTraceId,
  getTokenTrend,
  getTraceMatches,
  getTraceMessages,
  getTraces,
  getServices,
  getUtilityCalls,
} from '@agent-insights/engine';
import type { ModelVisibilityOptions } from '@agent-insights/types';
import type {
  DatabaseArgs,
  DatabaseOperation,
  DatabaseResult,
  RecentActivityResult,
} from './protocol';

const SLOW_OPERATION_MS = 150;

function visibilityKey(visibility?: ModelVisibilityOptions): string {
  const patterns = [...(visibility?.utilityModels ?? [])]
    .map(pattern => pattern.trim().toLocaleLowerCase())
    .filter(Boolean)
    .sort();
  return `${visibility?.hideUtilityModels === true ? '1' : '0'}:${patterns.join('\u001f')}`;
}

export class DatabaseWorkerRuntime {
  private readonly store: TelemetryStore;
  private sessionsCache?: { version: number; data: DatabaseResult<'getSessions'> };
  private analyticsCache = new Map<string, { version: number; data: DatabaseResult<'getAgentAnalytics'> }>();
  private utilityCallsCache = new Map<string, { version: number; data: DatabaseResult<'getUtilityCalls'> }>();
  private instrumentsCache = new Map<string, { version: number; data: DatabaseResult<'getMetricInstruments'> }>();
  private cacheVersion = -1;
  private tokenStatusCache?: {
    key: string;
    tokenFactsVersion: number;
    data: DatabaseResult<'getTokenStatus'>;
  };

  constructor(dbPath: string) {
    this.store = new TelemetryStore(dbPath);
  }

  async execute<K extends DatabaseOperation>(
    operation: K,
    args: DatabaseArgs<K>,
    queueDurationMs = 0,
  ): Promise<DatabaseResult<K>> {
    const started = performance.now();
    try {
      return await this.dispatch(operation, args);
    } finally {
      const durationMs = performance.now() - started;
      if (durationMs >= SLOW_OPERATION_MS || queueDurationMs >= SLOW_OPERATION_MS) {
        console.warn(
          `Agent Insights database: ${operation} queued ${queueDurationMs.toFixed(1)}ms, `
          + `executed ${durationMs.toFixed(1)}ms`,
        );
      }
    }
  }

  private async dispatch<K extends DatabaseOperation>(
    operation: K,
    args: DatabaseArgs<K>,
  ): Promise<DatabaseResult<K>> {
    const getDb = () => this.store.getDb();
    let result: unknown;

    switch (operation) {
      case 'initialize':
        result = await this.store.initialize();
        break;
      case 'reloadFromDisk':
        result = await this.store.reloadFromDisk();
        this.clearCaches();
        break;
      case 'enablePersistence':
        result = this.store.enablePersistence();
        break;
      case 'relinquishPersistence':
        result = await this.store.relinquishPersistence();
        break;
      case 'clear':
        result = this.store.clear();
        this.clearCaches();
        break;
      case 'close':
        result = this.store.close();
        break;
      case 'insertSpans':
        result = this.store.insertSpans(args as DatabaseArgs<'insertSpans'>);
        break;
      case 'insertMetrics':
        result = this.store.insertMetrics(args as DatabaseArgs<'insertMetrics'>);
        break;
      case 'insertLogs':
        result = this.store.insertLogs(args as DatabaseArgs<'insertLogs'>);
        break;
      case 'getTraces':
        result = getTraces(getDb(), args as DatabaseArgs<'getTraces'>);
        break;
      case 'getTraceMatches':
        result = getTraceMatches(getDb(), args as DatabaseArgs<'getTraceMatches'>);
        break;
      case 'getTraceDetails': {
        const { traceId } = args as DatabaseArgs<'getTraceDetails'>;
        result = {
          spans: getSpansByTraceId(getDb(), traceId),
          sessionId: getSessionIdForTrace(getDb(), traceId),
        };
        break;
      }
      case 'getServices':
        result = getServices(getDb());
        break;
      case 'getSessions':
        result = this.cachedSessions(args as DatabaseArgs<'getSessions'>);
        break;
      case 'getSessionSummary':
        result = getSessionSummary(getDb(), (args as DatabaseArgs<'getSessionSummary'>).sessionId);
        break;
      case 'getSessionMessages':
        result = getSessionMessages(getDb(), (args as DatabaseArgs<'getSessionMessages'>).sessionId);
        break;
      case 'getTraceMessages':
        result = getTraceMessages(getDb(), (args as DatabaseArgs<'getTraceMessages'>).traceId);
        break;
      case 'getLogs':
        result = getLogs(getDb(), args as DatabaseArgs<'getLogs'>);
        break;
      case 'getLogServiceNames':
        result = getLogServiceNames(getDb());
        break;
      case 'getAgentAnalytics':
        result = this.cachedAnalytics(args as DatabaseArgs<'getAgentAnalytics'>);
        break;
      case 'getUtilityCalls':
        result = this.cachedUtilityCalls(args as DatabaseArgs<'getUtilityCalls'>);
        break;
      case 'getMetricInstruments':
        result = this.cachedMetricInstruments(args as DatabaseArgs<'getMetricInstruments'>);
        break;
      case 'getMetricDetail': {
        const input = args as DatabaseArgs<'getMetricDetail'>;
        result = getMetricDetail(
          getDb(),
          input.name,
          input.serviceName,
          input.sinceNano,
          input.untilNano,
        );
        break;
      }
      case 'getRecentErrorTraces': {
        const input = args as DatabaseArgs<'getRecentErrorTraces'>;
        result = getRecentErrorTraces(getDb(), input.limit, input.sinceNano, input.untilNano);
        break;
      }
      case 'getRecentActivity':
        result = this.getRecentActivity(args as DatabaseArgs<'getRecentActivity'>);
        break;
      case 'getServiceNames':
        result = getServiceNames(getDb());
        break;
      case 'getServiceSummary': {
        const input = args as DatabaseArgs<'getServiceSummary'>;
        result = getServiceSummary(
          getDb(),
          input.serviceName,
          input.sinceNano,
          input.untilNano,
          input.visibility,
        );
        break;
      }
      case 'getTokenStatus': {
        const input = args as DatabaseArgs<'getTokenStatus'>;
        if (!this.store.isWritable) {
          result = { writable: false };
          break;
        }
        const tokenFactsVersion = this.store.getTokenFactsVersion();
        const key = [
          input.daySinceNano,
          input.dayUntilNano,
          input.trendSinceNano,
          input.trendUntilNano,
          visibilityKey(input.visibility),
        ].join(':');
        if (
          this.tokenStatusCache?.key === key
          && this.tokenStatusCache.tokenFactsVersion === tokenFactsVersion
        ) {
          result = this.tokenStatusCache.data;
          break;
        }
        const tokenStatus: DatabaseResult<'getTokenStatus'> = {
          writable: true,
          tokenFactsVersion,
          usage: getDailyTokenUsage(
            getDb(),
            input.daySinceNano,
            input.dayUntilNano,
            input.visibility,
          ),
          trend: getTokenTrend(
            getDb(),
            input.trendSinceNano,
            input.trendUntilNano,
            input.visibility,
          ),
        };
        result = tokenStatus;
        this.tokenStatusCache = { key, tokenFactsVersion, data: tokenStatus };
        break;
      }
      default:
        throw new Error(`Unsupported database operation: ${operation}`);
    }

    return result as DatabaseResult<K>;
  }

  private cachedSessions(args: DatabaseArgs<'getSessions'>): DatabaseResult<'getSessions'> {
    const hasOptions = Object.keys(args).length > 0;
    if (hasOptions) { return getSessions(this.store.getDb(), args); }

    const version = this.synchronizeCacheVersion();
    if (!this.sessionsCache || this.sessionsCache.version !== version) {
      this.sessionsCache = { version, data: getSessions(this.store.getDb()) };
    }
    return this.sessionsCache.data;
  }

  private cachedAnalytics(args: DatabaseArgs<'getAgentAnalytics'>): DatabaseResult<'getAgentAnalytics'> {
    const version = this.synchronizeCacheVersion();
    const key = `${args.sinceNano ?? ''}:${args.untilNano ?? ''}:${visibilityKey(args.visibility)}`;
    const cached = this.analyticsCache.get(key);
    if (cached?.version === version) { return cached.data; }

    const data = getAgentAnalytics(
      this.store.getDb(),
      args.sinceNano,
      args.untilNano,
      args.visibility,
    );
    this.analyticsCache.set(key, { version, data });
    return data;
  }

  private cachedUtilityCalls(args: DatabaseArgs<'getUtilityCalls'>): DatabaseResult<'getUtilityCalls'> {
    const version = this.synchronizeCacheVersion();
    const key = `${args.limit ?? ''}:${visibilityKey(args.visibility)}`;
    const cached = this.utilityCallsCache.get(key);
    if (cached?.version === version) { return cached.data; }

    const data = getUtilityCalls(this.store.getDb(), args);
    this.utilityCallsCache.set(key, { version, data });
    return data;
  }

  private cachedMetricInstruments(
    args: DatabaseArgs<'getMetricInstruments'>,
  ): DatabaseResult<'getMetricInstruments'> {
    const version = this.synchronizeCacheVersion();
    const key = `${args.sinceNano ?? ''}:${args.untilNano ?? ''}`;
    const cached = this.instrumentsCache.get(key);
    if (cached?.version === version) { return cached.data; }

    const data = getMetricInstruments(this.store.getDb(), args.sinceNano, args.untilNano);
    this.instrumentsCache.set(key, { version, data });
    return data;
  }

  private getRecentActivity(args: DatabaseArgs<'getRecentActivity'>): RecentActivityResult {
    const db = this.store.getDb();
    const analytics = this.cachedAnalytics(args);
    const timeParts: string[] = [];
    const timeParams: unknown[] = [];
    if (args.sinceNano) {
      timeParts.push('AND start_time_unix_nano >= ?');
      timeParams.push(args.sinceNano);
    }
    if (args.untilNano) {
      timeParts.push('AND start_time_unix_nano <= ?');
      timeParams.push(args.untilNano);
    }
    const timeAnd = timeParts.join(' ');

    const errorStats = db.prepare(`
      SELECT
        SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS error_spans,
        COUNT(DISTINCT CASE WHEN status_code = 2 THEN trace_id END) AS error_traces
      FROM spans
      WHERE 1=1 ${timeAnd}
    `).get(...timeParams);
    const durationRows = db.prepare(`
      SELECT duration_ms FROM spans
      WHERE (parent_span_id IS NULL OR parent_span_id = '') ${timeAnd}
      ORDER BY duration_ms ASC
    `).all(...timeParams);
    const durations = durationRows.map(row => Number(row['duration_ms'] ?? 0));

    return {
      analytics,
      errorSpans: Number(errorStats?.['error_spans'] ?? 0),
      errorTraces: Number(errorStats?.['error_traces'] ?? 0),
      p95DurationMs: durations.length
        ? durations[Math.floor(durations.length * 0.95)] ?? durations[durations.length - 1]!
        : 0,
    };
  }

  private clearCaches(): void {
    this.cacheVersion = -1;
    this.sessionsCache = undefined;
    this.analyticsCache.clear();
    this.utilityCallsCache.clear();
    this.instrumentsCache.clear();
    this.tokenStatusCache = undefined;
  }

  private synchronizeCacheVersion(): number {
    const version = this.store.getDataVersion();
    if (version !== this.cacheVersion) {
      this.cacheVersion = version;
      this.sessionsCache = undefined;
      this.analyticsCache.clear();
      this.utilityCallsCache.clear();
      this.instrumentsCache.clear();
    }
    return version;
  }
}
