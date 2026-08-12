import {
  isVisibleModel,
  type DailyModelTokenUsage,
  type DailyTokenUsage,
  type ModelVisibilityOptions,
  type QueryableDB,
} from '@agent-insights/types';
import { normalizeModelName } from './agentAnalytics';

interface TokenAggregate {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  callCount: number;
}

export function getDailyTokenUsage(
  db: QueryableDB,
  sinceNano: string,
  untilNano: string,
  visibility?: ModelVisibilityOptions,
): DailyTokenUsage {
  const rows = db.prepare(`
    SELECT
      model,
      SUM(CASE WHEN is_additive = 1
               THEN input_tokens + cache_read_tokens + cache_creation_tokens
               ELSE input_tokens END) AS input_tokens,
      SUM(cache_read_tokens) AS cached_tokens,
      SUM(output_tokens) AS output_tokens,
      COUNT(*) AS call_count
    FROM token_facts
    WHERE timestamp_unix_nano >= ?
      AND timestamp_unix_nano < ?
    GROUP BY model
  `).all(sinceNano, untilNano);

  const byModel = new Map<string, TokenAggregate>();
  for (const row of rows) {
    const model = normalizeModelName(String(row['model'] ?? 'unknown'));
    if (!isVisibleModel(model, visibility)) { continue; }
    const existing = byModel.get(model) ?? {
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      callCount: 0,
    };
    existing.inputTokens += Number(row['input_tokens'] ?? 0);
    existing.cachedTokens += Number(row['cached_tokens'] ?? 0);
    existing.outputTokens += Number(row['output_tokens'] ?? 0);
    existing.callCount += Number(row['call_count'] ?? 0);
    byModel.set(model, existing);
  }

  const models: DailyModelTokenUsage[] = [...byModel.entries()]
    .map(([model, usage]) => ({
      model,
      inputTokens: Math.round(usage.inputTokens),
      cachedTokens: Math.round(usage.cachedTokens),
      outputTokens: Math.round(usage.outputTokens),
      cacheHitRate: usage.inputTokens > 0 ? usage.cachedTokens / usage.inputTokens : -1,
      callCount: usage.callCount,
    }))
    .sort((a, b) =>
      (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)
      || a.model.localeCompare(b.model));

  const inputTokens = models.reduce((sum, model) => sum + model.inputTokens, 0);
  const cachedTokens = models.reduce((sum, model) => sum + model.cachedTokens, 0);
  const outputTokens = models.reduce((sum, model) => sum + model.outputTokens, 0);
  return {
    inputTokens,
    cachedTokens,
    outputTokens,
    cacheHitRate: inputTokens > 0 ? cachedTokens / inputTokens : -1,
    callCount: models.reduce((sum, model) => sum + model.callCount, 0),
    models,
  };
}
