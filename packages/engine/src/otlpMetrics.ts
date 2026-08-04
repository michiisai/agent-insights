import type { QueryableDB, MetricInstrument, MetricDetail, MetricDimension, MetricSeriesPoint } from '@agent-insights/types';

// OTLP metrics are stored one data point per row in raw_metrics; the
// `metric_points` view (store.ts) exposes the queryable columns, including the
// materialized flat `attributes` object and histogram fields (count/sum/min/max).
//
// IMPORTANT — cumulative temporality: Copilot/GenAI/Claude Code metrics are
// cumulative (aggregationTemporality = 2), so each data point holds a RUNNING
// TOTAL for its series (a series = one unique attribute combination). To get
// correct lifetime totals we take the LATEST point per series and aggregate
// across series — never SUM every point (that would multiply-count the running
// totals).
//
// Counter RESETS: a cumulative counter restarts at zero whenever the emitting
// process restarts, and signals this with a new `startTimeUnixNano` while the
// attributes stay identical. Taking the latest point per attribute set alone
// would therefore discard every completed run and report only the newest one.
// A series run is keyed by (attributes, start_time_unix_nano) — the per-run
// finals are then summed to recover the true lifetime total.

const CUMULATIVE = 2;

// `timestamp_unix_nano` is stored as TEXT. SQLite orders INTEGER before TEXT
// regardless of value, so a bare `CAST(col AS INTEGER) >= ?` against a string
// parameter would match nothing — both sides must be cast.
const tsNs = (alias = '') => `CAST(${alias}timestamp_unix_nano AS INTEGER)`;
const TS_NS = tsNs();

/** All metric instruments, aggregated across their data points. Passing
 *  bounds restricts instruments to those that received points in that inclusive window. */
