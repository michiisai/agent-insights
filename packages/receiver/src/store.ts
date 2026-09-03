import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type SqlJs from 'sql.js';
import {
  AGENT_HOST_SERVICE_NAME,
  TOKEN_ADDITIVE_CACHE_ATTRIBUTE_KEYS,
  TOKEN_ATTRIBUTE_KEYS,
  TOKEN_CHAT_OPERATION,
  TOKEN_OPERATION_ATTRIBUTE,
} from '@agent-insights/types';
import type { QueryableDB } from '@agent-insights/types';
import {
  EXPIRED_SUMMARY_TRACES_SQL,
  MAX_SESSION_SUMMARIES,
  SESSION_FACTS_INDEXES,
  SESSION_FACTS_LOG_HARVEST_SQL,
  SESSION_FACTS_SPAN_HARVEST_SQL,
  SESSION_FACTS_TABLES,
  SESSION_FACTS_TRACE_TABLES,
  SESSION_FACTS_VERSION,
  SESSION_ID_ATTR,
  SESSION_SUMMARY_RETENTION_MS,
  SESSION_TITLE_SPAN_NAME,
  SESSION_URI_ATTR,
  UTILITY_SUMMARY_RETENTION_MS,
} from './sessionFacts';

export {
  SESSION_TITLE_SPAN_NAME,
  SESSION_URI_ATTR,
} from './sessionFacts';

// Flatten OTLP attributes while preserving array structure; kvlist and bytes become null.
const flatAttrs = (rawExpr: string, arrPath: string): string => `
    (SELECT COALESCE(json_group_object(
       json_extract(a.value, '$.key'),
       CASE
         WHEN json_type(a.value, '$.value.arrayValue.values') = 'array' THEN
           (SELECT json_group_array(
              COALESCE(
                json_extract(v.value, '$.stringValue'),
                CAST(json_extract(v.value, '$.intValue') AS INTEGER),
                json_extract(v.value, '$.doubleValue'),
                json_extract(v.value, '$.boolValue')
              ))
            FROM json_each(json_extract(a.value, '$.value.arrayValue.values')) v)
         ELSE COALESCE(
           json_extract(a.value, '$.value.stringValue'),
           CAST(json_extract(a.value, '$.value.intValue') AS INTEGER),
           json_extract(a.value, '$.value.doubleValue'),
           json_extract(a.value, '$.value.boolValue')
         )
       END
     ), '{}')
     FROM json_each(COALESCE(json_extract(${rawExpr}, '${arrPath}'), '[]')) a)`;

const serviceName = (rawExpr: string): string => `
    (SELECT COALESCE(json_extract(r.value, '$.value.stringValue'), '')
     FROM json_each(COALESCE(json_extract(${rawExpr}, '$.resource.attributes'), '[]')) r
     WHERE json_extract(r.value, '$.key') = 'service.name'
     LIMIT 1)`;

const attrValue = (rawExpr: string, arrPath: string, key: string): string => `
    (SELECT json_extract(a.value, '$.value.stringValue')
     FROM json_each(COALESCE(json_extract(${rawExpr}, '${arrPath}'), '[]')) a
     WHERE json_extract(a.value, '$.key') = '${key}'
     LIMIT 1)`;

const ATTR_PATH = {
  raw_spans:   '$.span.attributes',
  raw_metrics: '$.dataPoint.attributes',
  raw_logs:    '$.logRecord.attributes',
} as const;

// One definition drives the schema, writes, migrations, and views.
interface DerivedColumn {
  name: string;
  type: 'TEXT' | 'INTEGER' | 'REAL';
  expr: (rawExpr: string) => string;
  /** Keep payload columns last to make scalar scans cheaper. */
  large?: boolean;
}

const jsonCol = (
  name: string,
  type: DerivedColumn['type'],
  path: string,
  fallback?: string,
): DerivedColumn => ({
  name,
  type,
  expr: (raw) => fallback === undefined
    ? `json_extract(${raw}, '${path}')`
    : `COALESCE(json_extract(${raw}, '${path}'), ${fallback})`,
});

const COMMON_DERIVED = (table: RawTable): DerivedColumn[] => [
  { name: 'service_name', type: 'TEXT', expr: (raw) => serviceName(raw) },
  { name: 'attributes',   type: 'TEXT', expr: (raw) => flatAttrs(raw, ATTR_PATH[table]), large: true },
];

const DERIVED: Record<RawTable, DerivedColumn[]> = {
  raw_spans: [
    jsonCol('trace_id',             'TEXT',    '$.span.traceId'),
    jsonCol('span_id',              'TEXT',    '$.span.spanId'),
    jsonCol('parent_span_id',       'TEXT',    '$.span.parentSpanId'),
    jsonCol('name',                 'TEXT',    '$.span.name'),
    jsonCol('kind',                 'INTEGER', '$.span.kind', '0'),
    jsonCol('start_time_unix_nano', 'TEXT',    '$.span.startTimeUnixNano'),
    jsonCol('end_time_unix_nano',   'TEXT',    '$.span.endTimeUnixNano'),
    jsonCol('status_code',          'INTEGER', '$.span.status.code', '0'),
    jsonCol('status_message',       'TEXT',    '$.span.status.message'),
    ...COMMON_DERIVED('raw_spans'),
  ],
  raw_metrics: [
    jsonCol('name',                 'TEXT',    '$.metric.name'),
    jsonCol('metric_type',          'TEXT',    '$.metricType'),
    {
      name: 'value', type: 'REAL',
      expr: (raw) => `COALESCE(
        json_extract(${raw}, '$.dataPoint.asDouble'),
        CAST(json_extract(${raw}, '$.dataPoint.asInt') AS REAL),
        json_extract(${raw}, '$.dataPoint.sum'))`,
    },
    { name: 'data_count', type: 'REAL', expr: (raw) => `CAST(json_extract(${raw}, '$.dataPoint.count') AS REAL)` },
    { name: 'data_sum',   type: 'REAL', expr: (raw) => `CAST(json_extract(${raw}, '$.dataPoint.sum')   AS REAL)` },
    { name: 'data_min',   type: 'REAL', expr: (raw) => `CAST(json_extract(${raw}, '$.dataPoint.min')   AS REAL)` },
    { name: 'data_max',   type: 'REAL', expr: (raw) => `CAST(json_extract(${raw}, '$.dataPoint.max')   AS REAL)` },
    jsonCol('temporality',          'INTEGER', '$.aggregation.aggregationTemporality', '0'),
    jsonCol('timestamp_unix_nano',  'TEXT',    '$.dataPoint.timeUnixNano', `'0'`),
    // A changed start time identifies a reset cumulative series.
    jsonCol('start_time_unix_nano', 'TEXT',    '$.dataPoint.startTimeUnixNano', `'0'`),
    jsonCol('unit',                 'TEXT',    '$.metric.unit'),
    ...COMMON_DERIVED('raw_metrics'),
  ],
  raw_logs: [
    {
      name: 'timestamp_unix_nano', type: 'TEXT',
      // Codex may put the real clock in observedTimeUnixNano.
      expr: (raw) => `COALESCE(NULLIF(NULLIF(json_extract(${raw}, '$.logRecord.timeUnixNano'), '0'), 0),
                               json_extract(${raw}, '$.logRecord.observedTimeUnixNano'), '0')`,
    },
    jsonCol('severity_number',      'INTEGER', '$.logRecord.severityNumber', '0'),
    jsonCol('severity_text',        'TEXT',    '$.logRecord.severityText', `''`),
    {
      name: 'body', type: 'TEXT',
      // Event-style logs may put content in event.name instead of body.
      expr: (raw) => `COALESCE(NULLIF(COALESCE(json_extract(${raw}, '$.logRecord.body.stringValue'),
                                              json_extract(${raw}, '$.logRecord.body')), ''),
                               ${attrValue(raw, ATTR_PATH.raw_logs, 'event.name')}
                                 || COALESCE(': ' || ${attrValue(raw, ATTR_PATH.raw_logs, 'event.kind')}, ''),
                               json_extract(${raw}, '$.logRecord.eventName'), '')`,
    },
    jsonCol('trace_id',             'TEXT',    '$.logRecord.traceId'),
    jsonCol('span_id',              'TEXT',    '$.logRecord.spanId'),
    ...COMMON_DERIVED('raw_logs'),
  ],
};

