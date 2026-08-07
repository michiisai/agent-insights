/**
 * Codex runtime spans report how long an async future existed as their OTel
 * duration and how long it actually worked as busy_ns. Prefer the latter for
 * latency reporting whenever it is present.
 */
export function effectiveDurationMsSql(alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  const attributes = `CASE WHEN json_valid(${prefix}attributes) THEN ${prefix}attributes ELSE '{}' END`;
  return `CASE
    WHEN json_extract(${attributes}, '$."busy_ns"') IS NOT NULL
      THEN CAST(json_extract(${attributes}, '$."busy_ns"') AS REAL) / 1000000.0
    ELSE ${prefix}duration_ms
  END`;
}