export function getMetricInstruments(
  db: QueryableDB,
  sinceNano?: string,
  untilNano?: string,
): MetricInstrument[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (sinceNano) { conditions.push(`${TS_NS} >= CAST(? AS INTEGER)`); params.push(sinceNano); }
  if (untilNano) { conditions.push(`${TS_NS} <= CAST(? AS INTEGER)`); params.push(untilNano); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT
      name,
      metric_type,
      COALESCE(unit, '')         AS unit,
      COALESCE(service_name, '') AS service_name,
      COUNT(*)                   AS point_count,
      COUNT(DISTINCT attributes) AS series_count,
      MAX(${TS_NS}) AS last_ts
    FROM metric_points
    ${where}
    GROUP BY name, metric_type, unit, service_name
    ORDER BY service_name, name
  `).all(...params);

  return rows.map(r => ({
    name:              String(r['name']         ?? ''),
    metricType:        String(r['metric_type']  ?? ''),
    unit:              String(r['unit']         ?? ''),
    serviceName:       String(r['service_name'] ?? ''),
    pointCount:        Number(r['point_count']  ?? 0),
    seriesCount:       Number(r['series_count'] ?? 0),
    lastTimestampNano: String(r['last_ts']      ?? '0'),
  }));
}

/** Detail for one metric instrument: stats, a time-series, and a per-attribute
 *  breakdown. Passing bounds restricts to that inclusive window — see `baseCte`
 *  below for what a window means under each temporality. */
export function getMetricDetail(
  db: QueryableDB,
  name: string,
  serviceName: string,
  sinceNano?: string,
  untilNano?: string,
): MetricDetail {
  const meta = db.prepare(`
    SELECT metric_type, COALESCE(unit, '') AS unit, temporality
    FROM metric_points WHERE name = ? AND service_name = ? LIMIT 1
  `).get(name, serviceName);

  const metricType   = String(meta?.['metric_type'] ?? '');
  const unit         = String(meta?.['unit'] ?? '');
  const isCumulative = Number(meta?.['temporality'] ?? 0) === CUMULATIVE;

  // Base row set to aggregate, chosen by temporality and whether a window is set.
  //  - cumulative (e.g. Copilot): each point holds a RUNNING TOTAL per series
  //    run, where a run is (attributes, start_time_unix_nano) so that a counter
  //    reset on process restart starts a fresh run rather than overwriting the
  //    previous one. Unwindowed, take the LATEST point per run and aggregate.
  //    Windowed, report what accrued DURING the window: subtract the last point
  //    before the window (the baseline) from the last point inside it. A run
  //    that first appeared inside the window has no baseline, so it counts in
  //    full — which is correct, it started at zero.
  //  - delta (e.g. some Claude Code configurations): each point is an
  //    INDEPENDENT increment for its interval, so aggregate EVERY point in range.
  // All branches expose the same columns (attributes, value, data_*), so the
  // downstream stat/dimension queries are identical.
  //
  // Caveat: data_min/data_max cannot be differenced — a cumulative histogram's
  // min/max are already lifetime extremes — so windowed cumulative min/max are
  // the extremes as recorded at the window's edge, not extremes within it.
  let baseCte: string;
  let baseParams: unknown[];
  if (isCumulative && sinceNano) {
    const winUpperBound = untilNano ? `AND ${TS_NS} <= CAST(? AS INTEGER)` : '';
    baseCte = `WITH win AS (
        SELECT attributes, start_time_unix_nano AS run, value, data_count, data_sum, data_min, data_max, ${TS_NS} AS ts
        FROM metric_points
        WHERE name = ? AND service_name = ? AND ${TS_NS} >= CAST(? AS INTEGER)
        ${winUpperBound}
      ),
      last_in_win AS (
        SELECT w.* FROM win w
        JOIN (SELECT attributes, run, MAX(ts) AS mt FROM win GROUP BY attributes, run) L
          ON w.attributes = L.attributes AND w.run = L.run AND w.ts = L.mt
      ),
      baseline AS (
        SELECT mp.attributes, mp.start_time_unix_nano AS run, mp.value, mp.data_count, mp.data_sum
        FROM metric_points mp
        JOIN (
          SELECT attributes, start_time_unix_nano AS run, MAX(${TS_NS}) AS mt
          FROM metric_points
          WHERE name = ? AND service_name = ? AND ${TS_NS} < CAST(? AS INTEGER)
          GROUP BY attributes, run
        ) P ON mp.attributes = P.attributes AND mp.start_time_unix_nano = P.run AND ${tsNs('mp.')} = P.mt
        WHERE mp.name = ? AND mp.service_name = ?
      ),
      base AS (
        SELECT
          l.attributes,
          l.value      - COALESCE(b.value, 0)      AS value,
          l.data_count - COALESCE(b.data_count, 0) AS data_count,
          l.data_sum   - COALESCE(b.data_sum, 0)   AS data_sum,
          l.data_min, l.data_max
        FROM last_in_win l
        LEFT JOIN baseline b ON l.attributes = b.attributes AND l.run = b.run
      )`;
    baseParams = [
      name, serviceName, sinceNano,
      ...(untilNano ? [untilNano] : []),
      name, serviceName, sinceNano,
      name, serviceName,
    ];
  } else if (isCumulative) {
    const upperBound = untilNano ? `AND ${TS_NS} <= CAST(? AS INTEGER)` : '';
    baseCte = `WITH base AS (
         SELECT mp.attributes, mp.value, mp.data_count, mp.data_sum, mp.data_min, mp.data_max
         FROM metric_points mp
         JOIN (
           SELECT attributes, start_time_unix_nano AS run, MAX(${TS_NS}) AS mt
           FROM metric_points
           WHERE name = ? AND service_name = ?
           ${upperBound}
           GROUP BY attributes, run
         ) L ON mp.attributes = L.attributes
            AND mp.start_time_unix_nano = L.run
            AND ${tsNs('mp.')} = L.mt
         WHERE mp.name = ? AND mp.service_name = ?
      )`;
    baseParams = [name, serviceName, ...(untilNano ? [untilNano] : []), name, serviceName];
  } else {
    const lowerBound = sinceNano ? `AND ${TS_NS} >= CAST(? AS INTEGER)` : '';
    const upperBound = untilNano ? `AND ${TS_NS} <= CAST(? AS INTEGER)` : '';
    baseCte = `WITH base AS (
         SELECT attributes, value, data_count, data_sum, data_min, data_max
         FROM metric_points
         WHERE name = ? AND service_name = ?
         ${lowerBound}
         ${upperBound}
      )`;
    baseParams = [
      name,
      serviceName,
      ...(sinceNano ? [sinceNano] : []),
      ...(untilNano ? [untilNano] : []),
    ];
  }

  const stat = db.prepare(`
    ${baseCte}
    SELECT
      COUNT(DISTINCT attributes) AS series_count,
      SUM(data_count) AS total_count,
      SUM(data_sum)   AS sum,
      MIN(data_min)   AS min,
      MAX(data_max)   AS max,
      SUM(value)      AS total
    FROM base
  `).get(...baseParams);

  const totalCount = Number(stat?.['total_count'] ?? 0);
  const sum        = Number(stat?.['sum'] ?? 0);

  // Per-attribute breakdown. `attributes` is already a flat {key:value} object,
  // so json_each yields one row per dimension.
  const dimRows = db.prepare(`
    ${baseCte}
    SELECT
      j.key   AS dim_key,
      j.value AS dim_val,
      SUM(COALESCE(base.data_count, 1))            AS cnt,
      SUM(COALESCE(base.data_sum, base.value, 0)) AS total
    FROM base, json_each(base.attributes) j
    GROUP BY dim_key, dim_val
    ORDER BY dim_key ASC, cnt DESC
  `).all(...baseParams);

  const dimMap = new Map<string, MetricDimension>();
  for (const r of dimRows) {
    const key = String(r['dim_key'] ?? '');
    if (!key) { continue; }
    let dim = dimMap.get(key);
    if (!dim) { dim = { key, values: [] }; dimMap.set(key, dim); }
    dim.values.push({
      value: String(r['dim_val'] ?? ''),
      count: Number(r['cnt']     ?? 0),
      total: Number(r['total']   ?? 0),
    });
  }
  // Show the most descriptive dimensions first (most distinct values), cap noise.
  const dimensions = Array.from(dimMap.values())
    .sort((a, b) => b.values.length - a.values.length)
    .map(d => ({
      ...d,
      // The UI presents contribution rank and share, so truncate only after
      // ranking by contribution; sorting by observation count first could omit
      // a high-value, low-frequency dimension value.
      values: d.values.sort((a, b) => b.total - a.total).slice(0, 20),
    }));

  // Time-series: raw data-point values over time, bucketed + averaged in JS so
  // the chart stays light regardless of how many points exist.
  const pointLowerBound = sinceNano ? `AND ${TS_NS} >= CAST(? AS INTEGER)` : '';
  const pointUpperBound = untilNano ? `AND ${TS_NS} <= CAST(? AS INTEGER)` : '';
  const pointParams: unknown[] = [
    name,
    serviceName,
    ...(sinceNano ? [sinceNano] : []),
    ...(untilNano ? [untilNano] : []),
  ];
  const points = db.prepare(`
    SELECT ${TS_NS} AS t_ns, value
    FROM metric_points
    WHERE name = ? AND service_name = ? AND value IS NOT NULL
    ${pointLowerBound}
    ${pointUpperBound}
    ORDER BY t_ns ASC
  `).all(...pointParams);

  const series = bucketSeries(
    points.map(p => ({ t: Number(p['t_ns'] ?? 0) / 1e6, value: Number(p['value'] ?? 0) })),
    80,
  );

  return {
    name,
    serviceName,
    metricType,
    unit,
    isCumulative,
    window: {
      ...(sinceNano ? { sinceNano } : {}),
      ...(untilNano ? { untilNano } : {}),
    },
    stats: {
      seriesCount: Number(stat?.['series_count'] ?? 0),
      totalCount,
      sum,
      avg: totalCount > 0 ? sum / totalCount : 0,
      min: Number(stat?.['min'] ?? 0),
      max: Number(stat?.['max'] ?? 0),
      total: Number(stat?.['total'] ?? 0),
    },
    series,
    dimensions,
  };
}

/** Collapse an ordered point list into at most `maxBuckets` time-bucketed
 *  averages (keeps the chart cheap and readable). */
function bucketSeries(points: MetricSeriesPoint[], maxBuckets: number): MetricSeriesPoint[] {
  if (points.length <= maxBuckets) { return points; }
  const first = points[0]!.t;
  const last  = points[points.length - 1]!.t;
  const span  = last - first || 1;
  const width = span / maxBuckets;

  const sums   = new Array<number>(maxBuckets).fill(0);
  const counts = new Array<number>(maxBuckets).fill(0);
  for (const p of points) {
    const idx = Math.min(maxBuckets - 1, Math.floor((p.t - first) / width));
    sums[idx]   += p.value;
    counts[idx] += 1;
  }
  const out: MetricSeriesPoint[] = [];
  for (let i = 0; i < maxBuckets; i++) {
    if (counts[i]! > 0) {
      out.push({ t: first + width * (i + 0.5), value: sums[i]! / counts[i]! });
    }
  }
  return out;
}