// Bump when derived expressions change; NULL can be valid data.
const DERIVED_VERSION = 3;

const scalarCols = (table: RawTable): DerivedColumn[] => DERIVED[table].filter(c => !c.large);
const largeCols  = (table: RawTable): DerivedColumn[] => DERIVED[table].filter(c =>  c.large);

/** Canonical physical order: scalars before payloads. */
const tableColumns = (table: RawTable): { name: string; decl: string }[] => [
  { name: 'id',         decl: 'id INTEGER PRIMARY KEY AUTOINCREMENT' },
  ...scalarCols(table).map(c => ({ name: c.name, decl: `${c.name} ${c.type}` })),
  { name: 'derived_v',  decl: 'derived_v INTEGER' },
  { name: 'created_at', decl: 'created_at INTEGER NOT NULL DEFAULT (unixepoch())' },
  ...largeCols(table).map(c => ({ name: c.name, decl: `${c.name} ${c.type}` })),
  { name: 'raw',        decl: 'raw TEXT NOT NULL' },
];

const createTableSql = (table: RawTable, as: string = table): string =>
  `CREATE TABLE IF NOT EXISTS ${as} (\n  ${tableColumns(table).map(c => c.decl).join(',\n  ')}\n)`;

const RAW_TABLES: RawTable[] = ['raw_spans', 'raw_metrics', 'raw_logs'];

const SCHEMA_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_spans_spanid ON raw_spans(span_id);
-- Supports trace lookups and recursive parent-to-child walks.
CREATE INDEX IF NOT EXISTS idx_raw_spans_trace   ON raw_spans(trace_id, parent_span_id);
CREATE INDEX IF NOT EXISTS idx_raw_spans_start   ON raw_spans(start_time_unix_nano);
CREATE INDEX IF NOT EXISTS idx_token_facts_ts    ON token_facts(timestamp_unix_nano);
CREATE INDEX IF NOT EXISTS idx_raw_metrics_name  ON raw_metrics(name);
CREATE INDEX IF NOT EXISTS idx_raw_metrics_ts    ON raw_metrics(timestamp_unix_nano);
CREATE INDEX IF NOT EXISTS idx_raw_logs_severity ON raw_logs(severity_number);
CREATE INDEX IF NOT EXISTS idx_raw_logs_ts       ON raw_logs(timestamp_unix_nano);
-- Claude and Codex conversation queries select logs by trace.
CREATE INDEX IF NOT EXISTS idx_raw_logs_trace    ON raw_logs(trace_id);
CREATE INDEX IF NOT EXISTS idx_codex_sessions_conv ON codex_trace_sessions(conversation_id);
`;

const LEGACY_INDEXES = [
  'idx_raw_spans_spanid', 'idx_raw_spans_trace', 'idx_raw_spans_start',
  'idx_raw_metrics_name', 'idx_raw_metrics_ts',
  'idx_raw_logs_severity', 'idx_raw_logs_ts',
];

// Project titles outside raw retention while keeping their spans as telemetry.
const SESSION_TITLE_ATTR = 'vscode.agent_host.session.title';

const SESSION_TITLES_TABLE = `
CREATE TABLE IF NOT EXISTS session_titles (
  session_id   TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  updated_nano TEXT NOT NULL,
  agent        TEXT
)`;

// Map Codex trace fragments to an anchored session through conversation IDs.
const CODEX_CONVERSATION_ATTR = 'conversation.id';

const CODEX_SESSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS codex_trace_sessions (
  trace_id        TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  session_id      TEXT NOT NULL
)`;

// Preserve promoted aliases when seeding newly observed Codex traces.
const HARVEST_CODEX_SESSIONS_SQL = `
INSERT OR IGNORE INTO codex_trace_sessions (trace_id, conversation_id, session_id)
SELECT trace_id, conversation_id, conversation_id
  FROM (
    SELECT trace_id,
           MAX(json_extract(attributes, '$."${CODEX_CONVERSATION_ATTR}"')) AS conversation_id
      FROM raw_logs
     WHERE id > :since
       AND COALESCE(trace_id, '') <> ''
       AND json_extract(attributes, '$."${CODEX_CONVERSATION_ATTR}"') IS NOT NULL
     GROUP BY trace_id
  )`;

// Resolve pending sibling traces from host-span anchors.
const CODEX_SESSIONS_TO_PROMOTE_SQL = `
SELECT k.conversation_id AS conversation_id,
       MAX(json_extract(s.attributes, '$."${SESSION_ID_ATTR}"')) AS session_id
  FROM codex_trace_sessions k
  JOIN raw_spans s ON s.trace_id = k.trace_id
 WHERE (s.service_name = '${AGENT_HOST_SERVICE_NAME}' OR s.name LIKE 'vscode.agent_host.%')
   AND json_extract(s.attributes, '$."${SESSION_ID_ATTR}"') IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM codex_trace_sessions pending
      WHERE pending.conversation_id = k.conversation_id
        AND pending.session_id = pending.conversation_id
   )
 GROUP BY k.conversation_id`;

const TOKEN_FACTS_VERSION = 3;
const TOKEN_FACT_RETENTION_MS = 9 * 24 * 60 * 60 * 1000;

const tokenAttr = (key: string, alias = ''): string =>
  `json_extract(${alias ? `${alias}.` : ''}attributes, '$."${key}"')`;
