'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { check, eq } = require('../lib/assert');
const { ns, sid } = require('../lib/otlp');
const { ANCHOR_SPAN, CONV_ATTR, strAttr, COUNT_TRACE } = require('../lib/fixtures');

async function harnessCountingChecks() {
  const dbPath = path.join(os.tmpdir(), `counting-${process.pid}-${Date.now()}.db`);
  const cleanup = () => {
    for (const f of [dbPath, `${dbPath}.tmp`, `${dbPath}.sync.tmp`]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  };
  const store = new TelemetryStore(dbPath);
  await store.initialize();

  /** One span on the shared counting trace. */
  const span = (service, spanId, name, parentSpanId, attributes, at) => ({
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scope: { name: 'agent-host.test' },
      span: {
        traceId: COUNT_TRACE, spanId: sid(spanId),
        ...(parentSpanId ? { parentSpanId: sid(parentSpanId) } : {}),
        name, kind: 1,
        startTimeUnixNano: ns(at), endTimeUnixNano: ns(at + 5),
        status: { code: 0 }, attributes,
      },
    }),
  });

  try {
    const db = store.getDb();

    store.insertSpans([
      span('vscode-agent-host', 900, ANCHOR_SPAN, null, [strAttr(CONV_ATTR, 'sess-count')], 900),

      // Codex: ONE model call, exported as five nested spans that each occur
      // once per call. Counting the chain instead of its head reports 5.
      span('codex-app-server', 901, 'run_turn', 900, [], 901),
      span('codex-app-server', 902, 'run_sampling_request', 901, [], 902),
      span('codex-app-server', 903, 'try_run_sampling_request', 902, [], 903),
      span('codex-app-server', 904, 'stream_request', 903, [], 904),
      span('codex-app-server', 905, 'model_client.stream_responses_api', 904, [], 905),
      span('codex-app-server', 906, 'responses.stream_request', 905, [], 906),

      // Codex: ONE tool call. `build_tool_call` is emitted while assembling the
      // call off the stream and must not be mistaken for the call itself.
      span('codex-app-server', 907, 'handle_output_item_done', 901, [], 907),
      span('codex-app-server', 908, 'build_tool_call', 907, [], 908),
      span('codex-app-server', 909, 'handle_tool_call', 907, [], 909),
      span('codex-app-server', 910, 'handle_tool_call_with_source', 909, [], 910),
      span('codex-app-server', 911, 'exec', 910, [], 911),
      span('codex-app-server', 912, 'dispatch_tool_call_with_terminal_outcome', 911, [], 912),
    ]);

    const codex = engine.getSessions(db).find(s => s.sessionId === 'sess-count') || {};
    eq(codex.llmRequestCount, 1,
      'codex nested sampling chain counts as one llm request, not one per layer');
    eq(codex.toolCallCount, 1,
      'codex tool call is counted once, and build_tool_call is not a tool call');

    const codexSummary = engine.getSessionSummary(db, 'sess-count') || {};
    eq((codexSummary.toolStats || []).length, 1, 'codex session has one tool in its rollup');
    eq((codexSummary.toolStats || [])[0]?.toolName, 'exec',
      'codex tool is named after the executing span, not its wrapper');
  } finally {
    try { store.close(); } catch { /* already closed */ }
    cleanup();
  }
}

module.exports = { harnessCountingChecks };
