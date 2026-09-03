'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { TelemetryStore } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { eq } = require('../lib/assert');
const { sid } = require('../lib/otlp');
const { providerSpan, strAttr, CONV_ATTR } = require('../lib/fixtures');

async function copilotSubagentChecks() {
  const dbPath = path.join(os.tmpdir(), `copilot-subagents-${process.pid}-${Date.now()}.db`);
  const cleanup = () => {
    for (const file of [dbPath, `${dbPath}.tmp`, `${dbPath}.sync.tmp`]) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  };

  const sessionId = 'sess-copilot-subagents';
  const traceId = 'da'.repeat(16);
  const messages = text => JSON.stringify([
    { role: 'assistant', parts: [{ type: 'text', content: text }] },
  ]);
  const modelAttrs = output => [
    strAttr(CONV_ATTR, sessionId),
    strAttr('gen_ai.request.model', 'gpt-5'),
    strAttr('gen_ai.output.messages', messages(output)),
  ];

  const store = new TelemetryStore(dbPath);
  await store.initialize();

  try {
    store.insertSpans([
      providerSpan(traceId, 'github-copilot', 1000, 'invoke_agent', null, [
        strAttr(CONV_ATTR, sessionId),
        strAttr('gen_ai.operation.name', 'invoke_agent'),
        strAttr('gen_ai.agent.name', 'Explore'),
      ], 1000),
      providerSpan(traceId, 'github-copilot', 1001, 'chat gpt-5', 1000,
        modelAttrs('Delegated result.'), 1001),
      providerSpan(traceId, 'github-copilot', 1002, 'chat gpt-5', null,
        modelAttrs('Main-agent result.'), 1002),
      providerSpan(traceId, 'github-copilot', 1003, 'workflow', null, [
        strAttr(CONV_ATTR, sessionId),
        strAttr('gen_ai.agent.name', 'Not a delegation'),
      ], 1003),
      providerSpan(traceId, 'github-copilot', 1004, 'chat gpt-5', 1003,
        modelAttrs('Ordinary child result.'), 1004),
    ]);

    const turns = (engine.getSessionMessages(store.getDb(), sessionId) || {}).turns || [];
    const bySpan = new Map(turns.map(turn => [turn.spanId, turn]));
    const delegated = bySpan.get(sid(1001)) || {};
    const main = bySpan.get(sid(1002)) || {};
    const ordinaryChild = bySpan.get(sid(1004)) || {};

    eq(turns.length, 3, 'the rollup parent does not become a duplicate model turn');
    eq(delegated.isSubagent, true, 'a model call under a named invoke_agent is delegated');
    eq(delegated.subagentType, 'Explore', 'the delegated turn keeps its agent name');
    eq(main.isSubagent, false, 'a root model call remains main-agent work');
    eq(main.subagentType, null, 'main-agent work has no subagent type');
    eq(ordinaryChild.isSubagent, false,
      'an agent name on a non-invoke parent does not misclassify its child');
  } finally {
    try { store.close(); } catch { /* already closed */ }
    cleanup();
  }
}

module.exports = { copilotSubagentChecks };