const firstTokenAttr = (keys: readonly string[], fallback: string, alias = ''): string =>
  `COALESCE(${keys.map(key => tokenAttr(key, alias)).join(', ')}, ${fallback})`;
const hasTokenAttr = (keys: readonly string[], alias = ''): string =>
  `(${keys.map(key => `${tokenAttr(key, alias)} IS NOT NULL`).join(' OR ')})`;

const TOKEN_DIRECT_MODEL_EXPR = firstTokenAttr(TOKEN_ATTRIBUTE_KEYS.model, 'NULL', 's');
const TOKEN_ANCESTOR_MODEL_EXPR = `(
  WITH RECURSIVE token_ancestors(trace_id, parent_span_id, attributes, depth) AS (
    SELECT parent.trace_id, parent.parent_span_id, parent.attributes, 1
      FROM raw_spans parent
     WHERE parent.trace_id = s.trace_id
       AND parent.span_id = s.parent_span_id
    UNION ALL
    SELECT parent.trace_id, parent.parent_span_id, parent.attributes, ancestor.depth + 1
      FROM raw_spans parent
      JOIN token_ancestors ancestor
        ON parent.trace_id = ancestor.trace_id
       AND parent.span_id = ancestor.parent_span_id
     WHERE ancestor.depth < 64
  )
  SELECT ${firstTokenAttr(TOKEN_ATTRIBUTE_KEYS.model, 'NULL', 'ancestor')}
    FROM token_ancestors ancestor
   WHERE ${hasTokenAttr(TOKEN_ATTRIBUTE_KEYS.model, 'ancestor')}
   ORDER BY ancestor.depth
   LIMIT 1
)`;
const TOKEN_MODEL_EXPR = `COALESCE(
  ${TOKEN_DIRECT_MODEL_EXPR},
  ${TOKEN_ANCESTOR_MODEL_EXPR},
  'unknown'
)`;
const TOKEN_INPUT_EXPR = firstTokenAttr(TOKEN_ATTRIBUTE_KEYS.input, '0', 's');
const TOKEN_OUTPUT_EXPR = firstTokenAttr(TOKEN_ATTRIBUTE_KEYS.output, '0', 's');
const TOKEN_CACHE_READ_EXPR = firstTokenAttr(TOKEN_ATTRIBUTE_KEYS.cacheRead, '0', 's');
const TOKEN_CACHE_CREATION_EXPR = firstTokenAttr(TOKEN_ATTRIBUTE_KEYS.cacheCreation, '0', 's');
const TOKEN_OPERATION_EXPR = tokenAttr(TOKEN_OPERATION_ATTRIBUTE, 's');
const TOKEN_VALUE_PREDICATE = hasTokenAttr([
  ...TOKEN_ATTRIBUTE_KEYS.input,
  ...TOKEN_ATTRIBUTE_KEYS.output,
  ...TOKEN_ATTRIBUTE_KEYS.cacheRead,
  ...TOKEN_ATTRIBUTE_KEYS.cacheCreation,
], 's');
const TOKEN_ADDITIVE_PREDICATE = hasTokenAttr(TOKEN_ADDITIVE_CACHE_ATTRIBUTE_KEYS, 's');
const TOKEN_LEGACY_NAME_PREDICATE = `(
  s.name = 'chat'
  OR s.name LIKE 'chat %'
  OR s.name LIKE '%llm_request%'
  OR s.name = 'handle_responses'
)`;
const TOKEN_OPERATION_PREDICATE = `(
  ${TOKEN_OPERATION_EXPR} = '${TOKEN_CHAT_OPERATION}'
  OR (${TOKEN_OPERATION_EXPR} IS NULL AND ${TOKEN_LEGACY_NAME_PREDICATE})
)`;
const TOKEN_PROVIDER_PREDICATE = `(
  s.service_name != '${AGENT_HOST_SERVICE_NAME}'
  AND s.name NOT LIKE 'vscode.agent_host.%'
)`;

const TOKEN_FACTS_TABLE = `
CREATE TABLE IF NOT EXISTS token_facts (
  span_id                 TEXT PRIMARY KEY,
  trace_id                TEXT,
  parent_span_id          TEXT,
  timestamp_unix_nano     TEXT NOT NULL,
  model                   TEXT NOT NULL,
  operation_name          TEXT,
  input_tokens            REAL NOT NULL,
  output_tokens           REAL NOT NULL,
  cache_read_tokens       REAL NOT NULL,
  cache_creation_tokens   REAL NOT NULL,
  is_additive             INTEGER NOT NULL,
  facts_v                 INTEGER NOT NULL
)`;

const TOKEN_FACTS_META_TABLE = `
CREATE TABLE IF NOT EXISTS token_facts_meta (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  last_span_row_id INTEGER NOT NULL,
  facts_v          INTEGER NOT NULL
)`;

const HARVEST_TOKEN_FACTS_SQL = `
INSERT OR REPLACE INTO token_facts (
  span_id, trace_id, parent_span_id, timestamp_unix_nano, model, operation_name,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
  is_additive, facts_v
)
SELECT s.span_id,
       s.trace_id,
       s.parent_span_id,
       s.start_time_unix_nano,
       CAST(${TOKEN_MODEL_EXPR} AS TEXT),
       CAST(${TOKEN_OPERATION_EXPR} AS TEXT),
       CAST(${TOKEN_INPUT_EXPR} AS REAL),
       CAST(${TOKEN_OUTPUT_EXPR} AS REAL),
       CAST(${TOKEN_CACHE_READ_EXPR} AS REAL),
       CAST(${TOKEN_CACHE_CREATION_EXPR} AS REAL),
       CASE WHEN ${TOKEN_ADDITIVE_PREDICATE} THEN 1 ELSE 0 END,
       ${TOKEN_FACTS_VERSION}
  FROM raw_spans s
 WHERE s.id > :since
   AND s.span_id IS NOT NULL
   AND s.start_time_unix_nano IS NOT NULL
   AND ${TOKEN_PROVIDER_PREDICATE}
   AND ${TOKEN_VALUE_PREDICATE}
   AND ${TOKEN_OPERATION_PREDICATE}`;

/** Session URI scheme, or NULL when the URI has no scheme. */
const SESSION_AGENT_EXPR = `NULLIF(
  substr(
    json_extract(attributes, '$."${SESSION_URI_ATTR}"'),
    1,
    instr(COALESCE(json_extract(attributes, '$."${SESSION_URI_ATTR}"'), ''), ':') - 1
  ), '')`;

