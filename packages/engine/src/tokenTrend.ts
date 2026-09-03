import {
  TOKEN_TREND_BUCKET_COUNT,
  isVisibleModel,
  type ModelTokenTrend,
  type ModelVisibilityOptions,
  type QueryableDB,
  type TokenTrend,
  type TokenTrendBuckets,
} from '@agent-insights/types';
import { normalizeModelName } from './agentAnalytics';

const HOUR_MS = 60 * 60 * 1_000;
const TREND_HOURS = 12;
const SPARK_LEVELS = '▂▃▄▅▆▇█';
// Preserve empty bucket width without drawing a baseline.
const EMPTY_SPARK_BUCKET = '\u2800';

interface MutableTrend {
  inputTokens: TokenTrendBuckets;
  outputTokens: TokenTrendBuckets;
}

function emptyBuckets(): TokenTrendBuckets {
  return [0, 0, 0, 0, 0, 0];
}

function emptyTrend(): MutableTrend {
  return { inputTokens: emptyBuckets(), outputTokens: emptyBuckets() };
}

function roundBuckets(values: TokenTrendBuckets): TokenTrendBuckets {
  return [
    Math.round(values[0]),
    Math.round(values[1]),
    Math.round(values[2]),
    Math.round(values[3]),
    Math.round(values[4]),
    Math.round(values[5]),
  ];
}

function trendTotal(trend: ModelTokenTrend): number {
  return trend.inputTokens.reduce((sum, value) => sum + value, 0)
    + trend.outputTokens.reduce((sum, value) => sum + value, 0);
}

export interface TokenTrendWindow {
  key: string;
  sinceNano: string;
  untilNano: string;
}

export function getTokenTrendWindow(now = new Date()): TokenTrendWindow {
  const hourStartMs = now.getTime()
    - now.getMinutes() * 60_000
    - now.getSeconds() * 1_000
    - now.getMilliseconds();
  const untilMs = hourStartMs + HOUR_MS;
  const sinceMs = untilMs - TREND_HOURS * HOUR_MS;
  return {
    key: `${hourStartMs}@${now.getTimezoneOffset()}`,
    sinceNano: `${sinceMs}000000`,
    untilNano: `${untilMs}000000`,
  };
}

export function formatTokenSparkline(values: readonly number[]): string {
  const max = Math.max(0, ...values);
  if (max === 0) { return values.map(() => EMPTY_SPARK_BUCKET).join(''); }
  return values.map(value => {
    if (value <= 0) { return EMPTY_SPARK_BUCKET; }
    const level = Math.min(
      SPARK_LEVELS.length - 1,
      Math.max(0, Math.ceil((value / max) * SPARK_LEVELS.length) - 1),
    );
    return SPARK_LEVELS[level];
  }).join('');
}

export function getTokenTrend(
  db: QueryableDB,
  sinceNano: string,
  untilNano: string,
  visibility?: ModelVisibilityOptions,
): TokenTrend {
  const since = BigInt(sinceNano);
  const until = BigInt(untilNano);
  const duration = until - since;
  if (duration <= 0n || duration % BigInt(TOKEN_TREND_BUCKET_COUNT) !== 0n) {
    throw new Error('Token trend window must divide evenly into six positive buckets.');
  }
  const bucketWidth = duration / BigInt(TOKEN_TREND_BUCKET_COUNT);

  const rows = db.prepare(`
    SELECT
      model,
      timestamp_unix_nano,
      CASE WHEN is_additive = 1
           THEN input_tokens + cache_read_tokens + cache_creation_tokens
           ELSE input_tokens END AS input_tokens,
      output_tokens
    FROM token_facts
    WHERE timestamp_unix_nano >= ?
      AND timestamp_unix_nano < ?
    ORDER BY timestamp_unix_nano ASC
  `).all(sinceNano, untilNano);

  const total = emptyTrend();
  const byModel = new Map<string, MutableTrend>();
  for (const row of rows) {
    const model = normalizeModelName(String(row['model'] ?? 'unknown'));
    if (!isVisibleModel(model, visibility)) { continue; }

    const timestamp = BigInt(String(row['timestamp_unix_nano'] ?? '0'));
    const bucket = Number((timestamp - since) / bucketWidth);
    if (bucket < 0 || bucket >= TOKEN_TREND_BUCKET_COUNT) { continue; }

    const input = Number(row['input_tokens'] ?? 0);
    const output = Number(row['output_tokens'] ?? 0);
    const modelTrend = byModel.get(model) ?? emptyTrend();
    modelTrend.inputTokens[bucket] += input;
    modelTrend.outputTokens[bucket] += output;
    byModel.set(model, modelTrend);
    total.inputTokens[bucket] += input;
    total.outputTokens[bucket] += output;
  }

  const models: ModelTokenTrend[] = [...byModel.entries()]
    .map(([model, trend]) => ({
      model,
      inputTokens: roundBuckets(trend.inputTokens),
      outputTokens: roundBuckets(trend.outputTokens),
    }))
    .sort((a, b) => trendTotal(b) - trendTotal(a) || a.model.localeCompare(b.model));

  return {
    inputTokens: roundBuckets(total.inputTokens),
    outputTokens: roundBuckets(total.outputTokens),
    models,
  };
}
