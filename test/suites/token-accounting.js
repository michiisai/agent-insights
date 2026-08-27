'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { eq } = require('../lib/assert');
const { sid } = require('../lib/otlp');
const { tokenFactSpan } = require('../lib/fixtures');

async function harnessTokenAccountingChecks() {
  const dbPath = path.join(os.tmpdir(), `harness-token-accounting-${process.pid}-${Date.now()}.db`);
  const cleanup = () => {
    for (const file of [dbPath, `${dbPath}.tmp`, `${dbPath}.sync.tmp`]) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  };
  const store = new TelemetryStore(dbPath);
  await store.initialize();
  store.enablePersistence();

  try {
    const now = new Date();
    const startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const sinceNano = `${startMs}000000`;
    const untilNano = `${startMs + 24 * 60 * 60 * 1000}000000`;
    const at = (offsetMs) => `${startMs + offsetMs}000000`;
    const numAttr = (key, value) => ({ key, value: { intValue: String(value) } });
    const opAttr = (value) => ({ key: 'gen_ai.operation.name', value: { stringValue: value } });
    const modelAttr = (value) => ({ key: 'gen_ai.request.model', value: { stringValue: value } });

    store.insertSpans([
      tokenFactSpan({
        spanId: sid(1000),
        traceId: '1'.repeat(32),
        name: 'chat gpt-test',
        timestamp: at(10),
        attributes: [
          opAttr('chat'),
          modelAttr('gpt-test'),
          numAttr('gen_ai.usage.input_tokens', 100),
          numAttr('gen_ai.usage.output_tokens', 10),
          numAttr('gen_ai.usage.cache_read.input_tokens', 60),
          numAttr('gen_ai.usage.cache_creation.input_tokens', 30),
        ],
      }),
      tokenFactSpan({
        spanId: sid(1001),
        traceId: '1'.repeat(32),
        name: 'invoke_agent',
        timestamp: at(11),
        attributes: [
          opAttr('invoke_agent'),
          modelAttr('gpt-test'),
          numAttr('gen_ai.usage.input_tokens', 100),
          numAttr('gen_ai.usage.output_tokens', 10),
          numAttr('gen_ai.usage.cache_read.input_tokens', 60),
          numAttr('gen_ai.usage.cache_creation.input_tokens', 30),
        ],
      }),
      tokenFactSpan({
        spanId: sid(1002),
        traceId: '2'.repeat(32),
        name: 'claude_code.llm_request',
        service: 'claude-code',
        timestamp: at(20),
        attributes: [
          modelAttr('claude-sonnet-5'),
          numAttr('input_tokens', 2),
          numAttr('output_tokens', 5),
          numAttr('cache_read_tokens', 70),
          numAttr('cache_creation_tokens', 20),
        ],
      }),
      tokenFactSpan({
        spanId: sid(1003),
        traceId: '3'.repeat(32),
        name: 'run_sampling_request',
        service: 'codex-app-server',
        timestamp: at(30),
        attributes: [{ key: 'model', value: { stringValue: 'gpt-5.6-sol' } }],
      }),
      tokenFactSpan({
        spanId: sid(1004),
        traceId: '3'.repeat(32),
        parentSpanId: sid(1003),
        name: 'receiving_stream',
        service: 'codex-app-server',
        timestamp: at(31),
        attributes: [],
      }),
      tokenFactSpan({
        spanId: sid(1005),
        traceId: '3'.repeat(32),
        parentSpanId: sid(1004),
        name: 'handle_responses',
        service: 'codex-app-server',
        timestamp: at(32),
        attributes: [
          numAttr('gen_ai.usage.input_tokens', 100),
          numAttr('gen_ai.usage.output_tokens', 20),
          numAttr('gen_ai.usage.cache_read.input_tokens', 60),
          numAttr('gen_ai.usage.cache_write.input_tokens', 30),
          numAttr('codex.usage.reasoning_output_tokens', 5),
        ],
      }),
      tokenFactSpan({
        spanId: sid(1006),
        traceId: '3'.repeat(32),
        name: 'session_task.turn',
        service: 'codex-app-server',
        timestamp: at(33),
        attributes: [
          { key: 'model', value: { stringValue: 'gpt-5.6-sol' } },
          numAttr('codex.turn.token_usage.input_tokens', 100),
          numAttr('codex.turn.token_usage.output_tokens', 20),
          numAttr('codex.turn.token_usage.cache_write_input_tokens', 30),
          numAttr('codex.turn.token_usage.reasoning_output_tokens', 5),
        ],
      }),
    ]);

    const db = store.getDb();
    const facts = db.prepare(`
      SELECT model, input_tokens, output_tokens, cache_read_tokens,
             cache_creation_tokens, is_additive
      FROM token_facts
      ORDER BY model
    `).all();
    eq(facts.length, 3, 'token facts keep request leaves and exclude Copilot/Codex rollups');

    const codexFact = facts.find(fact => fact.model === 'gpt-5.6-sol') || {};
    eq(codexFact.input_tokens, 100, 'Codex prompt input already includes cache reads and writes');
    eq(codexFact.cache_read_tokens, 60, 'Codex cache reads are projected');
    eq(codexFact.cache_creation_tokens, 30, 'Codex cache_write is projected as cache creation');
    eq(codexFact.is_additive, 0, 'Codex cache writes remain subset-style accounting');

    const usage = engine.getDailyTokenUsage(db, sinceNano, untilNano);
    eq(usage.inputTokens, 292, 'daily input applies standard Copilot/Codex and additive Claude accounting');
    eq(usage.cachedTokens, 190, 'daily cache reads aggregate across all three harnesses');
    eq(usage.outputTokens, 35, 'daily output excludes rollup duplicates');
    eq(usage.callCount, 3, 'daily calls count one request leaf per harness');
    eq(Math.round(usage.cacheHitRate * 1000), 651, 'daily cache hit rate uses total convention-aware prompt volume');

    const analytics = engine.getAgentAnalytics(db);
    eq(analytics.summary.inputTokens, 292, 'Home input matches convention-aware daily input');
    eq(analytics.summary.outputTokens, 35, 'Home output excludes rollup duplicates');
    eq(analytics.summary.cachedTokens, 190, 'Home cache reads match daily cache reads');
    eq(analytics.summary.cacheCreationTokens, 80, 'Home cache writes include Copilot, Claude, and Codex');
    eq(analytics.summary.llmCalls, 3, 'Home LLM calls exclude Copilot and Codex rollups');
    eq(Math.round(analytics.summary.cacheHitRate * 1000), 651, 'Home cache hit rate matches daily status');

    const byModel = Object.fromEntries(analytics.tokenUsage.map(model => [model.model, model]));
    eq(byModel['gpt-test']?.promptTokens, 100, 'Copilot model input is not expanded by subset cache fields');
    eq(byModel['claude-sonnet-5']?.promptTokens, 92, 'Claude model input includes additive cache fields');
    eq(byModel['gpt-5.6-sol']?.promptTokens, 100, 'Codex model is inherited from the nearest sampling ancestor');
    eq(byModel['gpt-5.6-sol']?.cacheCreationTokens, 30, 'Codex model reports per-call cache writes');

    const copilot = engine.getServiceSummary(db, 'github-copilot') || {};
    eq(copilot.tokenUsage?.[0]?.callCount, 1, 'Copilot service summary excludes invoke_agent rollups');
    eq(copilot.tokenUsage?.[0]?.promptTokens, 100, 'Copilot service summary uses standard input accounting');
    const claude = engine.getServiceSummary(db, 'claude-code') || {};
    eq(claude.tokenUsage?.[0]?.promptTokens, 92, 'Claude service summary uses additive input accounting');
    const codex = engine.getServiceSummary(db, 'codex-app-server') || {};
    eq(codex.tokenUsage?.[0]?.model, 'gpt-5.6-sol', 'Codex service summary inherits its request model');
    eq(codex.tokenUsage?.[0]?.promptTokens, 100, 'Codex service summary excludes turn rollups');
  } finally {
    try { store.close(); } catch { /* already closed */ }
    cleanup();
  }
}

module.exports = { harnessTokenAccountingChecks };