// The timestamp guard makes title updates independent of row order.
const HARVEST_TITLES_SQL = `
INSERT INTO session_titles (session_id, title, updated_nano, agent)
SELECT json_extract(attributes, '$."${SESSION_ID_ATTR}"'),
       TRIM(json_extract(attributes, '$."${SESSION_TITLE_ATTR}"')),
       COALESCE(start_time_unix_nano, '0'),
       ${SESSION_AGENT_EXPR}
  FROM raw_spans
 WHERE id > :since
   AND name = '${SESSION_TITLE_SPAN_NAME}'
   AND json_extract(attributes, '$."${SESSION_ID_ATTR}"') IS NOT NULL
   AND TRIM(COALESCE(json_extract(attributes, '$."${SESSION_TITLE_ATTR}"'), '')) <> ''
ON CONFLICT(session_id) DO UPDATE SET
      title        = excluded.title,
      updated_nano = excluded.updated_nano,
      agent        = COALESCE(excluded.agent, session_titles.agent)
 WHERE CAST(excluded.updated_nano AS INTEGER) >= CAST(session_titles.updated_nano AS INTEGER)`;

// Recreate data-free views to apply definition changes without migrating tables.
const SCHEMA_VIEWS = `
DROP VIEW IF EXISTS spans;
DROP VIEW IF EXISTS metric_points;
DROP VIEW IF EXISTS logs;

CREATE VIEW IF NOT EXISTS spans AS
  SELECT
    e.id AS id,
    e.trace_id, e.span_id, e.parent_span_id, e.name, e.kind,
    e.start_time_unix_nano, e.end_time_unix_nano,
    (CAST(COALESCE(e.end_time_unix_nano,   '0') AS INTEGER)
     - CAST(COALESCE(e.start_time_unix_nano, '0') AS INTEGER)) / 1000000.0 AS duration_ms,
    e.status_code, e.status_message,
    e.attributes, e.service_name,
    e.raw
  FROM raw_spans e;

CREATE VIEW IF NOT EXISTS metric_points AS
  SELECT
    e.id AS id,
    e.name, e.metric_type, e.value,
    e.data_count, e.data_sum, e.data_min, e.data_max,
    e.temporality, e.timestamp_unix_nano, e.start_time_unix_nano,
    e.attributes, e.unit, e.service_name,
    e.raw
  FROM raw_metrics e;

CREATE VIEW IF NOT EXISTS logs AS
  SELECT
    e.id AS id,
    e.timestamp_unix_nano, e.severity_number, e.severity_text, e.body,
    e.attributes, e.trace_id, e.span_id, e.service_name,
    e.raw
  FROM raw_logs e;
`;

export interface SpanRow  { raw: string }
export interface MetricRow { raw: string }
export interface LogRow   { raw: string }

/** Adapts sql.js to the engine's synchronous QueryableDB interface. */
class DatabaseAdapter implements QueryableDB {
  constructor(private readonly sqlDb: SqlJs.Database) {}

  prepare(sql: string) {
    const self = this;
    return {
      all(...args: unknown[]) { return self.query(sql, args); },
      get(...args: unknown[]) { return self.query(sql, args)[0]; },
      run(...args: unknown[]) {
        self.sqlDb.run(sql, args.length ? (args as SqlJs.BindParams) : undefined);
      },
    };
  }

  exec(sql: string): void {
    this.sqlDb.run(sql);
  }

  runInTransaction<T>(rows: T[], fn: (db: SqlJs.Database, rows: T[]) => void): void {
    this.sqlDb.run('BEGIN');
    try {
      fn(this.sqlDb, rows);
      this.sqlDb.run('COMMIT');
    } catch (err) {
      this.sqlDb.run('ROLLBACK');
      throw err;
    }
  }

  private query(sql: string, args: unknown[]): Record<string, unknown>[] {
    const stmt = this.sqlDb.prepare(sql);
    if (args.length) { stmt.bind(args as SqlJs.BindParams); }
    const out: Record<string, unknown>[] = [];
    while (stmt.step()) { out.push(stmt.getAsObject() as Record<string, unknown>); }
    stmt.free();
    return out;
  }
}

const MAX_SPANS   = 50_000;
const MAX_METRICS = 50_000;
const MAX_LOGS    = 50_000;

// Byte caps bound full-file rewrites independently of row counts.
const MAX_SPAN_BYTES   = 128 * 1024 * 1024;
const MAX_METRIC_BYTES = 32 * 1024 * 1024;
const MAX_LOG_BYTES    = 32 * 1024 * 1024;

// Delay costly size scans until this much payload has arrived.
const BYTE_CHECK_DELTA = 8 * 1024 * 1024;

// Include the flattened attribute copy in size estimates.
const SIZE_EXPR = 'LENGTH(raw) + COALESCE(LENGTH(attributes), 0)';

// Prevent high-volume services from fully evicting quieter ones.
const PER_SERVICE_FLOOR = 5_000;

// Keep the byte-budget floor small enough for the budget to bind.
const PER_SERVICE_BYTE_FLOOR = 50;

// VACUUM only when enough free pages justify its temporary memory cost.
const VACUUM_FREE_RATIO = 0.25;

export type RawTable = 'raw_spans' | 'raw_metrics' | 'raw_logs';

export interface RetentionLimits {
  maxRows: number;
  maxBytes: number;
  perServiceFloor: number;
  /** Rows per service exempt from the byte budget. */
  perServiceByteFloor: number;
  /** New payload required before measuring the byte budget. */
  byteCheckDelta: number;
}

/** Per-table retention overrides, primarily for testing. */
export type RetentionOverrides = Partial<Record<RawTable, Partial<RetentionLimits>>>;

// Separate scratch files prevent periodic and shutdown saves from colliding.
const ASYNC_TMP = (dbPath: string): string => `${dbPath}.tmp`;
const SYNC_TMP  = (dbPath: string): string => `${dbPath}.sync.tmp`;

const RETENTION: Record<RawTable, RetentionLimits> = {
  raw_spans:   { maxRows: MAX_SPANS,   maxBytes: MAX_SPAN_BYTES,   perServiceFloor: PER_SERVICE_FLOOR, perServiceByteFloor: PER_SERVICE_BYTE_FLOOR, byteCheckDelta: BYTE_CHECK_DELTA },
  raw_metrics: { maxRows: MAX_METRICS, maxBytes: MAX_METRIC_BYTES, perServiceFloor: PER_SERVICE_FLOOR, perServiceByteFloor: PER_SERVICE_BYTE_FLOOR, byteCheckDelta: BYTE_CHECK_DELTA },
  raw_logs:    { maxRows: MAX_LOGS,    maxBytes: MAX_LOG_BYTES,    perServiceFloor: PER_SERVICE_FLOOR, perServiceByteFloor: PER_SERVICE_BYTE_FLOOR, byteCheckDelta: BYTE_CHECK_DELTA },
};

