import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type SqlJs from 'sql.js';
import type { QueryableDB } from '@agent-insights/types';

// Rebuilds the flat, dotted-key attributes object the engine expects
// (e.g. {"gen_ai.request.model":"gpt-4o"}) from an OTLP attribute array
// [{key, value:{stringValue|intValue|...}}] at `arrPath` inside `rawExpr`.
// Array values (e.g. gen_ai.response.finish_reasons -> ["end_turn"]) are
// preserved as a nested JSON array of their scalar elements; kvlist/bytes
// values collapse to null (no engine query relies on them).
//
// PERF: this is expensive (a correlated json_each aggregation per row). It is
// evaluated exactly ONCE per row — at insert time (and once during backfill) —
// and the result is stored in the raw table's `attributes` column, so read
// queries never recompute it. `rawExpr` is the SQL expression holding the raw
// JSON (e.g. a bound `:raw` parameter on insert, or `raw_spans.raw` on backfill).
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

// Extracts service.name from the resource attributes inside `rawExpr`.
// Materialized alongside `attributes` (see above) — computed once per row.
const serviceName = (rawExpr: string): string => `
    (SELECT COALESCE(json_extract(r.value, '$.value.stringValue'), '')
     FROM json_each(COALESCE(json_extract(${rawExpr}, '$.resource.attributes'), '[]')) r
     WHERE json_extract(r.value, '$.key') = 'service.name'
     LIMIT 1)`;

// The OTLP attribute-array path within each entity's raw JSON.
const ATTR_PATH = {
  raw_spans:   '$.span.attributes',
  raw_metrics: '$.dataPoint.attributes',
  raw_logs:    '$.logRecord.attributes',
} as const;

// Raw tables are the single source of truth: each row stores one full,
// self-contained OTLP entity ({ resource, scope, <entity> }) as JSON in `raw`.
// Two derived columns — `attributes` (flattened, dotted-key JSON) and
// `service_name` — are materialized at insert time so read queries never pay
// the flatAttrs recomputation cost. Everything else is derived cheaply by the
// VIEWS below. Expression indexes back the hot filters.
const SCHEMA_TABLES = `
CREATE TABLE IF NOT EXISTS raw_spans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  raw          TEXT    NOT NULL,
  attributes   TEXT,
  service_name TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_spans_spanid ON raw_spans(json_extract(raw, '$.span.spanId'));
CREATE INDEX IF NOT EXISTS idx_raw_spans_trace ON raw_spans(json_extract(raw, '$.span.traceId'));
CREATE INDEX IF NOT EXISTS idx_raw_spans_start ON raw_spans(json_extract(raw, '$.span.startTimeUnixNano'));

CREATE TABLE IF NOT EXISTS raw_metrics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  raw          TEXT    NOT NULL,
  attributes   TEXT,
  service_name TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_raw_metrics_name ON raw_metrics(json_extract(raw, '$.metric.name'));
CREATE INDEX IF NOT EXISTS idx_raw_metrics_ts   ON raw_metrics(json_extract(raw, '$.dataPoint.timeUnixNano'));

CREATE TABLE IF NOT EXISTS raw_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  raw          TEXT    NOT NULL,
  attributes   TEXT,
  service_name TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_raw_logs_severity ON raw_logs(json_extract(raw, '$.logRecord.severityNumber'));
CREATE INDEX IF NOT EXISTS idx_raw_logs_ts       ON raw_logs(json_extract(raw, '$.logRecord.timeUnixNano'));
`;

