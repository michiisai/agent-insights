'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { isUtilityModel, isVisibleModel } = require('@agent-insights/types');
const { check, eq } = require('../lib/assert');
const { sid } = require('../lib/otlp');
const { tokenFactSpan } = require('../lib/fixtures');

async function dailyTokenUsageChecks() {
  const dbPath = path.join(os.tmpdir(), `daily-token-usage-${process.pid}-${Date.now()}.db`);
  const cleanup = () => {
    for (const file of [dbPath, `${dbPath}.tmp`, `${dbPath}.sync.tmp`]) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  };
  let store = new TelemetryStore(dbPath, {
    raw_spans: {
      maxRows: 1,
      maxBytes: 64 * 1024 * 1024,
      perServiceFloor: 0,
      perServiceByteFloor: 0,
      byteCheckDelta: 64 * 1024 * 1024,
    },
  });
  await store.initialize();
  store.enablePersistence();

  try {
    const now = new Date();
    const startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const sinceNano = `${startMs}000000`;
    const untilNano = `${endMs}000000`;
    const at = (offsetMs) => `${startMs + offsetMs}000000`;
    const numAttr = (key, value) => ({ key, value: { intValue: String(value) } });
    const opAttr = (value) => ({ key: 'gen_ai.operation.name', value: { stringValue: value } });
    const modelAttr = (value) => ({ key: 'gen_ai.request.model', value: { stringValue: value } });
    const responseModelAttr = (value) => ({ key: 'gen_ai.response.model', value: { stringValue: value } });

    const chat = tokenFactSpan({
      spanId: sid(900),
      name: 'chat gpt-4o',
      timestamp: at(10),
      attributes: [
        opAttr('chat'), modelAttr('gpt-4o'),
        numAttr('gen_ai.usage.input_tokens', 100),
        numAttr('gen_ai.usage.cached_tokens', 40),
        numAttr('gen_ai.usage.output_tokens', 20),
      ],
    });
    const rows = [
      chat,
      // Copilot repeats child chat usage on invoke_agent; this rollup must not count.
      tokenFactSpan({
        spanId: sid(901),
        name: 'invoke_agent',
        timestamp: at(9),
        attributes: [
          opAttr('invoke_agent'), modelAttr('gpt-4o'),
          numAttr('gen_ai.usage.input_tokens', 100),
          numAttr('gen_ai.usage.output_tokens', 20),
        ],
      }),
      // Agent Host metadata/correlation wrappers are never provider usage.
      tokenFactSpan({
        spanId: sid(902),
        name: 'vscode.agent_host.session',
        service: 'vscode-agent-host',
        timestamp: at(8),
        attributes: [
          opAttr('chat'), modelAttr('gpt-4o'),
          numAttr('gen_ai.usage.input_tokens', 100),
        ],
      }),
      // Legacy llm.* standard accounting merges with the normalized model.
      tokenFactSpan({
        spanId: sid(903),
        name: 'chat gpt-4o',
        timestamp: at(20),
        attributes: [
          { key: 'llm.model', value: { stringValue: 'gpt-4o' } },
          numAttr('llm.usage.prompt_tokens', 50),
          numAttr('llm.usage.cached_tokens', 25),
        ],
      }),
      // Bare Anthropic cache fields are additive: prompt = 10 + 70 + 20.
      tokenFactSpan({
        spanId: sid(904),
        name: 'claude_code.llm_request',
        service: 'claude-code',
        timestamp: at(30),
        attributes: [
          modelAttr('claude-opus-4-8 [1m]'),
          numAttr('input_tokens', 10),
          numAttr('output_tokens', 5),
          numAttr('cache_read_tokens', 70),
          numAttr('cache_creation_tokens', 20),
        ],
      }),
      // Copilot can report only the response model; it must not fall into unknown.
      tokenFactSpan({
        spanId: sid(905),
        name: 'handle_responses',
        service: 'codex-app-server',
        timestamp: at(40),
        attributes: [
          responseModelAttr('gpt-5.6-sol'),
          numAttr('gen_ai.usage.input_tokens', 30),
          numAttr('gen_ai.usage.output_tokens', 4),
        ],
      }),
      // Turn parents are rollups, not request leaves.
      tokenFactSpan({
        spanId: sid(906),
        name: 'turn/start',
        service: 'codex-app-server',
        timestamp: at(41),
        attributes: [numAttr('gen_ai.usage.input_tokens', 1_000)],
      }),
      tokenFactSpan({
        spanId: sid(907),
        name: 'chat boundary-before',
        timestamp: `${startMs - 1}000000`,
        attributes: [opAttr('chat'), modelAttr('before-midnight'), numAttr('gen_ai.usage.input_tokens', 999)],
      }),
      tokenFactSpan({
        spanId: sid(908),
        name: 'chat boundary-after',
        timestamp: at(1),
        attributes: [opAttr('chat'), modelAttr('boundary'), numAttr('gen_ai.usage.input_tokens', 7)],
      }),
    ];

    const versionBefore = store.getTokenFactsVersion();
    store.insertSpans(rows);
    store.insertSpans([chat]);
    check(store.getTokenFactsVersion() > versionBefore, 'token fact version advances after token-bearing spans');

    let db = store.getDb();
    eq(db.prepare('SELECT COUNT(*) AS count FROM raw_spans').get().count, 1,
      'raw-span row retention prunes the token-bearing source rows');
    eq(db.prepare('SELECT COUNT(*) AS count FROM token_facts').get().count, 6,
      'token facts survive raw pruning, exclude rollups/wrappers, and dedupe re-ingest');

    const usage = engine.getDailyTokenUsage(db, sinceNano, untilNano);
    eq(usage.inputTokens, 287, 'daily input uses standard subset and Anthropic additive accounting');
    eq(usage.cachedTokens, 135, 'daily cached tokens count cache reads only');
    eq(usage.outputTokens, 29, 'daily output aggregates included request leaves');
    eq(usage.callCount, 5, 'daily call count excludes rollups, host wrappers, old-day facts, and duplicates');
    eq(Math.round(usage.cacheHitRate * 1000), 470, 'daily cache rate uses convention-aware prompt volume');
    eq(usage.models[0].model, 'gpt-4o', 'models sort by prompt plus output volume');
    const claude = usage.models.find(model => model.model === 'claude-opus-4.8') || {};
    eq(claude.inputTokens, 100, 'model normalization merges separators and strips context tags');
    eq(claude.cachedTokens, 70, 'per-model cached tokens are retained');
    check(usage.models.some(model => model.model === 'gpt-5.6-sol'),
      'response-only model attribution is retained in daily token facts');
    check(!usage.models.some(model => model.model === 'unknown'),
      'response-only model attribution does not create an unknown bucket');
    check(!usage.models.some(model => model.model === 'before-midnight'),
      'string nanosecond bounds exclude a fact one millisecond before local midnight');

    const filtered = engine.getDailyTokenUsage(db, sinceNano, untilNano, {
      hideUtilityModels: true,
      utilityModels: ['4O'],
    });
    eq(filtered.inputTokens, 137, 'utility-model filtering excludes hidden input from totals');
    eq(filtered.cachedTokens, 70, 'utility-model filtering excludes hidden cache reads from totals');
    eq(filtered.outputTokens, 9, 'utility-model filtering excludes hidden output from totals');
    eq(filtered.callCount, 3, 'utility-model filtering excludes hidden calls from totals');
    check(!filtered.models.some(model => model.model.includes('4o')),
      'utility-model filtering removes matching model rows case-insensitively');
    check(isVisibleModel(engine.normalizeModelName('gpt-5-4-nano [preview]'), {
      hideUtilityModels: true,
      utilityModels: ['5.4-nano'],
    }) === false, 'utility-model matching uses the normalized model name');
    check(isVisibleModel('gpt-4o-mini', {
      hideUtilityModels: false,
      utilityModels: ['4o'],
    }), 'disabling utility-model hiding keeps configured models visible');
    check(isUtilityModel('copilot-nes-lysithea-14'),
      'default utility-model patterns hide Copilot NES variants');

    const hourMs = 60 * 60 * 1_000;
    const trendSinceMs = startMs - 10 * hourMs;
    const trendUntilMs = startMs + 2 * hourMs;
    store.insertSpans([
      tokenFactSpan({
        spanId: sid(909),
        name: 'chat trend-start',
        timestamp: `${trendSinceMs}000000`,
        attributes: [
          opAttr('chat'), modelAttr('trend-boundary'),
          numAttr('gen_ai.usage.input_tokens', 11),
          numAttr('gen_ai.usage.output_tokens', 1),
        ],
      }),
      tokenFactSpan({
        spanId: sid(910),
        name: 'chat trend-bucket-two',
        timestamp: `${trendSinceMs + 2 * hourMs}000000`,
        attributes: [
          opAttr('chat'), modelAttr('trend-boundary'),
          numAttr('gen_ai.usage.input_tokens', 22),
          numAttr('gen_ai.usage.output_tokens', 2),
        ],
      }),
      tokenFactSpan({
        spanId: sid(911),
        name: 'chat normalized-trend-model',
        timestamp: `${trendSinceMs + 4 * hourMs}000000`,
        attributes: [
          opAttr('chat'), modelAttr('claude-opus-4.8'),
          numAttr('gen_ai.usage.input_tokens', 3),
        ],
      }),
      tokenFactSpan({
        spanId: sid(912),
        name: 'chat trend-end',
        timestamp: `${trendUntilMs}000000`,
        attributes: [
          opAttr('chat'), modelAttr('trend-end-excluded'),
          numAttr('gen_ai.usage.input_tokens', 999),
        ],
      }),
    ]);

    const trendSinceNano = `${trendSinceMs}000000`;
    const trendUntilNano = `${trendUntilMs}000000`;
    const trend = engine.getTokenTrend(db, trendSinceNano, trendUntilNano);
    eq(trend.inputTokens.length, 6, 'rolling trend always returns six buckets');
    eq(JSON.stringify(trend.inputTokens), JSON.stringify([11, 22, 3, 0, 999, 287]),
      'rolling trend buckets exact boundaries, zero-fills gaps, and crosses midnight');
    eq(JSON.stringify(trend.outputTokens), JSON.stringify([1, 2, 0, 0, 0, 29]),
      'rolling output trend is accumulated separately from input');
    check(!trend.models.some(model => model.model === 'trend-end-excluded'),
      'rolling trend excludes a fact exactly at the window end');
    const trendClaude = trend.models.find(model => model.model === 'claude-opus-4.8') || {};
    eq(JSON.stringify(trendClaude.inputTokens), JSON.stringify([0, 0, 3, 0, 0, 100]),
      'rolling trend merges normalized model variants across buckets');
    check(!usage.models.some(model => model.model === 'before-midnight')
      && trend.models.some(model => model.model === 'before-midnight'),
    'total trend includes visible pre-midnight activity omitted from today model rows');

    const filteredTrend = engine.getTokenTrend(db, trendSinceNano, trendUntilNano, {
      hideUtilityModels: true,
      utilityModels: ['4O'],
    });
    eq(filteredTrend.inputTokens[5], 137,
      'hidden utility models are removed from total trend buckets');
    check(!filteredTrend.models.some(model => model.model.includes('4o')),
      'hidden utility models are removed from model trend rows');

    const trendPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT model FROM token_facts
      WHERE timestamp_unix_nano >= ? AND timestamp_unix_nano < ?
      ORDER BY timestamp_unix_nano ASC
    `).all(trendSinceNano, trendUntilNano);
    check(trendPlan.some(row => String(row.detail ?? '').includes('idx_token_facts_ts')),
      'rolling token trend query uses the timestamp index');

    eq(engine.formatTokenSparkline([0, 0, 0, 0, 0, 0]), '\u2800\u2800\u2800\u2800\u2800\u2800',
      'all-zero token trend preserves bucket width without drawing a baseline');
    eq(engine.formatTokenSparkline([5, 5, 5, 5, 5, 5]), '██████',
      'constant token trend renders a flat line');
    eq(engine.formatTokenSparkline([0, 1, 2, 4, 8, 16]), '\u2800▂▂▃▅█',
      'token trend scales increasing nonzero buckets predictably');
    eq(
      engine.formatTokenSparkline([0, 1, 2, 4, 8, 16]),
      engine.formatTokenSparkline([0, 100, 200, 400, 800, 1600]),
      'input and output trends can use independent scales while preserving shape',
    );

    const trendWindowNow = new Date(2026, 7, 8, 21, 52, 13, 427);
    const trendWindow = engine.getTokenTrendWindow(trendWindowNow);
    eq(
      Number((BigInt(trendWindow.untilNano) - BigInt(trendWindow.sinceNano)) / 1_000_000n),
      12 * hourMs,
      'rolling token trend window always spans twelve elapsed hours',
    );
    const nextHourWindow = engine.getTokenTrendWindow(new Date(trendWindowNow.getTime() + 8 * 60_000));
    check(nextHourWindow.key !== trendWindow.key,
      'rolling token trend key changes at a quiet local-hour rollover');

    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      for (const instant of ['2026-03-08T09:30:00Z', '2026-11-01T09:30:00Z']) {
        const dstWindow = engine.getTokenTrendWindow(new Date(instant));
        eq(
          Number((BigInt(dstWindow.untilNano) - BigInt(dstWindow.sinceNano)) / 1_000_000n),
          12 * hourMs,
          `rolling trend keeps fixed elapsed width across DST near ${instant}`,
        );
      }
    } finally {
      if (originalTz === undefined) { delete process.env.TZ; }
      else { process.env.TZ = originalTz; }
    }

    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT model FROM token_facts
      WHERE timestamp_unix_nano >= ? AND timestamp_unix_nano < ?
      GROUP BY model
    `).all(sinceNano, untilNano);
    check(plan.some(row => String(row.detail ?? '').includes('idx_token_facts_ts')),
      'daily token query uses the token-fact timestamp index');

    const versionBeforeMetrics = store.getTokenFactsVersion();
    store.insertMetrics([]);
    eq(store.getTokenFactsVersion(), versionBeforeMetrics,
      'non-span ingestion does not invalidate the token status cache');

    db.prepare(`
      INSERT INTO token_facts (
        span_id, trace_id, parent_span_id, timestamp_unix_nano, model, operation_name,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        is_additive, facts_v
      ) VALUES (?, ?, NULL, ?, 'stale-v1-model', 'chat', 999, 0, 0, 0, 0, 1)
    `).run(sid(999), '8'.repeat(32), at(50));
    db.prepare('UPDATE token_facts_meta SET facts_v = 1 WHERE id = 1').run();
    store.insertLogs([{
      raw: JSON.stringify({
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'migration-test' } }] },
        scope: { name: 'migration-test' },
        logRecord: { timeUnixNano: at(51), body: { stringValue: 'persist synthetic v1 state' } },
      }),
    }]);
    store.close();
    store = new TelemetryStore(dbPath);
    await store.initialize();
    store.enablePersistence();
    db = store.getDb();
    eq(db.prepare(`SELECT COUNT(*) AS count FROM token_facts WHERE model = 'stale-v1-model'`).get().count, 0,
      'a token-fact version change purges facts that cannot be rebuilt from retained spans');
    eq(db.prepare('SELECT COUNT(DISTINCT facts_v) AS count FROM token_facts').get().count, 1,
      'a token-fact version change rebuilds a single compatible projection version');

    const versionBeforeClear = store.getTokenFactsVersion();
    store.clear();
    eq(db.prepare('SELECT COUNT(*) AS count FROM token_facts').get().count, 0,
      'clear removes durable token facts');
    check(store.getTokenFactsVersion() > versionBeforeClear,
      'clear advances the token fact version');
  } finally {
    try { store.close(); } catch { /* already closed */ }
    cleanup();
  }
}

module.exports = { dailyTokenUsageChecks };
