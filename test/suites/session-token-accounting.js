'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { eq } = require('../lib/assert');
const { ANCHOR_SPAN, CONV_ATTR, strAttr, providerSpan } = require('../lib/fixtures');

const CODEX_TRACE = 'a1'.repeat(16);
const COPILOT_TRACE = 'b2'.repeat(16);

async function sessionTokenAccountingChecks() {
  const dbPath = path.join(os.tmpdir(), `session-tokens-${process.pid}-${Date.now()}.db`);
  const cleanup = () => {
    for (const f of [dbPath, `${dbPath}.tmp`, `${dbPath}.sync.tmp`]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  };
  const store = new TelemetryStore(dbPath);
  await store.initialize();
  const num = (key, value) => ({ key, value: { intValue: String(value) } });

  try {
    const db = store.getDb();

    store.insertSpans([
      // Codex: only `handle_responses` carries the counts, and it names no
      // model — that comes from the sampling ancestor three levels up.
      providerSpan(CODEX_TRACE, 'vscode-agent-host', 800, ANCHOR_SPAN, null,
        [strAttr(CONV_ATTR, 'sess-codex')], 800),
      providerSpan(CODEX_TRACE, 'codex-app-server', 801, 'session_task.turn', 800, [
        strAttr('model', 'gpt-5.6-sol'),
        // The turn's own roll-up of every call below it.
        num('codex.turn.token_usage.input_tokens', 100),
        num('codex.turn.token_usage.output_tokens', 20),
      ], 801),
      providerSpan(CODEX_TRACE, 'codex-app-server', 802, 'run_sampling_request', 801,
        [strAttr('model', 'gpt-5.6-sol')], 802),
      providerSpan(CODEX_TRACE, 'codex-app-server', 803, 'try_run_sampling_request', 802, [], 803),
      providerSpan(CODEX_TRACE, 'codex-app-server', 804, 'receiving_stream', 803, [], 804),
      providerSpan(CODEX_TRACE, 'codex-app-server', 805, 'handle_responses', 804, [
        num('gen_ai.usage.input_tokens', 100),
        num('gen_ai.usage.output_tokens', 20),
      ], 805),

      // Copilot: `invoke_agent` reports the subagent's totals as an exact
      // roll-up of the `chat` spans nested under it, in the same trace.
      providerSpan(COPILOT_TRACE, 'vscode-agent-host', 810, ANCHOR_SPAN, null,
        [strAttr(CONV_ATTR, 'sess-copilot')], 810),
      providerSpan(COPILOT_TRACE, 'github-copilot', 811, 'chat gpt-test', 810, [
        strAttr('gen_ai.operation.name', 'chat'),
        strAttr('gen_ai.request.model', 'gpt-test'),
        num('gen_ai.usage.input_tokens', 400),
        num('gen_ai.usage.output_tokens', 40),
      ], 811),
      providerSpan(COPILOT_TRACE, 'github-copilot', 812, 'invoke_agent', 810, [
        strAttr('gen_ai.operation.name', 'invoke_agent'),
        strAttr('gen_ai.request.model', 'gpt-test'),
        num('gen_ai.usage.input_tokens', 300),
        num('gen_ai.usage.output_tokens', 30),
      ], 812),
      providerSpan(COPILOT_TRACE, 'github-copilot', 813, 'chat gpt-test', 812, [
        strAttr('gen_ai.operation.name', 'chat'),
        strAttr('gen_ai.request.model', 'gpt-test'),
        num('gen_ai.usage.input_tokens', 200),
        num('gen_ai.usage.output_tokens', 20),
      ], 813),
      providerSpan(COPILOT_TRACE, 'github-copilot', 814, 'chat gpt-test', 812, [
        strAttr('gen_ai.operation.name', 'chat'),
        strAttr('gen_ai.request.model', 'gpt-test'),
        num('gen_ai.usage.input_tokens', 100),
        num('gen_ai.usage.output_tokens', 10),
      ], 814),
    ]);

    const codexList = engine.getSessions(db).find(s => s.sessionId === 'sess-codex') || {};
    eq(codexList.totalTokens, 120, 'codex session total counts the call once, not the turn rollup too');

    const codex = engine.getSessionSummary(db, 'sess-codex') || {};
    eq(codex.totalTokens, 120, 'codex summary total matches the session list');
    eq(codex.inputTokens, 100, 'codex input comes from handle_responses, not the empty sampling span');
    eq(codex.outputTokens, 20, 'codex output comes from handle_responses');
    eq((codex.modelTokens || []).length, 1, 'codex reports a single model');
    eq(codex.modelTokens?.[0]?.model, 'gpt-5.6-sol',
      'codex model is inherited from the nearest sampling ancestor');
    eq(codex.modelTokens?.[0]?.totalTokens, 120, 'codex model row carries the call tokens');
    eq(codex.modelTokens?.[0]?.callCount, 1, 'codex counts one call for the nested sampling chain');

    const copilotList = engine.getSessions(db).find(s => s.sessionId === 'sess-copilot') || {};
    eq(copilotList.totalTokens, 770, 'copilot session total excludes the invoke_agent rollup');

    const copilot = engine.getSessionSummary(db, 'sess-copilot') || {};
    eq(copilot.totalTokens, 770, 'copilot summary total excludes the invoke_agent rollup');
    eq(copilot.inputTokens, 700, 'copilot input counts each subagent call once');
    eq(copilot.outputTokens, 70, 'copilot output counts each subagent call once');
    eq(copilot.modelTokens?.[0]?.callCount, 3,
      'copilot counts the parent and both subagent calls, and never the rollup');
  } finally {
    try { store.close(); } catch { /* already closed */ }
    cleanup();
  }
}

module.exports = { sessionTokenAccountingChecks };