// Views are derived (no stored data), so drop-and-recreate on every init to
// pick up definition changes on existing databases without touching raw_*.
// The expensive `attributes` / `service_name` columns are read straight from
// the materialized raw-table columns (e.attributes / e.service_name).
const SCHEMA_VIEWS = `
DROP VIEW IF EXISTS spans;
DROP VIEW IF EXISTS metric_points;
DROP VIEW IF EXISTS logs;

CREATE VIEW IF NOT EXISTS spans AS
  SELECT
    e.id AS id,
    json_extract(e.raw, '$.span.traceId')      AS trace_id,
    json_extract(e.raw, '$.span.spanId')       AS span_id,
    json_extract(e.raw, '$.span.parentSpanId') AS parent_span_id,
    json_extract(e.raw, '$.span.name')         AS name,
    COALESCE(json_extract(e.raw, '$.span.kind'), 0) AS kind,
    json_extract(e.raw, '$.span.startTimeUnixNano') AS start_time_unix_nano,
    json_extract(e.raw, '$.span.endTimeUnixNano')   AS end_time_unix_nano,
    (CAST(COALESCE(json_extract(e.raw, '$.span.endTimeUnixNano'),   '0') AS INTEGER)
     - CAST(COALESCE(json_extract(e.raw, '$.span.startTimeUnixNano'), '0') AS INTEGER)) / 1000000.0 AS duration_ms,
    COALESCE(json_extract(e.raw, '$.span.status.code'), 0) AS status_code,
    json_extract(e.raw, '$.span.status.message') AS status_message,
    e.attributes   AS attributes,
    e.service_name AS service_name,
    e.raw AS raw
  FROM raw_spans e;

CREATE VIEW IF NOT EXISTS metric_points AS
  SELECT
    e.id AS id,
    json_extract(e.raw, '$.metric.name') AS name,
    json_extract(e.raw, '$.metricType')  AS metric_type,
    COALESCE(
      json_extract(e.raw, '$.dataPoint.asDouble'),
      CAST(json_extract(e.raw, '$.dataPoint.asInt') AS REAL),
      json_extract(e.raw, '$.dataPoint.sum')
    ) AS value,
    -- Histogram-specific fields (NULL for gauges/sums).
    CAST(json_extract(e.raw, '$.dataPoint.count') AS REAL) AS data_count,
    CAST(json_extract(e.raw, '$.dataPoint.sum')   AS REAL) AS data_sum,
    CAST(json_extract(e.raw, '$.dataPoint.min')   AS REAL) AS data_min,
    CAST(json_extract(e.raw, '$.dataPoint.max')   AS REAL) AS data_max,
    COALESCE(json_extract(e.raw, '$.aggregation.aggregationTemporality'), 0) AS temporality,
    COALESCE(json_extract(e.raw, '$.dataPoint.timeUnixNano'), '0') AS timestamp_unix_nano,
    -- Start of the accumulation window this point belongs to. For cumulative
    -- series it stays fixed while the counter runs and changes when the counter
    -- RESETS (process restart), so (attributes, start_time_unix_nano) — not
    -- attributes alone — identifies a single unbroken run of a series.
    COALESCE(json_extract(e.raw, '$.dataPoint.startTimeUnixNano'), '0') AS start_time_unix_nano,
    e.attributes   AS attributes,
    json_extract(e.raw, '$.metric.unit') AS unit,
    e.service_name AS service_name,
    e.raw AS raw
  FROM raw_metrics e;

CREATE VIEW IF NOT EXISTS logs AS
  SELECT
    e.id AS id,
    COALESCE(json_extract(e.raw, '$.logRecord.timeUnixNano'),
             json_extract(e.raw, '$.logRecord.observedTimeUnixNano'), '0') AS timestamp_unix_nano,
    COALESCE(json_extract(e.raw, '$.logRecord.severityNumber'), 0) AS severity_number,
    COALESCE(json_extract(e.raw, '$.logRecord.severityText'), '')  AS severity_text,
    COALESCE(json_extract(e.raw, '$.logRecord.body.stringValue'),
             json_extract(e.raw, '$.logRecord.body'), '') AS body,
    e.attributes   AS attributes,
    json_extract(e.raw, '$.logRecord.traceId') AS trace_id,
    json_extract(e.raw, '$.logRecord.spanId')  AS span_id,
    e.service_name AS service_name,
    e.raw AS raw
  FROM raw_logs e;
`;

// ── Row types ────────────────────────────────────────────────────────────────
// A stored row is just the full OTLP entity as a JSON string; the queryable
// columns are derived by the views above.

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

// Maximum rows retained per table. Oldest rows (by insertion order / autoincrement id)
// are pruned after each insert so the database never grows unbounded.
const MAX_SPANS   = 50_000;
const MAX_METRICS = 50_000;
const MAX_LOGS    = 50_000;

