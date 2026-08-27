/** Prefer Codex's active work time to its async future's wall-clock lifetime. */
export function effectiveDurationMsSql(alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  const attributes = `CASE WHEN json_valid(${prefix}attributes) THEN ${prefix}attributes ELSE '{}' END`;
  return `CASE
    WHEN json_extract(${attributes}, '$."busy_ns"') IS NOT NULL
      THEN CAST(json_extract(${attributes}, '$."busy_ns"') AS REAL) / 1000000.0
    ELSE ${prefix}duration_ms
  END`;
}
