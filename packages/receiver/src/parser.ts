import type { SpanRow, MetricRow, LogRow } from './store';

// Keep raw OTLP values, including 64-bit integer strings, intact.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseOtlpTraces(body: any): SpanRow[] {
  const rows: SpanRow[] = [];
  for (const rs of (body?.resourceSpans ?? [])) {
    for (const ss of (rs?.scopeSpans ?? [])) {
      for (const span of (ss?.spans ?? [])) {
        rows.push({
          raw: JSON.stringify({
            resource: rs.resource ?? null,
            scope:    ss.scope    ?? null,
            resourceSchemaUrl: rs.schemaUrl ?? null,
            scopeSchemaUrl:    ss.schemaUrl ?? null,
            span,
          }),
        });
      }
    }
  }
  return rows;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseOtlpMetrics(body: any): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const rm of (body?.resourceMetrics ?? [])) {
    for (const sm of (rm?.scopeMetrics ?? [])) {
      for (const metric of (sm?.metrics ?? [])) {
        // Store shared metric metadata once per data-point row.
        const {
          gauge: _g, sum: _s, histogram: _h,
          exponentialHistogram: _eh, summary: _sum,
          ...metricMeta
        } = metric;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const typed: Array<[string, any]> = [
          ['gauge',                metric.gauge],
          ['sum',                  metric.sum],
          ['histogram',            metric.histogram],
          ['exponentialHistogram', metric.exponentialHistogram],
          ['summary',              metric.summary],
        ];
        for (const [metricType, agg] of typed) {
          if (!agg) { continue; }
          // Aggregation metadata lives outside the data-point array.
          const { dataPoints, ...aggregation } = agg;
          for (const dp of (dataPoints ?? [])) {
            rows.push({
              raw: JSON.stringify({
                resource:  rm.resource ?? null,
                scope:     sm.scope    ?? null,
                resourceSchemaUrl: rm.schemaUrl ?? null,
                scopeSchemaUrl:    sm.schemaUrl ?? null,
                metric:      metricMeta,
                metricType,
                aggregation,
                dataPoint:   dp,
              }),
            });
          }
        }
      }
    }
  }
  return rows;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseOtlpLogs(body: any): LogRow[] {
  const rows: LogRow[] = [];
  for (const rl of (body?.resourceLogs ?? [])) {
    for (const sl of (rl?.scopeLogs ?? [])) {
      for (const lr of (sl?.logRecords ?? [])) {
        rows.push({
          raw: JSON.stringify({
            resource:  rl.resource ?? null,
            scope:     sl.scope    ?? null,
            resourceSchemaUrl: rl.schemaUrl ?? null,
            scopeSchemaUrl:    sl.schemaUrl ?? null,
            logRecord: lr,
          }),
        });
      }
    }
  }
  return rows;
}
