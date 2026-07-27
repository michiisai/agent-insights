import * as fs from 'fs';
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

// Guaranteed rows retained *per service_name*, protected from the global cap above.
// This stops a high-volume source (e.g. Copilot) from evicting a low-volume one
// (e.g. Claude Code) just because the quiet source's rows are older — which would
// otherwise bias agent-comparison views against whichever agent was used less.
const PER_SERVICE_FLOOR = 5_000;

export class TelemetryStore {
  private sqlDb!: SqlJs.Database;
  private adapter!: DatabaseAdapter;
  private saveTimer?: ReturnType<typeof setInterval>;
  private writable = false;
  // Monotonic counter bumped whenever stored data changes. 
  private dataVersion = 0;

  constructor(private readonly dbPath: string) {}

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
  }

  /** Persistence is opt-in and belongs solely to the window that owns the OTLP
   *  port. sql.js has no file locking and flush() rewrites the file whole, so a
   *  second window writing would revert the database to its own startup
   *  snapshot and destroy whatever the owning window had received since.
   *  Idempotent: restarting the receiver must not stack up save timers. */
  enablePersistence(): void {
    if (this.writable) { return; }
    this.writable = true;
    // Persist to disk every 30 s to survive crashes.
    this.saveTimer = setInterval(() => this.flush(), 30_000);
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
    this.pruneTable('raw_spans', MAX_SPANS);
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
    this.pruneTable('raw_metrics', MAX_METRICS);
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
    this.pruneTable('raw_logs', MAX_LOGS);
    this.dataVersion++;
  }

  /**
   * Bounds `table`'s size after an insert using two rules:
   *
   *   1. **Global recency cap** — keep the newest `maxRows` rows overall (by
   *      autoincrement `id`, i.e. insertion order).
   *   2. **Per-service floor** — additionally keep the newest `PER_SERVICE_FLOOR`
   *      rows of *each* `service_name`, even if they fall outside the global cap.
   *
   * A row survives if it satisfies *either* rule. The floor guarantees a
   * low-volume source (e.g. Claude Code) retains its most recent data instead of
   * being evicted purely for being older than a noisier source's stream — which
   * would otherwise starve agent-comparison views of the quieter agent's metrics.
   * Total growth stays bounded at roughly `maxRows + PER_SERVICE_FLOOR * <#services>`.
   */
  private pruneTable(table: 'raw_spans' | 'raw_metrics' | 'raw_logs', maxRows: number): void {
    const countRow = this.sqlDb.exec(`SELECT COUNT(*) AS c FROM ${table}`)[0];
    const count = Number(countRow?.values?.[0]?.[0] ?? 0);
    if (count <= maxRows) { return; }
    this.sqlDb.run(
      `DELETE FROM ${table}
       WHERE id NOT IN (SELECT id FROM ${table} ORDER BY id DESC LIMIT ${maxRows})
         AND id NOT IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (
               PARTITION BY COALESCE(service_name, '') ORDER BY id DESC
             ) AS rn
             FROM ${table}
           ) WHERE rn <= ${PER_SERVICE_FLOOR}
         )`,
    );
  }

  clear(): void {
    for (const tbl of ['raw_spans', 'raw_metrics', 'raw_logs']) {
      this.sqlDb.run(`DELETE FROM ${tbl}`);
    }
    this.dataVersion++;
    this.flush();
  }

  flush(): void {
    // The guard lives here rather than only at the call sites so no future
    // caller can reintroduce a cross-window overwrite.
    if (!this.writable) { return; }
    const data = this.sqlDb.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  close(): void {
    if (this.saveTimer) { clearInterval(this.saveTimer); }
    this.flush();
    this.sqlDb.close();
  }
}
