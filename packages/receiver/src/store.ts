import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type SqlJs from 'sql.js';
import type { QueryableDB } from '@agent-insights/types';

// Rebuilds the flat, dotted-key attributes object the engine expects
// (e.g. {"gen_ai.request.model":"gpt-4o"}) from the OTLP attribute array at
// `arrPath`. Array values are preserved; kvlist/bytes collapse to null.
// Expensive (a correlated aggregation per row), so it is only ever materialized.
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

// One string attribute by key, or NULL. Unlike flatAttrs this reads a single
// key, so it is cheap enough for a scalar column; both are only ever computed
// at insert/backfill time, never per read.
const attrValue = (rawExpr: string, arrPath: string, key: string): string => `
    (SELECT json_extract(a.value, '$.value.stringValue')
     FROM json_each(COALESCE(json_extract(${rawExpr}, '${arrPath}'), '[]')) a
     WHERE json_extract(a.value, '$.key') = '${key}'
     LIMIT 1)`;

// The OTLP attribute-array path within each entity's raw JSON.
const ATTR_PATH = {
  raw_spans:   '$.span.attributes',
  raw_metrics: '$.dataPoint.attributes',
  raw_logs:    '$.logRecord.attributes',
} as const;

// ── Derived columns ──────────────────────────────────────────────────────────
// Every queryable field is materialized into a real column. Deriving them in the
// views instead makes each one cost a JSON parse of the whole payload per read,
// so anything that scans or groups re-parses every row. Schema, inserts,
// migration and views are all generated from DERIVED, so they cannot drift.
interface DerivedColumn {
  name: string;
  type: 'TEXT' | 'INTEGER' | 'REAL';
  /** SQL computing the value from the raw JSON held in `rawExpr`. */
  expr: (rawExpr: string) => string;
  /** Payload-sized rather than scalar, so declared after every scalar column.
   *  SQLite stores columns in declaration order and reaching one past a multi-KB
   *  value means walking that value and its overflow pages first, which costs an
   *  order of magnitude on scans. */
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
    // Start of this point's accumulation window. It changes when a cumulative
    // counter RESETS, so (attributes, start_time_unix_nano) — not attributes
    // alone — identifies a single unbroken run of a series.
    jsonCol('start_time_unix_nano', 'TEXT',    '$.dataPoint.startTimeUnixNano', `'0'`),
    jsonCol('unit',                 'TEXT',    '$.metric.unit'),
    ...COMMON_DERIVED('raw_metrics'),
  ],
  raw_logs: [
    {
      name: 'timestamp_unix_nano', type: 'TEXT',
      // Codex sends `timeUnixNano: "0"` and puts the real clock in
      // `observedTimeUnixNano`. A plain COALESCE only falls through on NULL, so
      // the zero won and every Codex log landed at the epoch — sorted last,
      // rendered as 1970 and dropped by any time window. Treat an explicit zero
      // (string or int, depending on how the exporter encoded it) as absent.
      expr: (raw) => `COALESCE(NULLIF(NULLIF(json_extract(${raw}, '$.logRecord.timeUnixNano'), '0'), 0),
                               json_extract(${raw}, '$.logRecord.observedTimeUnixNano'), '0')`,
    },
    jsonCol('severity_number',      'INTEGER', '$.logRecord.severityNumber', '0'),
    jsonCol('severity_text',        'TEXT',    '$.logRecord.severityText', `''`),
    {
      name: 'body', type: 'TEXT',
      // Event-style emitters leave `body` unset and carry the message in the
      // semconv `event.name` attribute instead — every Codex record does, so the
      // Logs tab rendered a column of blanks. An empty string counts as unset
      // for the same reason. Fall back to `event.name`, qualified by
      // `event.kind` when present: without it every Codex SSE record reads
      // `codex.sse_event` and its kinds are indistinguishable.
      // `logRecord.eventName` is last because Codex sets it to a Rust source
      // location — better than nothing, worse than either attribute.
      // Claude and Copilot populate `body`, so none of this reaches them.
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

// Bump when a derived column is added or its expression changes; rows carry the
// version they were computed with, so a bump re-derives them on the next load.
// A version marker beats testing for NULL columns: parent_span_id is NULL on
// every root span, so a NULL test would re-backfill those rows forever.
const DERIVED_VERSION = 3;

const scalarCols = (table: RawTable): DerivedColumn[] => DERIVED[table].filter(c => !c.large);
const largeCols  = (table: RawTable): DerivedColumn[] => DERIVED[table].filter(c =>  c.large);

/** The canonical column order for a raw table: scalars first, payloads last.
 *  See DerivedColumn.large — this ordering is what makes scans cheap. */
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

// The source of truth: each row holds one full, self-contained OTLP entity
// ({ resource, scope, <entity> }) as JSON in `raw`, plus its derived columns.
const RAW_TABLES: RawTable[] = ['raw_spans', 'raw_metrics', 'raw_logs'];

// Plain column indexes, replacing the previous json_extract(...) expression
// ones: cheaper to maintain on insert and smaller on disk. Created only after
// initialize() has guaranteed the columns exist.
const SCHEMA_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_spans_spanid ON raw_spans(span_id);
CREATE INDEX IF NOT EXISTS idx_raw_spans_trace   ON raw_spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_raw_spans_start   ON raw_spans(start_time_unix_nano);
CREATE INDEX IF NOT EXISTS idx_raw_metrics_name  ON raw_metrics(name);
CREATE INDEX IF NOT EXISTS idx_raw_metrics_ts    ON raw_metrics(timestamp_unix_nano);
CREATE INDEX IF NOT EXISTS idx_raw_logs_severity ON raw_logs(severity_number);
CREATE INDEX IF NOT EXISTS idx_raw_logs_ts       ON raw_logs(timestamp_unix_nano);
-- Conversation content lives in logs for Claude and Codex, and every query that
-- reads it (session transcripts, titles, "did this chat ever get a prompt?")
-- selects by trace.
CREATE INDEX IF NOT EXISTS idx_raw_logs_trace    ON raw_logs(trace_id);
`;

// Pre-materialization expression indexes. They share names with SCHEMA_INDEXES,
// so they must be dropped explicitly or CREATE ... IF NOT EXISTS keeps them.
const LEGACY_INDEXES = [
  'idx_raw_spans_spanid', 'idx_raw_spans_trace', 'idx_raw_spans_start',
  'idx_raw_metrics_name', 'idx_raw_metrics_ts',
  'idx_raw_logs_severity', 'idx_raw_logs_ts',
];

// ── Session titles ───────────────────────────────────────────────────────────
// Title spans are projected into their own table as they arrive: one row per
// conversation, outside the raw tables and so never pruned. Title spans stay in
// raw_spans as ordinary telemetry.
export const SESSION_TITLE_SPAN_NAME = 'vscode.agent_host.session.title_changed';
const SESSION_TITLE_ATTR = 'vscode.agent_host.session.title';
const SESSION_ID_ATTR    = 'gen_ai.conversation.id';

/**
 * Session URI on the title span, e.g. `claude:/<conversation-id>`. Its scheme is
 * the agent host's own name for the plugin it launched — `claude`, `copilotcli`
 * or `codex` — which is authoritative in a way the OTel resource name is not:
 * each agent picks its own `service.name` (`claude-code`, `github-copilot`,
 * `codex-app-server`) and the host doesn't control it.
 */
export const SESSION_URI_ATTR = 'vscode.agent_host.session.uri';

const SESSION_TITLES_TABLE = `
CREATE TABLE IF NOT EXISTS session_titles (
  session_id   TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  updated_nano TEXT NOT NULL,
  agent        TEXT
)`;

/** The scheme of the session URI. NULL when the attribute is absent or has no
 *  colon — `instr` returns 0 there, making the substr length -1 and the result
 *  empty, which NULLIF collapses rather than storing as a bogus agent. */
const SESSION_AGENT_EXPR = `NULLIF(
  substr(
    json_extract(attributes, '$."${SESSION_URI_ATTR}"'),
    1,
    instr(COALESCE(json_extract(attributes, '$."${SESSION_URI_ATTR}"'), ''), ':') - 1
  ), '')`;

// Projects title spans with an id above :since. The upsert guard keeps the
// newest title per conversation whatever order rows are visited in.
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

// Views hold no data, so they are dropped and recreated on every init to pick up
// definition changes without touching raw_*. Every column is read straight off
// the raw table; only duration_ms is computed, and that is arithmetic over two
// stored columns rather than a JSON parse.
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

// ── Row types ────────────────────────────────────────────────────────────────

export interface SpanRow  { raw: string }
export interface MetricRow { raw: string }
export interface LogRow   { raw: string }

// ── DatabaseAdapter ───────────────────────────────────────────────────────────

/**
 * Wraps sql.js (WASM SQLite) with a synchronous API compatible with
 * the `QueryableDB` interface consumed by @agent-insights/engine.
 */
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

// ── TelemetryStore ────────────────────────────────────────────────────────────

// Maximum rows retained per table; oldest are pruned after each insert.
const MAX_SPANS   = 50_000;
const MAX_METRICS = 50_000;
const MAX_LOGS    = 50_000;

// Maximum payload BYTES retained per table. Row caps bound the row *count*,
// which is not the same as bounding size — one content-carrying span runs to
// tens of KB. sql.js has no incremental persistence, so flush() rewrites the
// whole file and every retained megabyte is paid again on every flush.
const MAX_SPAN_BYTES   = 96 * 1024 * 1024;
const MAX_METRIC_BYTES = 32 * 1024 * 1024;
const MAX_LOG_BYTES    = 32 * 1024 * 1024;

// Measuring a table's size reads every payload's overflow pages, far too
// expensive per insert. Each insert instead adds to a counter, and the real
// measurement runs once this much new data has arrived — bounding overshoot by
// a fixed size rather than by ingest rate.
const BYTE_CHECK_DELTA = 8 * 1024 * 1024;

// What a byte budget is measured against. `raw` alone understates the footprint
// by nearly half, since `attributes` holds a flattened copy of the same values.
const SIZE_EXPR = 'LENGTH(raw) + COALESCE(LENGTH(attributes), 0)';

// Guaranteed rows retained *per service_name*, exempt from the row caps. Stops a
// high-volume source (Copilot) evicting a low-volume one (Claude Code) purely
// for being older, which would bias agent-comparison views.
const PER_SERVICE_FLOOR = 5_000;

// The same guarantee for the byte budget, and deliberately far smaller: a
// 5,000-row floor would exempt the whole table whenever no service reaches it,
// so the budget would never bind. A small recent slice keeps the anti-bias
// property while leaving the budget free to actually evict.
const PER_SERVICE_BYTE_FLOOR = 50;

// Deleted rows leave free pages, and export() serializes those too — so pruning
// alone reclaims nothing from the flush cost; only VACUUM does. VACUUM rebuilds
// the database and transiently needs ~double the memory, so it waits until the
// free space is a large enough share of the file to be worth it.
const VACUUM_FREE_RATIO = 0.25;

export type RawTable = 'raw_spans' | 'raw_metrics' | 'raw_logs';

/** Retention rules for one raw table. See pruneTable() for how they combine. */
export interface RetentionLimits {
  maxRows: number;
  maxBytes: number;
  /** Rows per service exempt from the row cap. See PER_SERVICE_FLOOR. */
  perServiceFloor: number;
  /** Rows per service exempt from the byte budget. Much smaller than
   *  perServiceFloor, and necessarily so — see PER_SERVICE_BYTE_FLOOR. */
  perServiceByteFloor: number;
  /** How much newly inserted payload must accumulate before the byte budget is
   *  actually measured. See BYTE_CHECK_DELTA. */
  byteCheckDelta: number;
}

/** Per-table retention overrides, primarily so tests can exercise the caps
 *  without having to ingest the production budgets' worth of data. */
export type RetentionOverrides = Partial<Record<RawTable, Partial<RetentionLimits>>>;

// Scratch files a save writes before renaming over the real database. The sync
// and async paths use distinct names so the final save at shutdown can never
// collide with a periodic save still in flight.
const ASYNC_TMP = (dbPath: string): string => `${dbPath}.tmp`;
const SYNC_TMP  = (dbPath: string): string => `${dbPath}.sync.tmp`;

// Default retention rules per table, applied by pruneTable().
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
  // Monotonic counter bumped whenever stored data changes.
  private dataVersion = 0;
  // dataVersion as of the last successful write. Flushing when these match would
  // rewrite an identical file, so an idle window costs nothing.
  private flushedVersion = -1;
  // A flush is a full serialize + write; overlapping them would double the work
  // and race on the target file. Instead a request arriving mid-flush sets
  // flushQueued, and the in-flight flush loops once more to pick up the newer data.
  private flushInFlight = false;
  private flushQueued = false;
  // Set once close() starts, so a periodic flush that is mid-write abandons its
  // rename instead of overwriting the final save with older data.
  private closing = false;
  // Raw payload bytes inserted per table since that table was last measured.
  private bytesSinceCheck: Record<RawTable, number> = {
    raw_spans: 0, raw_metrics: 0, raw_logs: 0,
  };
  // Highest raw_spans id already scanned for session titles.
  private lastTitleScanId = 0;
  private readonly retention: Record<RawTable, RetentionLimits>;

  constructor(private readonly dbPath: string, overrides: RetentionOverrides = {}) {
    this.retention = {
      raw_spans:   { ...RETENTION.raw_spans,   ...overrides.raw_spans   },
      raw_metrics: { ...RETENTION.raw_metrics, ...overrides.raw_metrics },
      raw_logs:    { ...RETENTION.raw_logs,    ...overrides.raw_logs    },
    };
  }

  async initialize(): Promise<void> {
    // Dynamic require keeps sql.js external from the esbuild bundle.
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

    // Leftover scratch files mean a previous save was interrupted. The rename
    // never happened, so the real database is still the last good one — the
    // partial files are just garbage to clear out.
    for (const stale of [ASYNC_TMP(this.dbPath), SYNC_TMP(this.dbPath)]) {
      try {
        if (fs.existsSync(stale)) { fs.unlinkSync(stale); }
      } catch { /* best effort; a stale scratch file is harmless */ }
    }

    this.dropLegacyTables();

    for (const table of RAW_TABLES) { this.sqlDb.run(createTableSql(table)); }
    this.sqlDb.run(SESSION_TITLES_TABLE);
    this.ensureSessionTitleColumns();
    this.ensureSchema();
    // These share names with SCHEMA_INDEXES, so CREATE ... IF NOT EXISTS below
    // would otherwise silently keep the slower expression version.
    for (const name of LEGACY_INDEXES) { this.sqlDb.run(`DROP INDEX IF EXISTS ${name}`); }
    // Before the indexes exist, so each is built once from final values rather
    // than updated row by row during the backfill.
    this.backfillDerivedColumns();
    for (const stmt of SCHEMA_INDEXES.split(';').map(s => s.trim()).filter(Boolean)) {
      this.sqlDb.run(stmt);
    }
    for (const stmt of SCHEMA_VIEWS.split(';').map(s => s.trim()).filter(Boolean)) {
      this.sqlDb.run(stmt);
    }

    this.adapter = new DatabaseAdapter(this.sqlDb);

    // Full sweep, which also migrates a file written before session_titles
    // existed. Runs before retention, which cannot undo it.
    this.harvestSessionTitles({ from: 0 });

    // A file written before the byte budgets existed can be far over them; this
    // brings it back to a size that is cheap to flush.
    this.reclaim();
  }

  /** Enforce every table's retention rules and compact if that freed anything.
   *
   *  Compaction is deferred until every table is pruned, then forced: this runs
   *  once per session, and a rescued file must come out of it actually smaller
   *  rather than carrying freed pages into every subsequent flush. */
  private reclaim(): void {
    let pruned = false;
    for (const table of Object.keys(this.retention) as RawTable[]) {
      if (this.pruneTable(table, { force: true, compact: false })) { pruned = true; }
    }
    this.vacuumIfBloated({ force: pruned });
  }

  /** Persistence is opt-in and belongs solely to the window that owns the OTLP
   *  port. sql.js has no file locking and flush() rewrites the file whole, so a
   *  second window writing would revert the database to its own startup
   *  snapshot. Idempotent: restarting the receiver must not stack save timers. */
  enablePersistence(): void {
    if (this.writable) { return; }
    this.writable = true;
    // Via the async path so the serialize/write does not stall the extension
    // host; a synchronous save is reserved for shutdown.
    this.saveTimer = setInterval(() => { void this.flushAsync(); }, 30_000);
  }

  /** False in a window that did not bind the port — it can read and display
   *  everything, but must never write. */
  get isWritable(): boolean {
    return this.writable;
  }

  /** Add columns a `session_titles` written by an older build is missing.
   *
   *  Unlike the raw tables this one is tiny and holds no `raw` blob, so column
   *  order is irrelevant and a plain ADD COLUMN is enough. It must never be
   *  rebuilt from raw_spans: titles deliberately outlive the spans they came
   *  from, so dropping the table would lose every title whose span was pruned.
   *  Existing rows keep a NULL agent until their span is harvested again. */
  private ensureSessionTitleColumns(): void {
    const info = this.sqlDb.exec('PRAGMA table_info(session_titles)')[0];
    const cols = new Set((info?.values ?? []).map(v => String(v[1])));
    if (!cols.has('agent')) {
      this.sqlDb.run('ALTER TABLE session_titles ADD COLUMN agent TEXT');
    }
  }

  /** Bring an existing database to the canonical table layout.
   *
   *  ALTER TABLE ADD COLUMN appends, which would put the new scalars *after* the
   *  multi-KB `raw` — exactly the layout that makes scans slow (see
   *  DerivedColumn.large). Correct physical order requires a rebuild. */
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

      // Reuse the old value where the column existed rather than recomputing —
      // deriving `attributes` is by far the most expensive part of a rebuild.
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

  // Derives columns for rows written under an older DERIVED_VERSION. New rows
  // are populated and stamped at insert time, so this matches nothing on a store
  // already up to date — which is only true because it selects on the version
  // marker rather than on a NULL column (see DERIVED_VERSION).
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

  // Drops legacy layouts left by earlier extension versions.
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

  /** Current data version. Increments on every insert/clear that changes data. */
  getDataVersion(): number {
    return this.dataVersion;
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  /** Builds the INSERT for a raw table, computing every derived column from the
   *  bound `:raw` payload in the same statement. Generated from DERIVED so the
   *  insert can never disagree with the schema, the migration or the views. */
  private static insertSql(table: RawTable, orIgnore = false): string {    const cols = DERIVED[table];
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
      // OR IGNORE dedupes by span_id via its unique index.
      const s = db.prepare(TelemetryStore.insertSql('raw_spans', true));
      for (const r of rs) { s.run({ ':raw': r.raw }); }
      s.free();
    });
    this.recordBytes('raw_spans', rows);
    this.harvestSessionTitles();
    this.pruneTable('raw_spans');
    this.dataVersion++;
  }

  /** Copy new title spans into session_titles. Runs before pruning so a title
   *  is captured even if its span is evicted in the same insert. */
  private harvestSessionTitles(opts: { from?: number } = {}): void {
    const since = opts.from ?? this.lastTitleScanId;
    const maxId = this.scalar('SELECT COALESCE(MAX(id), 0) FROM raw_spans');
    if (maxId > since) {
      this.sqlDb.run(HARVEST_TITLES_SQL, { ':since': since });
    }
    this.lastTitleScanId = Math.max(this.lastTitleScanId, maxId);
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
    this.pruneTable('raw_logs');
    this.dataVersion++;
  }

  /** Accumulate the payload bytes an insert added, so pruneTable knows when a
   *  real measurement is worth its cost. Counted from the source strings because
   *  it is free here and only ever used as a trigger. */
  private recordBytes(table: RawTable, rows: { raw: string }[]): void {
    let added = 0;
    for (const r of rows) { added += r.raw.length; }
    this.bytesSinceCheck[table] += added;
  }

  /** Bounds `table`'s size with three rules: keep the newest `maxRows` rows,
   *  keep the newest rows fitting in `maxBytes`, and regardless keep each
   *  service's newest rows (the floors). The row cap is checked on every insert;
   *  the byte budget only once `byteCheckDelta` has arrived, or under `force`. */
  private pruneTable(table: RawTable, opts: { force?: boolean; compact?: boolean } = {}): boolean {
    const { maxRows, maxBytes, perServiceFloor, perServiceByteFloor, byteCheckDelta } = this.retention[table];
    const compact = opts.compact ?? true;
    let deleted = 0;
    // Never evict a span while a retained child still references it. Long-lived
    // agent/session roots often arrive before hundreds of descendants; pruning
    // strictly by row age used to leave those descendants as hanging subtrees.
    // Parents become eligible naturally after their last child is evicted. This
    // deliberately makes the limits soft by at most the referenced ancestry
    // retained at that instant; subsequent prune passes drain it leaf-first.
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

    // Walk newest-to-oldest accumulating bytes; everything past the point where
    // the running total exceeds the budget is dropped, unless it falls within
    // its service's small recent slice.
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

  /** Compact if deleted rows left enough free pages to be worth it; without this
   *  pruning reclaims nothing flush() cares about, since export() serializes
   *  free pages too. `force` skips the ratio test for the one-off startup
   *  rescue, which must actually shrink the file rather than tolerate waste. */
  private vacuumIfBloated(opts: { force?: boolean } = {}): void {
    if (!opts.force) {
      const pages = this.scalar('PRAGMA page_count');
      if (pages <= 0) { return; }
      if (this.scalar('PRAGMA freelist_count') / pages < VACUUM_FREE_RATIO) { return; }
    }
    this.sqlDb.run('VACUUM');
  }

  /** Run a query whose first column of its first row is a number. */
  private scalar(sql: string): number {
    const res = this.sqlDb.exec(sql)[0];
    return Number(res?.values?.[0]?.[0] ?? 0);
  }

  clear(): void {
    for (const tbl of Object.keys(this.retention) as RawTable[]) {
      this.sqlDb.run(`DELETE FROM ${tbl}`);
      this.bytesSinceCheck[tbl] = 0;
    }
    // Titles sit outside retention, so clearing is the only thing that removes
    // them.
    this.sqlDb.run('DELETE FROM session_titles');
    this.lastTitleScanId = 0;
    // Every page is free now, so this actually shrinks the file — otherwise
    // "clear all data" would leave flushes as slow as they were before.
    this.vacuumIfBloated({ force: true });    this.dataVersion++;
    this.flush();
  }

  /** Serialize and write the database, blocking until it is on disk.
   *  Reserved for shutdown and clear(); periodic saves use flushAsync(). */
  flush(): void {
    // Guarded here rather than only at call sites so no future caller can
    // reintroduce a cross-window overwrite.
    if (!this.writable) { return; }
    if (this.dataVersion === this.flushedVersion) { return; }
    const version = this.dataVersion;
    const data = this.sqlDb.export();
    try {
      // Rename is atomic, so an interrupted save leaves the previous good file
      // rather than a truncated one.
      fs.writeFileSync(SYNC_TMP(this.dbPath), data);
      fs.renameSync(SYNC_TMP(this.dbPath), this.dbPath);
      this.flushedVersion = version;
    } catch (err) {
      try { fs.unlinkSync(SYNC_TMP(this.dbPath)); } catch { /* nothing to clean */ }
      throw err;
    }
  }

  /** Serialize the database and write it without blocking the extension host.
   *  Only the write moves off the critical path — sql.js's export() is
   *  synchronous, so keeping the database small is what bounds the rest.
   *  Concurrent calls collapse: the in-flight flush repeats with newer data. */
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
          // close() may have run a final synchronous save while this write was
          // in flight; renaming now would put older data over newer.
          if (this.closing) {
            await fsp.unlink(ASYNC_TMP(this.dbPath)).catch(() => undefined);
            return;
          }
          await fsp.rename(ASYNC_TMP(this.dbPath), this.dbPath);
          this.flushedVersion = version;
        } catch {
          // Leave flushedVersion untouched so the next tick retries. The real
          // database is untouched either way — only the scratch file is suspect.
          await fsp.unlink(ASYNC_TMP(this.dbPath)).catch(() => undefined);
          return;
        }
      } while (this.flushQueued);
    } finally {
      this.flushInFlight = false;
    }
  }

  close(): void {
    if (this.saveTimer) { clearInterval(this.saveTimer); }
    // Stops any in-flight async flush from renaming over the final save below.
    this.closing = true;
    // Synchronous because shutdown has no later chance to finish the work.
    try { this.flush(); } catch { /* nothing further we can do while closing */ }
    this.sqlDb.close();
  }
}