// Maximum BYTES of raw payload retained per table.
//
// The row caps above bound the row *count*, which is not the same as bounding
// size: a single span carrying captured model content routinely runs to tens of
// kilobytes, so a store can sit at a fraction of the row cap and still be
// hundreds of megabytes. That matters because sql.js has no incremental
// persistence — flush() serializes the WHOLE database and rewrites the file, so
// every megabyte retained is paid again on every flush. These budgets are what
// actually bound that cost.
const MAX_SPAN_BYTES   = 96 * 1024 * 1024;
const MAX_METRIC_BYTES = 32 * 1024 * 1024;
const MAX_LOG_BYTES    = 32 * 1024 * 1024;

// Measuring a table's byte size means summing LENGTH(raw) across every row,
// which reads each payload's overflow pages — far too expensive to run on every
// insert. Instead each insert adds its own payload size to a counter, and the
// real measurement runs only once that counter shows this much data has arrived
// since the last one. Overshoot is bounded by this value rather than by ingest
// rate, and the scan cost is amortized to once per N megabytes ingested.
const BYTE_CHECK_DELTA = 8 * 1024 * 1024;

// Guaranteed rows retained *per service_name*, protected from the row caps above.
// This stops a high-volume source (e.g. Copilot) from evicting a low-volume one
// (e.g. Claude Code) just because the quiet source's rows are older — which would
// otherwise bias agent-comparison views against whichever agent was used less.
const PER_SERVICE_FLOOR = 5_000;

// The same guarantee, but for the byte budget — and deliberately far smaller.
//
// The row floor above can be generous because rows are cheap to promise. Bytes
// are not: applying a 5,000-row floor to the byte budget would exempt the entire
// table from it in the common case of one or two services, since neither would
// ever reach 5,000 rows. The budget would then never bind and the store would
// grow without limit — the exact failure this budget exists to prevent.
//
// So the byte prune keeps only a small recent slice per service. That preserves
// the anti-bias property (every service keeps *some* recent history, so
// comparison views are never empty for one agent) while leaving the budget free
// to actually bind. Worst-case overshoot is this many rows per service.
const PER_SERVICE_BYTE_FLOOR = 50;

// Deleting rows leaves free pages behind, and sql.js's export() serializes the
// whole file — free pages included. So pruning alone reclaims nothing from the
// flush cost; only VACUUM does. VACUUM rebuilds the database (expensive, and
// transiently needs roughly double the memory), so it runs only once the free
// space is a large enough share of the file to be worth reclaiming.
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

