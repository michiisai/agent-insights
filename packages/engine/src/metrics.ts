import type {
  QueryableDB,
  MetricInstrument,
  MetricDetail,
  MetricDimension,
  MetricSeriesPoint,
  MetricChart,
  MetricChartBreakdown,
} from '@agent-insights/types';

const CUMULATIVE = 2;
const MAX_CHART_BUCKETS = 60;

// Cast both operands because metric timestamps are stored as text.
const tsNs = (alias = '') => `CAST(${alias}timestamp_unix_nano AS INTEGER)`;
const TS_NS = tsNs();

/** List metric instruments with optional inclusive time bounds. */
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

/** Return an instrument's statistics, series, and attribute breakdown. */
export function getMetricDetail(
  db: QueryableDB,
  name: string,
  serviceName: string,
  sinceNano?: string,
  untilNano?: string,
  includeComparison = true,
): MetricDetail {
  const meta = db.prepare(`
    SELECT
      metric_type,
      COALESCE(unit, '') AS unit,
      temporality,
      json_extract(raw, '$.aggregation.isMonotonic') AS is_monotonic
    FROM metric_points WHERE name = ? AND service_name = ? LIMIT 1
  `).get(name, serviceName);

  const metricType   = String(meta?.['metric_type'] ?? '');
  const unit         = String(meta?.['unit'] ?? '');
  // OTLP summaries are always cumulative.
  const isCumulative = metricType === 'summary'
    || Number(meta?.['temporality'] ?? 0) === CUMULATIVE;
  const isMonotonic  = Number(meta?.['is_monotonic'] ?? 0) === 1;

  // Windowed cumulative data is measured against each run's prior baseline.
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
  const dimensions = Array.from(dimMap.values())
    .sort((a, b) => b.values.length - a.values.length)
    .map(d => ({
      ...d,
      // Rank before truncating to retain high-value dimension values.
      values: d.values.sort((a, b) => b.total - a.total).slice(0, 20),
    }));

  const pointLowerBound = sinceNano ? `AND ${TS_NS} >= CAST(? AS INTEGER)` : '';
  const pointUpperBound = untilNano ? `AND ${TS_NS} <= CAST(? AS INTEGER)` : '';
  const pointParams: unknown[] = [
    name,
    serviceName,
    ...(sinceNano ? [sinceNano] : []),
    ...(untilNano ? [untilNano] : []),
  ];
  const points = db.prepare(`
    SELECT
      attributes,
      start_time_unix_nano AS run,
      timestamp_unix_nano AS t_nano,
      ${TS_NS} AS t_ns,
      value,
      data_count,
      data_sum,
      COALESCE(
        json_extract(attributes, '$."gen_ai.token.type"'),
        json_extract(attributes, '$.type')
      ) AS token_type,
      COALESCE(
        json_extract(attributes, '$."gen_ai.request.model"'),
        json_extract(attributes, '$.model'),
        json_extract(attributes, '$."gen_ai.response.model"')
      ) AS model
    FROM metric_points
    WHERE name = ? AND service_name = ?
      AND (value IS NOT NULL OR data_sum IS NOT NULL)
    ${pointLowerBound}
    ${pointUpperBound}
    ORDER BY t_ns ASC
  `).all(...pointParams);
  const observedSinceNano = points.length > 0
    ? String(points[0]?.['t_nano'] ?? '')
    : undefined;
  const observedUntilNano = points.length > 0
    ? String(points[points.length - 1]?.['t_nano'] ?? '')
    : undefined;

  const chart = buildMetricChart(
    db,
    name,
    serviceName,
    metricType,
    unit,
    isCumulative,
    isMonotonic,
    sinceNano,
    observedSinceNano,
    observedUntilNano,
    points,
    includeComparison,
  );

  const detail: MetricDetail = {
    name,
    serviceName,
    metricType,
    unit,
    isCumulative,
    window: {
      ...(sinceNano ? { sinceNano } : {}),
      ...(untilNano ? { untilNano } : {}),
    },
    observedWindow: {
      ...(observedSinceNano ? { sinceNano: observedSinceNano } : {}),
      ...(observedUntilNano ? { untilNano: observedUntilNano } : {}),
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
    chart,
    dimensions,
  };

  if (includeComparison && sinceNano && untilNano && chart.kind !== 'value') {
    const currentStart = BigInt(sinceNano);
    const currentEnd = BigInt(untilNano);
    const duration = currentEnd - currentStart + 1n;
    const previousEnd = currentStart - 1n;
    const previousStart = previousEnd - duration + 1n;
    const previous = getMetricDetail(
      db,
      name,
      serviceName,
      previousStart.toString(),
      previousEnd.toString(),
      false,
    );
    const previousValue = metricComparisonValue(previous);
    const currentValue = metricComparisonValue(detail);
    const hasPreviousData = previous.stats.seriesCount > 0;
    detail.comparison = {
      kind: chart.kind,
      previousValue,
      ...(hasPreviousData && previousValue !== 0
        ? { changePercent: ((currentValue - previousValue) / Math.abs(previousValue)) * 100 }
        : {}),
      hasPreviousData,
      window: {
        sinceNano: previousStart.toString(),
        untilNano: previousEnd.toString(),
      },
    };
  }

  return detail;
}

function metricComparisonValue(detail: MetricDetail): number {
  return detail.chart.kind === 'activity'
    ? Number(detail.chart.total ?? 0)
    : Number(detail.stats.avg ?? 0);
}

interface MetricPointRow extends Record<string, unknown> {
  attributes?: unknown;
  run?: unknown;
  t_nano?: unknown;
  t_ns?: unknown;
  value?: unknown;
  data_count?: unknown;
  data_sum?: unknown;
  token_type?: unknown;
  model?: unknown;
}

interface IntervalPoint {
  t: number;
  value: number;
  count: number;
  tokenType: string;
  model: string;
}

interface PreviousPoint {
  value: number;
  count: number;
  sum: number;
}

function buildMetricChart(
  db: QueryableDB,
  name: string,
  serviceName: string,
  metricType: string,
  unit: string,
  isCumulative: boolean,
  isMonotonic: boolean,
  requestedSinceNano: string | undefined,
  observedSinceNano: string | undefined,
  observedUntilNano: string | undefined,
  rows: MetricPointRow[],
  includeBreakdowns: boolean,
): MetricChart {
  if (metricType === 'histogram' || metricType === 'exponentialHistogram' || metricType === 'summary') {
    const activity = intervalPoints(db, name, serviceName, isCumulative, requestedSinceNano, rows, 'histogram');
    const additive = isAdditiveHistogram(name, unit);
    const bucketed = bucketIntervals(activity.points, observedSinceNano, observedUntilNano, additive);
    const visibleTotal = bucketed.series.reduce((total, point) => total + point.value, 0);
    return {
      kind: additive ? 'activity' : 'average',
      series: bucketed.series,
      bucketMs: bucketed.bucketMs,
      ...(activity.unattributed > 0 ? { unattributed: activity.unattributed } : {}),
      ...(activity.unattributedCount > 0 ? { unattributedCount: activity.unattributedCount } : {}),
      ...(additive ? {
        total: visibleTotal + activity.unattributed,
        ...(includeBreakdowns
          ? tokenBreakdowns(name, unit, activity.points, bucketed.spec)
          : {}),
      } : {}),
    };
  }

  if (metricType === 'sum' && isMonotonic) {
    const activity = intervalPoints(db, name, serviceName, isCumulative, requestedSinceNano, rows, 'sum');
    const bucketed = bucketIntervals(activity.points, observedSinceNano, observedUntilNano, true);
    const visibleTotal = bucketed.series.reduce((total, point) => total + point.value, 0);
    return {
      kind: 'activity',
      series: bucketed.series,
      bucketMs: bucketed.bucketMs,
      total: visibleTotal + activity.unattributed,
      ...(activity.unattributed > 0 ? { unattributed: activity.unattributed } : {}),
      ...(includeBreakdowns
        ? tokenBreakdowns(name, unit, activity.points, bucketed.spec)
        : {}),
    };
  }

  return {
    kind: 'value',
    series: bucketSeries(
      rows.map(row => ({
        t: Number(row['t_ns'] ?? 0) / 1e6,
        value: Number(row['value'] ?? 0),
      })),
      80,
    ),
  };
}

function intervalPoints(
  db: QueryableDB,
  name: string,
  serviceName: string,
  isCumulative: boolean,
  sinceNano: string | undefined,
  rows: MetricPointRow[],
  source: 'sum' | 'histogram',
): { points: IntervalPoint[]; unattributed: number; unattributedCount: number } {
  const previousBySeries = new Map<string, PreviousPoint>();
  if (isCumulative && sinceNano) {
    const baselineRows = db.prepare(`
      SELECT
        mp.attributes,
        mp.start_time_unix_nano AS run,
        mp.value,
        mp.data_count,
        mp.data_sum
      FROM metric_points mp
      JOIN (
        SELECT attributes, start_time_unix_nano AS run, MAX(${TS_NS}) AS mt
        FROM metric_points
        WHERE name = ? AND service_name = ? AND ${TS_NS} < CAST(? AS INTEGER)
        GROUP BY attributes, run
      ) b ON mp.attributes = b.attributes
         AND mp.start_time_unix_nano = b.run
         AND ${tsNs('mp.')} = b.mt
      WHERE mp.name = ? AND mp.service_name = ?
    `).all(name, serviceName, sinceNano, name, serviceName);
    for (const row of baselineRows) {
      previousBySeries.set(metricSeriesKey(row), numericPoint(row));
    }
  }

  const intervals: IntervalPoint[] = [];
  let unattributed = 0;
  let unattributedCount = 0;
  for (const row of rows) {
    const current = numericPoint(row);
    const previous = previousBySeries.get(metricSeriesKey(row));
    previousBySeries.set(metricSeriesKey(row), current);

    let value = source === 'histogram' ? current.sum : current.value;
    let count = source === 'histogram' ? current.count : 1;
    if (isCumulative && previous) {
      value = monotonicDifference(value, source === 'histogram' ? previous.sum : previous.value);
      count = monotonicDifference(count, source === 'histogram' ? previous.count : 0);
    } else if (isCumulative && !runStartedInWindow(row, sinceNano)) {
      // A pre-window baseline cannot be attributed to the selected window.
      unattributed += value;
      unattributedCount += count;
      value = 0;
      count = 0;
    }
    intervals.push({
      t: Number(row['t_ns'] ?? 0) / 1e6,
      value,
      count,
      tokenType: normalizeTokenType(String(row['token_type'] ?? '')),
      model: String(row['model'] ?? '').trim() || 'Unknown',
    });
  }
  return { points: intervals, unattributed, unattributedCount };
}

function numericPoint(row: Record<string, unknown>): PreviousPoint {
  return {
    value: Number(row['value'] ?? 0),
    count: Number(row['data_count'] ?? 0),
    sum: Number(row['data_sum'] ?? 0),
  };
}

function monotonicDifference(current: number, previous: number): number {
  return current >= previous ? current - previous : current;
}

function metricSeriesKey(row: Record<string, unknown>): string {
  return `${String(row['attributes'] ?? '{}')}\u0000${String(row['run'] ?? '0')}`;
}

function runStartedInWindow(row: MetricPointRow, sinceNano: string | undefined): boolean {
  try {
    const runStart = BigInt(String(row['run'] ?? '0'));
    const reportTime = BigInt(String(row['t_nano'] ?? '0'));
    return runStart > 0n
      && runStart <= reportTime
      && (!sinceNano || runStart >= BigInt(sinceNano));
  } catch {
    return false;
  }
}

function isAdditiveHistogram(name: string, unit: string): boolean {
  const normalizedUnit = unit.replace(/[{}]/g, '').trim().toLowerCase();
  return isTokenMetric(name, unit)
    || ['usd', 'dollar', 'dollars'].includes(normalizedUnit);
}

function isTokenMetric(name: string, unit: string): boolean {
  const normalizedUnit = unit.replace(/[{}]/g, '').trim().toLowerCase();
  return normalizedUnit === 'token'
    || normalizedUnit === 'tokens'
    || /(?:^|[._])token(?:[._]|$)/i.test(name);
}

function normalizeTokenType(value: string): string {
  switch (value.replace(/[._\s-]/g, '').toLowerCase()) {
    case 'input':
    case 'inputtoken':
    case 'inputtokens':
      return 'Input';
    case 'output':
    case 'outputtoken':
    case 'outputtokens':
      return 'Output';
    case 'cacheread':
    case 'cachereadinputtokens':
      return 'Cache read';
    case 'cachecreation':
    case 'cachewrite':
    case 'cachecreationinputtokens':
      return 'Cache creation';
    case 'reasoning':
    case 'reasoningoutputtokens':
      return 'Reasoning';
    default:
      return value.trim() || 'Other';
  }
}

function tokenBreakdowns(
  name: string,
  unit: string,
  points: IntervalPoint[],
  spec: MetricBucketSpec,
): { breakdowns?: MetricChartBreakdown[] } {
  if (!isTokenMetric(name, unit)) { return {}; }

  const breakdowns = [
    buildMetricBreakdown('tokenType', 'Token type', points, point => point.tokenType, spec),
    buildMetricBreakdown('model', 'Model', points, point => point.model, spec),
  ].filter((breakdown): breakdown is MetricChartBreakdown => breakdown !== undefined);
  return breakdowns.length > 0 ? { breakdowns } : {};
}

function buildMetricBreakdown(
  key: MetricChartBreakdown['key'],
  label: string,
  points: IntervalPoint[],
  group: (point: IntervalPoint) => string,
  spec: MetricBucketSpec,
): MetricChartBreakdown | undefined {
  const activePoints = points.filter(point => point.value > 0);
  const totals = new Map<string, number>();
  for (const point of activePoints) {
    const name = group(point);
    totals.set(name, (totals.get(name) ?? 0) + point.value);
  }
  if (totals.size < 2) { return undefined; }

  const ranked = Array.from(totals, ([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);
  const keep = new Set(ranked.slice(0, 4).map(item => item.name));
  const grouped = new Map<string, IntervalPoint[]>();
  for (const point of activePoints) {
    const rawName = group(point);
    const name = keep.has(rawName) ? rawName : 'Other';
    const existing = grouped.get(name);
    if (existing) {
      existing.push(point);
    } else {
      grouped.set(name, [point]);
    }
  }

  const tokenTypeOrder = ['Input', 'Output', 'Cache read', 'Cache creation', 'Reasoning'];
  const order = [...keep].sort((a, b) => key === 'tokenType'
    ? (tokenTypeOrder.indexOf(a) + 1 || Number.MAX_SAFE_INTEGER)
      - (tokenTypeOrder.indexOf(b) + 1 || Number.MAX_SAFE_INTEGER)
    : (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  if (grouped.has('Other') && !order.includes('Other')) { order.push('Other'); }
  return {
    key,
    label,
    series: order.map(seriesLabel => ({
      label: seriesLabel,
      points: bucketIntervals(grouped.get(seriesLabel) ?? [], undefined, undefined, true, spec).series,
    })),
  };
}

interface MetricBucketSpec {
  first: number;
  bucketMs: number;
  bucketCount: number;
}

function bucketIntervals(
  points: IntervalPoint[],
  sinceNano: string | undefined,
  untilNano: string | undefined,
  total: boolean,
  existingSpec?: MetricBucketSpec,
): { series: MetricSeriesPoint[]; bucketMs: number; spec: MetricBucketSpec } {
  if (points.length === 0 && !existingSpec) {
    const spec = { first: 0, bucketMs: 60_000, bucketCount: 0 };
    return { series: [], bucketMs: spec.bucketMs, spec };
  }

  const first = existingSpec?.first
    ?? (sinceNano ? nanoToMillis(sinceNano) : points[0]!.t);
  const last = untilNano ? nanoToMillis(untilNano) : points[points.length - 1]?.t ?? first;
  const span = Math.max(last - first, 1);
  const bucketMs = existingSpec?.bucketMs ?? chartBucketMs(span);
  const bucketCount = existingSpec?.bucketCount ?? Math.max(1, Math.ceil(span / bucketMs));
  const spec = { first, bucketMs, bucketCount };
  const sums = new Array<number>(bucketCount).fill(0);
  const counts = new Array<number>(bucketCount).fill(0);

  for (const point of points) {
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((point.t - first) / bucketMs)));
    sums[index] += point.value;
    counts[index] += point.count;
  }

  const series: MetricSeriesPoint[] = [];
  for (let index = 0; index < bucketCount; index++) {
    if (total || counts[index]! > 0) {
      series.push({
        t: first + index * bucketMs + bucketMs / 2,
        value: total ? sums[index]! : sums[index]! / counts[index]!,
      });
    }
  }
  return { series, bucketMs, spec };
}

function nanoToMillis(nano: string): number {
  return Number(BigInt(nano) / 1_000_000n);
}

function chartBucketMs(spanMs: number): number {
  const candidates = [
    60_000,
    5 * 60_000,
    15 * 60_000,
    60 * 60_000,
    3 * 60 * 60_000,
    6 * 60 * 60_000,
    12 * 60 * 60_000,
    24 * 60 * 60_000,
    7 * 24 * 60 * 60_000,
    30 * 24 * 60 * 60_000,
  ];
  return candidates.find(candidate => Math.ceil(spanMs / candidate) <= MAX_CHART_BUCKETS)
    ?? Math.ceil(spanMs / MAX_CHART_BUCKETS / (24 * 60 * 60_000)) * 24 * 60 * 60_000;
}

/** Collapse points into at most `maxBuckets` averages. */
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