export class TelemetryStore {
  private sqlDb!: SqlJs.Database;
  private adapter!: DatabaseAdapter;
  private saveTimer?: ReturnType<typeof setInterval>;
  private writable = false;
  private dataVersion = 0;
  // Version of the last successful write.
  private flushedVersion = -1;
  // Collapse overlapping full-database writes into one follow-up flush.
  private flushInFlight = false;
  private flushQueued = false;
  private readonly flushIdleWaiters = new Set<() => void>();
  // Prevent in-flight periodic saves from overwriting the final save.
  private closing = false;
  private bytesSinceCheck: Record<RawTable, number> = {
    raw_spans: 0, raw_metrics: 0, raw_logs: 0,
  };
  private lastTitleScanId = 0;
  private lastCodexLogScanId = 0;
  private lastTokenFactScanId = 0;
  private tokenFactsVersion = 0;
  private tokenFactsReady = false;
  private lastTokenFactPruneDay = '';
  private lastSessionFactSpanId = 0;
  private lastSessionFactLogId = 0;
  private lastSessionFactPruneDay = '';
  private readonly retention: Record<RawTable, RetentionLimits>;

  constructor(private readonly dbPath: string, overrides: RetentionOverrides = {}) {
    this.retention = {
      raw_spans:   { ...RETENTION.raw_spans,   ...overrides.raw_spans   },
      raw_metrics: { ...RETENTION.raw_metrics, ...overrides.raw_metrics },
      raw_logs:    { ...RETENTION.raw_logs,    ...overrides.raw_logs    },
    };
  }

  async initialize(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
    const initSqlJs = require('sql.js') as (cfg?: any) => Promise<SqlJs.SqlJsStatic>;
    const SQL = await initSqlJs();

    if (fs.existsSync(this.dbPath)) {
      this.sqlDb = new SQL.Database(fs.readFileSync(this.dbPath));
    } else {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      this.sqlDb = new SQL.Database();
    }

    this.prepareDatabase();
  }

