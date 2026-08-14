'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { check, eq } = require('../lib/assert');
const { ns, sid } = require('../lib/otlp');
const { ANCHOR_SPAN, CONV_ATTR, strAttr } = require('../lib/fixtures');

async function claudeCountingChecks() {
  const dbPath = path.join(os.tmpdir(), `claude-count-${process.pid}-${Date.now()}.db`);
  const cleanup = () => {
    for (const f of [dbPath, `${dbPath}.tmp`, `${dbPath}.sync.tmp`]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  };
  const store = new TelemetryStore(dbPath);
  await store.initialize();

  const CLAUDE_TRACE = 'cd'.repeat(16);
  const span = (spanId, name, parentSpanId, attributes, at) => ({
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
      scope: { name: 'agent-host.test' },
      span: {
        traceId: CLAUDE_TRACE, spanId: sid(spanId),
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
      {
        raw: JSON.stringify({
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'vscode-agent-host' } }] },
          scope: { name: 'agent-host.test' },
          span: {
            traceId: CLAUDE_TRACE, spanId: sid(920), name: ANCHOR_SPAN, kind: 1,
            startTimeUnixNano: ns(920), endTimeUnixNano: ns(925),
            status: { code: 0 }, attributes: [strAttr(CONV_ATTR, 'sess-claude-count')],
          },
        }),
      },
      span(921, 'claude_code.llm_request', 920, [
        strAttr('gen_ai.request.model', 'claude-opus-4-8'),
        { key: 'gen_ai.usage.input_tokens', value: { intValue: '100' } },
      ], 921),
      span(922, 'claude_code.interaction', 920, [], 922),

      // A tool that ran: parent plus both children. Counting the subtree would
      // report three tool calls for one.
      span(923, 'claude_code.tool', 922, [strAttr('tool_name', 'Read')], 923),
      span(924, 'claude_code.tool.blocked_on_user', 923, [], 924),
      span(925, 'claude_code.tool.execution', 923, [], 925),

      // A tool the user denied at the permission prompt: it never executes, so
      // no `.execution` child is emitted. It is still a call the agent made.
      span(926, 'claude_code.tool', 922, [strAttr('tool_name', 'Bash')], 926),
      span(927, 'claude_code.tool.blocked_on_user', 926, [], 927),
    ]);

    const claude = engine.getSessions(db).find(s => s.sessionId === 'sess-claude-count') || {};
    eq(claude.llmRequestCount, 1, 'claude llm request is counted from its own span name');
    eq(claude.toolCallCount, 2,
      'a claude tool call counts once, and a denied call still counts');

    const summary = engine.getSessionSummary(db, 'sess-claude-count') || {};
    const byName = Object.fromEntries((summary.toolStats || []).map(t => [t.toolName, t.count]));
    eq(byName['Read'], 1, 'claude tool rollup names the tool that ran');
    eq(byName['Bash'], 1, 'claude tool rollup names the tool that was denied');
    eq((summary.toolStats || []).length, 2,
      'claude tool rollup breaks calls down by tool rather than by wrapper span');
  } finally {
    try { store.close(); } catch { /* already closed */ }
    cleanup();
  }
}

module.exports = { claudeCountingChecks };