// Scratch files a save writes before renaming over the real database. The
// synchronous and asynchronous paths use distinct names so the final save at
// shutdown can never collide with a periodic save still in flight.
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

    // 1) Raw tables + indexes.
    for (const stmt of SCHEMA_TABLES.split(';').map(s => s.trim()).filter(Boolean)) {
      this.sqlDb.run(stmt);
    }
    // 2) Migrate existing databases: add the materialized derived columns if
    //    they're missing, then backfill any rows that predate them.
    this.ensureDerivedColumns();
    this.backfillDerivedColumns();
    // 3) Views (read the materialized columns; safe now that they exist).
    for (const stmt of SCHEMA_VIEWS.split(';').map(s => s.trim()).filter(Boolean)) {
      this.sqlDb.run(stmt);
    }

    this.adapter = new DatabaseAdapter(this.sqlDb);

    // 4) Apply retention to whatever was loaded. Databases written before the
    //    byte budgets existed can be far over them — this is what brings such a
    //    store back down to a size that is cheap to flush, and it reclaims the
    //    freed pages so the very first flush already writes the smaller file.
    this.reclaim();
  }

  /** Enforce every table's retention rules and compact the file if that freed
   *  anything. Run at startup and after a clear.
   *
   *  Compaction is deferred until every table has been pruned, then forced:
   *  this runs once per session, and a file that needed rescuing must come out
   *  of it actually smaller rather than carrying freed pages into every
   *  subsequent flush. */
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
   *  snapshot and destroy whatever the owning window had received since.
   *  Idempotent: restarting the receiver must not stack up save timers. */
  enablePersistence(): void {
    if (this.writable) { return; }
    this.writable = true;
    // Persist to disk every 30 s to survive crashes. The periodic save goes
    // through the async path so the serialize/write does not stall the
    // extension host — a synchronous save is reserved for shutdown, where
    // there is no later opportunity to finish the work.
    this.saveTimer = setInterval(() => { void this.flushAsync(); }, 30_000);
  }

  /** False in a window that did not bind the port — it can read and display
   *  everything, but must never write. */
  get isWritable(): boolean {
    return this.writable;
  }

  // Adds the materialized `attributes` / `service_name` columns to raw tables
  // that predate them (older extension versions). No-op once present.
  private ensureDerivedColumns(): void {
    for (const table of ['raw_spans', 'raw_metrics', 'raw_logs']) {
      const info = this.sqlDb.exec(`PRAGMA table_info(${table})`)[0];
      const cols = new Set((info?.values ?? []).map(v => String(v[1])));
      if (!cols.has('attributes'))   { this.sqlDb.run(`ALTER TABLE ${table} ADD COLUMN attributes TEXT`); }
      if (!cols.has('service_name')) { this.sqlDb.run(`ALTER TABLE ${table} ADD COLUMN service_name TEXT`); }
    }
  }

  // One-time backfill of the materialized columns for legacy rows (attributes
  // IS NULL). New rows populate these columns at insert time, so this matches
  // nothing on subsequent runs.
  private backfillDerivedColumns(): void {
    for (const [table, arrPath] of Object.entries(ATTR_PATH)) {
      this.sqlDb.run(
        `UPDATE ${table} SET
           attributes   = ${flatAttrs(`${table}.raw`, arrPath)},
           service_name = ${serviceName(`${table}.raw`)}
         WHERE attributes IS NULL`,
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

  insertSpans(rows: SpanRow[]): void {
    if (!rows.length) { return; }
    this.adapter.runInTransaction(rows, (db, rs) => {
      // INSERT OR IGNORE dedupes by span_id via the unique expression index.
      // `attributes` / `service_name` are materialized once, here, so read
      // queries never recompute the expensive flatAttrs aggregation.
      const s = db.prepare(
        `INSERT OR IGNORE INTO raw_spans (raw, attributes, service_name)
         VALUES (:raw, ${flatAttrs(':raw', ATTR_PATH.raw_spans)}, ${serviceName(':raw')})`,
      );
      for (const r of rs) { s.run({ ':raw': r.raw }); }
      s.free();
    });
    this.recordBytes('raw_spans', rows);
    this.pruneTable('raw_spans');
    this.dataVersion++;
  }

  insertMetrics(rows: MetricRow[]): void {
    if (!rows.length) { return; }
    this.adapter.runInTransaction(rows, (db, rs) => {
      const s = db.prepare(
        `INSERT INTO raw_metrics (raw, attributes, service_name)
         VALUES (:raw, ${flatAttrs(':raw', ATTR_PATH.raw_metrics)}, ${serviceName(':raw')})`,
      );
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
      const s = db.prepare(
        `INSERT INTO raw_logs (raw, attributes, service_name)
         VALUES (:raw, ${flatAttrs(':raw', ATTR_PATH.raw_logs)}, ${serviceName(':raw')})`,
      );
      for (const r of rs) { s.run({ ':raw': r.raw }); }
      s.free();
    });
    this.recordBytes('raw_logs', rows);
    this.pruneTable('raw_logs');
    this.dataVersion++;
  }

  /** Accumulate the payload bytes an insert just added, so pruneTable knows when
   *  a real byte measurement is worth its cost. Counted from the source strings
   *  rather than from SQL: it is free here, and only ever used as a trigger. */
  private recordBytes(table: RawTable, rows: { raw: string }[]): void {
    let added = 0;
    for (const r of rows) { added += r.raw.length; }
    this.bytesSinceCheck[table] += added;
  }

  /**
   * Bounds `table`'s size after an insert using three rules:
   *
   *   1. **Global recency cap** — keep the newest `maxRows` rows overall (by
   *      autoincrement `id`, i.e. insertion order).
   *   2. **Byte budget** — keep the newest rows whose payloads fit in
   *      `maxBytes`, discarding older ones beyond that.
   *   3. **Per-service floor** — additionally keep the newest `perServiceFloor`
   *      rows of *each* `service_name`, even if they fall outside 1 or 2.
   *
   * A row survives if it satisfies the floor or the cap it is being tested
   * against. The floor guarantees a low-volume source (e.g. Claude Code) retains
   * its most recent data instead of being evicted purely for being older than a
   * noisier source's stream — which would otherwise starve agent-comparison
   * views of the quieter agent's metrics.
   *
   * Rule 1 is checked on every insert (COUNT(*) is cheap). Rule 2 needs
   * SUM(LENGTH(raw)), which reads every payload, so it is checked only once
   * BYTE_CHECK_DELTA of new data has arrived — or immediately when `force` is
   * set, as at startup where the loaded file may already be far over budget.
   *
   * Returns whether any rows were deleted, so callers can decide whether
   * compaction is worth attempting.
   */
  private pruneTable(table: RawTable, opts: { force?: boolean; compact?: boolean } = {}): boolean {
    const { maxRows, maxBytes, perServiceFloor, perServiceByteFloor, byteCheckDelta } = this.retention[table];
    const compact = opts.compact ?? true;
    let deleted = 0;

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
           )`,
      );
      deleted += this.sqlDb.getRowsModified();
    }

    if (!opts.force && this.bytesSinceCheck[table] < byteCheckDelta) { return deleted > 0; }
    this.bytesSinceCheck[table] = 0;

    if (this.scalar(`SELECT COALESCE(SUM(LENGTH(raw)), 0) FROM ${table}`) <= maxBytes) { return deleted > 0; }

    // Walk newest-to-oldest accumulating payload bytes; everything past the
    // point where that running total exceeds the budget is dropped, unless it
    // falls within its service's small recent slice (perServiceByteFloor).
    this.sqlDb.run(
      `DELETE FROM ${table}
       WHERE id IN (
         SELECT id FROM (
           SELECT id,
                  SUM(LENGTH(raw)) OVER (
                    ORDER BY id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                  ) AS running_bytes,
                  ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(service_name, '') ORDER BY id DESC
                  ) AS rn
           FROM ${table}
         )
         WHERE running_bytes > ${maxBytes} AND rn > ${perServiceByteFloor}
       )`,
    );
    deleted += this.sqlDb.getRowsModified();

    if (compact) { this.vacuumIfBloated(); }
    return deleted > 0;
  }

  /** Compact the file if deleted rows left enough free pages to be worth it.
   *  Without this, pruning reclaims nothing that flush() cares about: export()
   *  serializes free pages too, so the write stays as expensive as before.
   *
   *  `force` skips the ratio test. Steady-state pruning tolerates some waste to
   *  keep VACUUM rare, but a one-off rescue of an over-budget file must actually
   *  shrink it — there, freed pages just below the ratio would otherwise be
   *  serialized on every future flush for the lifetime of the store. */
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
    // Every page is free now, so this actually shrinks the file — otherwise
    // "clear all data" would leave flushes as slow as they were before.
    this.vacuumIfBloated({ force: true });
    this.dataVersion++;
    this.flush();
  }

  /** Serialize and write the database, blocking until it is on disk.
   *  Reserved for shutdown and clear(); periodic saves use flushAsync(). */
  flush(): void {
    // The guard lives here rather than only at the call sites so no future
    // caller can reintroduce a cross-window overwrite.
    if (!this.writable) { return; }
    if (this.dataVersion === this.flushedVersion) { return; }
    const version = this.dataVersion;
    const data = this.sqlDb.export();
    try {
      // Write beside the database and rename over it: rename is atomic, so an
      // interrupted save leaves the previous good file rather than a truncated
      // one. Passing the Uint8Array straight through avoids copying the whole
      // database a second time, which at these sizes is not a rounding error.
      fs.writeFileSync(SYNC_TMP(this.dbPath), data);
      fs.renameSync(SYNC_TMP(this.dbPath), this.dbPath);
      this.flushedVersion = version;
    } catch (err) {
      try { fs.unlinkSync(SYNC_TMP(this.dbPath)); } catch { /* nothing to clean */ }
      throw err;
    }
  }

  /** Serialize the database and write it without blocking the extension host.
   *
   *  Only the write is moved off the critical path: sql.js's export() is
   *  synchronous and has no incremental equivalent, so it still costs main-thread
   *  time proportional to the database size. Keeping that size bounded (see the
   *  byte budgets above) is what keeps the remaining cost small.
   *
   *  Concurrent calls collapse: a request arriving mid-flush marks the result
   *  stale and the in-flight flush repeats once with the newer data. */
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
    // Shutdown is the one point with no later chance to finish the work, so the
    // final save is synchronous. It is also a no-op when nothing changed since
    // the last periodic flush.
    try { this.flush(); } catch { /* nothing further we can do while closing */ }
    this.sqlDb.close();
  }
}