  /** Refresh a read-only store before competing for ownership. */
  async reloadFromDisk(): Promise<void> {
    if (this.writable) {
      throw new Error('Cannot reload a writable telemetry store');
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
    const initSqlJs = require('sql.js') as (cfg?: any) => Promise<SqlJs.SqlJsStatic>;
    const SQL = await initSqlJs();
    const nextDb = fs.existsSync(this.dbPath)
      ? new SQL.Database(fs.readFileSync(this.dbPath))
      : new SQL.Database();

    this.sqlDb.close();
    this.sqlDb = nextDb;
    this.dataVersion = 0;
    this.flushedVersion = -1;
    this.lastTitleScanId = 0;
    this.lastCodexLogScanId = 0;
    this.lastTokenFactScanId = 0;
    this.tokenFactsVersion = 0;
    this.tokenFactsReady = false;
    this.lastTokenFactPruneDay = '';
    this.lastSessionFactSpanId = 0;
    this.lastSessionFactLogId = 0;
    this.lastSessionFactPruneDay = '';
    this.bytesSinceCheck = { raw_spans: 0, raw_metrics: 0, raw_logs: 0 };

    this.prepareDatabase();
  }

  private prepareDatabase(): void {
    this.dropLegacyTables();
    for (const table of RAW_TABLES) { this.sqlDb.run(createTableSql(table)); }
    this.sqlDb.run(SESSION_TITLES_TABLE);
    this.sqlDb.run(CODEX_SESSIONS_TABLE);
    this.sqlDb.run(TOKEN_FACTS_TABLE);
    this.sqlDb.run(TOKEN_FACTS_META_TABLE);
    for (const stmt of SESSION_FACTS_TABLES) { this.sqlDb.run(stmt); }
    this.ensureSessionTitleColumns();
    this.ensureSchema();
    // Drop same-named legacy definitions before recreating indexes.
    for (const name of LEGACY_INDEXES) { this.sqlDb.run(`DROP INDEX IF EXISTS ${name}`); }
    // Backfill before building indexes.
    this.backfillDerivedColumns();
    for (const stmt of SCHEMA_INDEXES.split(';').map(s => s.trim()).filter(Boolean)) {
      this.sqlDb.run(stmt);
    }
    for (const stmt of SESSION_FACTS_INDEXES) { this.sqlDb.run(stmt); }
    this.refreshQueryStats();
    for (const stmt of SCHEMA_VIEWS.split(';').map(s => s.trim()).filter(Boolean)) {
      this.sqlDb.run(stmt);
    }
    this.adapter = new DatabaseAdapter(this.sqlDb);
    // Full sweeps migrate pre-projection stores before retention runs.
    this.harvestSessionTitles({ from: 0 });
    this.harvestCodexSessions({ from: 0 });
    // Resume summaries before reclaim can remove unprojected rows.
    this.initializeSessionFacts();
    this.reclaim();
  }

  /** Apply all retention rules, then compact once if needed. */
  private reclaim(): void {
    let pruned = false;
    for (const table of Object.keys(this.retention) as RawTable[]) {
      if (this.pruneTable(table, { force: true, compact: false })) { pruned = true; }
    }
    this.vacuumIfBloated({ force: pruned });
  }

  /** Enable persistence only for the window that owns the OTLP port. */
  enablePersistence(): void {
    if (this.writable) { return; }
    // Only the writer may remove another save's stale scratch files.
    for (const stale of [ASYNC_TMP(this.dbPath), SYNC_TMP(this.dbPath)]) {
      try {
        if (fs.existsSync(stale)) { fs.unlinkSync(stale); }
      } catch { /* best effort; a stale scratch file is harmless */ }
    }
    this.closing = false;
    this.initializeTokenFacts();
    this.writable = true;
    this.saveTimer = setInterval(() => { void this.flushAsync(); }, 30_000);
  }

  /** Flush and relinquish the single-writer role without closing the snapshot. */
  async relinquishPersistence(): Promise<void> {
    if (!this.writable) { return; }
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.closing = true;
    if (this.flushInFlight) {
      await new Promise<void>(resolve => this.flushIdleWaiters.add(resolve));
    }

    let flushError: unknown;
    try {
      this.flush();
    } catch (error) {
      flushError = error;
    } finally {
      this.writable = false;
      this.closing = false;
    }
    if (flushError) { throw flushError; }
  }

  get isWritable(): boolean {
    return this.writable;
  }

  /** Add missing title columns without rebuilding durable title rows. */
  private ensureSessionTitleColumns(): void {
    const info = this.sqlDb.exec('PRAGMA table_info(session_titles)')[0];
    const cols = new Set((info?.values ?? []).map(v => String(v[1])));
    if (!cols.has('agent')) {
      this.sqlDb.run('ALTER TABLE session_titles ADD COLUMN agent TEXT');
    }
  }

  /** Rebuild old tables into canonical physical column order. */
  private ensureSchema(): void {
    for (const table of RAW_TABLES) {
      const info = this.sqlDb.exec(`PRAGMA table_info(${table})`)[0];
      const actual = (info?.values ?? []).map(v => String(v[1]));
      const expected = tableColumns(table).map(c => c.name);
      if (actual.length === expected.length && actual.every((c, i) => c === expected[i])) { continue; }

      const had = new Set(actual);
      const tmp = `${table}__rebuild`;
      this.sqlDb.run(`DROP TABLE IF EXISTS ${tmp}`);
      this.sqlDb.run(createTableSql(table, tmp));

      // Reuse existing values, especially expensive flattened attributes.
      const carried = (c: DerivedColumn): string =>
        had.has(c.name) ? `COALESCE(${c.name}, ${c.expr('raw')})` : c.expr('raw');

      const cols = [...scalarCols(table), ...largeCols(table)];
      this.sqlDb.run(
        `INSERT INTO ${tmp} (id, created_at, derived_v, raw, ${cols.map(c => c.name).join(', ')})
         SELECT id,
                ${had.has('created_at') ? 'created_at' : 'unixepoch()'},
                ${DERIVED_VERSION},
                raw,
                ${cols.map(carried).join(',\n                ')}
         FROM ${table}`,
      );
      this.sqlDb.run(`DROP TABLE ${table}`);
      this.sqlDb.run(`ALTER TABLE ${tmp} RENAME TO ${table}`);
    }
  }

  // Backfill by version because derived NULLs may be valid.
  private backfillDerivedColumns(): void {
    for (const table of RAW_TABLES) {
      const assignments = DERIVED[table]
        .map(c => `${c.name} = ${c.expr(`${table}.raw`)}`)
        .join(',\n           ');
      this.sqlDb.run(
        `UPDATE ${table} SET
           ${assignments},
           derived_v = ${DERIVED_VERSION}
         WHERE derived_v IS NULL OR derived_v < ${DERIVED_VERSION}`,
      );
    }
  }

  // Avoid stale zero-row statistics on a newly filling store.
  private refreshQueryStats(): void {
    const rows = this.sqlDb.exec('SELECT COUNT(*) FROM raw_spans')[0]?.values?.[0]?.[0];
    if (Number(rows ?? 0) > 0) { this.sqlDb.run('ANALYZE'); }
  }

  private dropLegacyTables(): void {
    const isTable = (name: string): boolean => {
      const res = this.sqlDb.exec(
        `SELECT type FROM sqlite_master WHERE name = '${name}'`,
      )[0];
      return res?.values?.[0]?.[0] === 'table';
    };
    for (const name of ['spans', 'metric_points', 'logs']) {
      if (isTable(name)) { this.sqlDb.run(`DROP TABLE ${name}`); }
    }
  }

  getDb(): QueryableDB {
    return this.adapter;
  }

  getDataVersion(): number {
    return this.dataVersion;
  }

  getTokenFactsVersion(): number {
    return this.tokenFactsVersion;
  }

  /** Build inserts from the shared derived-column definition. */
  private static insertSql(table: RawTable, orIgnore = false): string {
    const cols = DERIVED[table];
    const names = cols.map(c => c.name).join(', ');
    const values = cols.map(c => c.expr(':raw')).join(',\n           ');
    return `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO ${table} (raw, ${names}, derived_v)
            VALUES (:raw,
           ${values},
           ${DERIVED_VERSION})`;
  }

  insertSpans(rows: SpanRow[]): void {
    if (!rows.length) { return; }
    this.adapter.runInTransaction(rows, (db, rs) => {
      const s = db.prepare(TelemetryStore.insertSql('raw_spans', true));
      for (const r of rs) { s.run({ ':raw': r.raw }); }
      s.free();
    });
    this.recordBytes('raw_spans', rows);
    this.harvestSessionTitles();
    // Anchors and provider traces may arrive in either order.
    this.promoteCodexSessions();
    if (this.tokenFactsReady) {
      this.harvestTokenFacts();
      this.pruneTokenFacts();
    }
    // Project facts before pruning their source spans.
    this.harvestSessionFacts();
    this.pruneSessionFacts();
    this.pruneTable('raw_spans');
    this.dataVersion++;
  }

  /** Copy new title spans into durable storage before pruning. */
  private harvestSessionTitles(opts: { from?: number } = {}): void {
    const since = opts.from ?? this.lastTitleScanId;
    const maxId = this.scalar('SELECT COALESCE(MAX(id), 0) FROM raw_spans');
    if (maxId > since) {
      this.sqlDb.run(HARVEST_TITLES_SQL, { ':since': since });
    }
    this.lastTitleScanId = Math.max(this.lastTitleScanId, maxId);
  }

  /** Persist Codex session aliases before pruning their source logs. */
  private harvestCodexSessions(opts: { from?: number } = {}): void {
    const since = opts.from ?? this.lastCodexLogScanId;
    const maxId = this.scalar('SELECT COALESCE(MAX(id), 0) FROM raw_logs');
    if (maxId > since) {
      this.sqlDb.run(HARVEST_CODEX_SESSIONS_SQL, { ':since': since });
    }
    this.lastCodexLogScanId = Math.max(this.lastCodexLogScanId, maxId);
    this.promoteCodexSessions();
  }

  /** Promote every trace once any sibling reveals the host session ID. */
  private promoteCodexSessions(): void {
    const resolved = this.sqlDb.exec(CODEX_SESSIONS_TO_PROMOTE_SQL)[0];
    for (const [conversationId, sessionId] of (resolved?.values ?? [])) {
      this.sqlDb.run(
        `UPDATE codex_trace_sessions
            SET session_id = :session
          WHERE conversation_id = :conversation`,
        { ':session': String(sessionId), ':conversation': String(conversationId) },
      );
    }
  }

  /** Start summaries at the install boundary without backfilling pruned history. */
  private initializeSessionFacts(): void {
    const meta = this.sqlDb.exec(
      'SELECT last_span_row_id, last_log_row_id, facts_v FROM session_facts_meta WHERE id = 1',
    )[0]?.values[0];

    const storedVersion = Number(meta?.[2] ?? 0);
    if (!meta || storedVersion === 1) {
      this.startSessionFactsFresh();
      return;
    }
    if (storedVersion !== SESSION_FACTS_VERSION) {
      throw new Error(`Unsupported session facts version: ${storedVersion}`);
    }

    this.lastSessionFactSpanId = Number(meta[0] ?? 0);
    this.lastSessionFactLogId = Number(meta[1] ?? 0);
    this.harvestSessionFacts();
    this.pruneSessionFacts();
  }

  private startSessionFactsFresh(): void {
    const maxSpanId = this.scalar('SELECT COALESCE(MAX(id), 0) FROM raw_spans');
    const maxLogId = this.scalar('SELECT COALESCE(MAX(id), 0) FROM raw_logs');
    this.sqlDb.run('BEGIN');
    try {
      for (const table of SESSION_FACTS_TRACE_TABLES) {
        this.sqlDb.run(`DELETE FROM ${table}`);
      }
      this.sqlDb.run('DELETE FROM session_facts_meta');
      this.sqlDb.run(
        `INSERT INTO session_facts_meta (id, last_span_row_id, last_log_row_id, facts_v)
         VALUES (1, :span, :log, ${SESSION_FACTS_VERSION})`,
        { ':span': maxSpanId, ':log': maxLogId },
      );
      this.sqlDb.run('COMMIT');
    } catch (err) {
      this.sqlDb.run('ROLLBACK');
      throw err;
    }
    this.lastSessionFactSpanId = maxSpanId;
    this.lastSessionFactLogId = maxLogId;
  }

  /** Atomically project new rows and advance their durable checkpoints. */
  private harvestSessionFacts(): void {
    const maxSpanId = this.scalar('SELECT COALESCE(MAX(id), 0) FROM raw_spans');
    const maxLogId = this.scalar('SELECT COALESCE(MAX(id), 0) FROM raw_logs');
    const spansPending = maxSpanId > this.lastSessionFactSpanId;
    const logsPending = maxLogId > this.lastSessionFactLogId;
    if (!spansPending && !logsPending) { return; }

    this.sqlDb.run('BEGIN');
    try {
      if (spansPending) {
        for (const stmt of SESSION_FACTS_SPAN_HARVEST_SQL) {
          this.sqlDb.run(stmt, { ':since': this.lastSessionFactSpanId });
        }
      }
      if (logsPending) {
        this.sqlDb.run(SESSION_FACTS_LOG_HARVEST_SQL, { ':since': this.lastSessionFactLogId });
      }
      this.sqlDb.run(
        `INSERT INTO session_facts_meta (id, last_span_row_id, last_log_row_id, facts_v)
         VALUES (1, :span, :log, ${SESSION_FACTS_VERSION})
         ON CONFLICT(id) DO UPDATE SET
           last_span_row_id = excluded.last_span_row_id,
           last_log_row_id  = excluded.last_log_row_id,
           facts_v          = excluded.facts_v`,
        { ':span': maxSpanId, ':log': maxLogId },
      );
      this.sqlDb.run('COMMIT');
    } catch (err) {
      this.sqlDb.run('ROLLBACK');
      throw err;
    }
    this.lastSessionFactSpanId = maxSpanId;
    this.lastSessionFactLogId = maxLogId;
  }

  /** Retain summaries longer than raw data and remove sessions whole. */
  private pruneSessionFacts(): void {
    const now = new Date();
    const day = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    if (day === this.lastSessionFactPruneDay) { return; }
    this.lastSessionFactPruneDay = day;

    this.sqlDb.run('BEGIN');
    try {
      this.sqlDb.run('DROP TABLE IF EXISTS session_facts_expired');
      this.sqlDb.run(
        `CREATE TEMP TABLE session_facts_expired AS ${EXPIRED_SUMMARY_TRACES_SQL}`,
        {
          ':now': `${Date.now()}000000`,
          ':window': `${SESSION_SUMMARY_RETENTION_MS}000000`,
          ':transientWindow': `${UTILITY_SUMMARY_RETENTION_MS}000000`,
          ':maxSessions': MAX_SESSION_SUMMARIES,
        },
      );
      for (const table of SESSION_FACTS_TRACE_TABLES) {
        this.sqlDb.run(
          `DELETE FROM ${table}
            WHERE trace_id IN (SELECT trace_id FROM session_facts_expired)`,
        );
      }
      this.sqlDb.run('DROP TABLE session_facts_expired');
      this.sqlDb.run('COMMIT');
    } catch (err) {
      this.sqlDb.run('ROLLBACK');
      throw err;
    }
  }

  private initializeTokenFacts(): void {
    const meta = this.sqlDb.exec(
      'SELECT last_span_row_id, facts_v FROM token_facts_meta WHERE id = 1',
    )[0]?.values[0];
    const storedVersion = Number(meta?.[1] ?? 0);
    if (storedVersion !== TOKEN_FACTS_VERSION) {
      // Never mix facts produced by incompatible projections.
      this.sqlDb.run('DELETE FROM token_facts');
    }
    this.lastTokenFactScanId = storedVersion === TOKEN_FACTS_VERSION
      ? Number(meta?.[0] ?? 0)
      : 0;
    this.tokenFactsReady = true;
    this.harvestTokenFacts({ replaceVersion: storedVersion !== TOKEN_FACTS_VERSION });
    this.pruneTokenFacts();
  }

  /** Project token usage before pruning its source spans. */
  private harvestTokenFacts(opts: { replaceVersion?: boolean } = {}): void {
    const maxId = this.scalar('SELECT COALESCE(MAX(id), 0) FROM raw_spans');
    if (maxId <= this.lastTokenFactScanId && !opts.replaceVersion) { return; }

    this.sqlDb.run(HARVEST_TOKEN_FACTS_SQL, { ':since': this.lastTokenFactScanId });
    const factsChanged = this.sqlDb.getRowsModified() > 0;

    this.lastTokenFactScanId = Math.max(this.lastTokenFactScanId, maxId);
    this.sqlDb.run(
      `INSERT INTO token_facts_meta (id, last_span_row_id, facts_v)
       VALUES (1, :last, ${TOKEN_FACTS_VERSION})
       ON CONFLICT(id) DO UPDATE SET
         last_span_row_id = excluded.last_span_row_id,
         facts_v = excluded.facts_v`,
      { ':last': this.lastTokenFactScanId },
    );
    if (factsChanged || opts.replaceVersion) {
      this.tokenFactsVersion++;
      if (opts.replaceVersion) { this.dataVersion++; }
    }
  }

  private pruneTokenFacts(): void {
    const now = new Date();
    const day = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    if (day === this.lastTokenFactPruneDay) { return; }
    this.lastTokenFactPruneDay = day;

    const cutoffMs = Date.now() - TOKEN_FACT_RETENTION_MS;
    this.sqlDb.run(
      'DELETE FROM token_facts WHERE timestamp_unix_nano < :cutoff',
      { ':cutoff': `${cutoffMs}000000` },
    );
    if (this.sqlDb.getRowsModified() > 0) {
      this.tokenFactsVersion++;
      this.dataVersion++;
    }
  }

  insertMetrics(rows: MetricRow[]): void {
    if (!rows.length) { return; }
    this.adapter.runInTransaction(rows, (db, rs) => {
      const s = db.prepare(TelemetryStore.insertSql('raw_metrics'));
      for (const r of rs) { s.run({ ':raw': r.raw }); }
      s.free();
    });
    this.recordBytes('raw_metrics', rows);
    this.pruneTable('raw_metrics');
    this.dataVersion++;
  }

  insertLogs(rows: LogRow[]): void {
    if (!rows.length) { return; }
    this.adapter.runInTransaction(rows, (db, rs) => {
      const s = db.prepare(TelemetryStore.insertSql('raw_logs'));
      for (const r of rs) { s.run({ ':raw': r.raw }); }
      s.free();
    });
    this.recordBytes('raw_logs', rows);
    this.harvestCodexSessions();
    this.harvestSessionFacts();
    this.pruneSessionFacts();
    this.pruneTable('raw_logs');
    this.dataVersion++;
  }

  private recordBytes(table: RawTable, rows: { raw: string }[]): void {
    let added = 0;
    for (const r of rows) { added += r.raw.length; }
    this.bytesSinceCheck[table] += added;
  }

  /** Apply row and byte caps while preserving each service's recent floor. */
  private pruneTable(table: RawTable, opts: { force?: boolean; compact?: boolean } = {}): boolean {
    const { maxRows, maxBytes, perServiceFloor, perServiceByteFloor, byteCheckDelta } = this.retention[table];
    const compact = opts.compact ?? true;
    let deleted = 0;
    // Keep referenced ancestors until later leaf-first passes.
    const referencedParentProtection = table === 'raw_spans'
      ? `AND id NOT IN (
           SELECT parent.id
           FROM raw_spans parent
           JOIN raw_spans child
             ON child.trace_id = parent.trace_id
            AND child.parent_span_id = parent.span_id
         )`
      : '';

    if (this.scalar(`SELECT COUNT(*) FROM ${table}`) > maxRows) {
      this.sqlDb.run(
        `DELETE FROM ${table}
         WHERE id NOT IN (SELECT id FROM ${table} ORDER BY id DESC LIMIT ${maxRows})
           AND id NOT IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(service_name, '') ORDER BY id DESC
               ) AS rn
               FROM ${table}
             ) WHERE rn <= ${perServiceFloor}
           )
           ${referencedParentProtection}`,
      );
      deleted += this.sqlDb.getRowsModified();
    }

    if (!opts.force && this.bytesSinceCheck[table] < byteCheckDelta) { return deleted > 0; }
    this.bytesSinceCheck[table] = 0;

    if (this.scalar(`SELECT COALESCE(SUM(${SIZE_EXPR}), 0) FROM ${table}`) <= maxBytes) { return deleted > 0; }

    // Drop oldest rows beyond the byte cap, except each service's floor.
    this.sqlDb.run(
      `DELETE FROM ${table}
       WHERE id IN (
         SELECT id FROM (
           SELECT id,
                  SUM(${SIZE_EXPR}) OVER (
                    ORDER BY id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                  ) AS running_bytes,
                  ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(service_name, '') ORDER BY id DESC
                  ) AS rn
           FROM ${table}
         )
         WHERE running_bytes > ${maxBytes} AND rn > ${perServiceByteFloor}
       )
       ${referencedParentProtection}`,
    );
    deleted += this.sqlDb.getRowsModified();

    if (compact) { this.vacuumIfBloated(); }
    return deleted > 0;
  }

  /** Compact when free pages justify the cost, or when forced. */
  private vacuumIfBloated(opts: { force?: boolean } = {}): void {
    if (!opts.force) {
      const pages = this.scalar('PRAGMA page_count');
      if (pages <= 0) { return; }
      if (this.scalar('PRAGMA freelist_count') / pages < VACUUM_FREE_RATIO) { return; }
    }
    this.sqlDb.run('VACUUM');
  }

  private scalar(sql: string): number {
    const res = this.sqlDb.exec(sql)[0];
    return Number(res?.values?.[0]?.[0] ?? 0);
  }

  clear(): void {
    for (const tbl of Object.keys(this.retention) as RawTable[]) {
      this.sqlDb.run(`DELETE FROM ${tbl}`);
      this.bytesSinceCheck[tbl] = 0;
    }
    this.sqlDb.run('DELETE FROM session_titles');
    this.sqlDb.run('DELETE FROM codex_trace_sessions');
    this.sqlDb.run('DELETE FROM token_facts');
    this.sqlDb.run('DELETE FROM token_facts_meta');
    for (const table of SESSION_FACTS_TRACE_TABLES) {
      this.sqlDb.run(`DELETE FROM ${table}`);
    }
    this.sqlDb.run('DELETE FROM session_facts_meta');
    this.lastTitleScanId = 0;
    this.lastCodexLogScanId = 0;
    this.lastTokenFactScanId = 0;
    this.lastTokenFactPruneDay = '';
    this.lastSessionFactSpanId = 0;
    this.lastSessionFactLogId = 0;
    this.lastSessionFactPruneDay = '';
    this.tokenFactsVersion++;
    this.vacuumIfBloated({ force: true });
    this.dataVersion++;
    this.flush();
  }

  /** Synchronously persist the database for shutdown and clear(). */
  flush(): void {
    if (!this.writable) { return; }
    if (this.dataVersion === this.flushedVersion) { return; }
    const version = this.dataVersion;
    const data = this.sqlDb.export();
    try {
      // Atomic replacement preserves the previous file if writing is interrupted.
      fs.writeFileSync(SYNC_TMP(this.dbPath), data);
      fs.renameSync(SYNC_TMP(this.dbPath), this.dbPath);
      this.flushedVersion = version;
    } catch (err) {
      try { fs.unlinkSync(SYNC_TMP(this.dbPath)); } catch { /* nothing to clean */ }
      throw err;
    }
  }

  /** Persist asynchronously, coalescing overlapping requests. */
  async flushAsync(): Promise<void> {
    if (!this.writable) { return; }
    if (this.flushInFlight) { this.flushQueued = true; return; }

    this.flushInFlight = true;
    try {
      do {
        this.flushQueued = false;
        if (this.closing) { return; }
        if (this.dataVersion === this.flushedVersion) { return; }

        const version = this.dataVersion;
        const data = this.sqlDb.export();
        try {
          await fsp.writeFile(ASYNC_TMP(this.dbPath), data);
          // Do not replace a newer synchronous shutdown save.
          if (this.closing) {
            await fsp.unlink(ASYNC_TMP(this.dbPath)).catch(() => undefined);
            return;
          }
          await fsp.rename(ASYNC_TMP(this.dbPath), this.dbPath);
          this.flushedVersion = version;
        } catch {
          // Leave the version stale so the next tick retries.
          await fsp.unlink(ASYNC_TMP(this.dbPath)).catch(() => undefined);
          return;
        }
      } while (this.flushQueued);
    } finally {
      this.flushInFlight = false;
      for (const waiter of this.flushIdleWaiters) { waiter(); }
      this.flushIdleWaiters.clear();
    }
  }

  close(): void {
    if (this.saveTimer) { clearInterval(this.saveTimer); }
    this.closing = true;
    try { this.flush(); } catch { /* nothing further we can do while closing */ }
    this.sqlDb.close();
  }
}
