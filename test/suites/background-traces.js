'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { check, eq } = require('../lib/assert');
const { ns, sid } = require('../lib/otlp');
const { nativeSpan, CONV_ATTR } = require('../lib/fixtures');

async function backgroundTraceChecks() {
  const dbPath = path.join(os.tmpdir(), `bg-traces-${process.pid}-${Date.now()}.db`);
  const cleanup = () => {
    for (const f of [dbPath, `${dbPath}.tmp`, `${dbPath}.sync.tmp`]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  };

  const store = new TelemetryStore(dbPath);
  await store.initialize();

  try {
    const db = store.getDb();

    const bgTrace = (i) => String(i).padStart(32, '7');
    /** One housekeeping span on its own trace: no conversation id, no activity. */
    const housekeeping = (i, name) => ({
      raw: JSON.stringify({
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'codex-app-server' } }] },
        scope: { name: 'bg.test' },
        span: {
          traceId: bgTrace(i), spanId: sid(700 + i), name, kind: 1,
          startTimeUnixNano: ns(700 + i), endTimeUnixNano: ns(701 + i),
          status: { code: 0 }, attributes: [],
        },
      }),
    });

    store.insertSpans([
      housekeeping(1, 'load_with_cli_overrides'),
      housekeeping(2, 'list_models'),
      housekeeping(3, 'skills/list'),
      // A keyed session, to prove the filter is about evidence and not service.
      nativeSpan('codex-app-server', 750, 'chat gpt-5-codex', null, [
        { key: CONV_ATTR, value: { stringValue: 'sess-codex' } },
        { key: 'gen_ai.request.model', value: { stringValue: 'gpt-5-codex' } },
      ], 750),
    ]);

    // A trace with NO conversation key that nonetheless did real work — the
    // shape of a real session whose host anchor was pruned by retention or never
    // arrived. It must survive, or collapsing would lose a real conversation.
    store.insertSpans([{
      raw: JSON.stringify({
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'codex-app-server' } }] },
        scope: { name: 'bg.test' },
        span: {
          traceId: bgTrace(9), spanId: sid(760), name: 'handle_responses', kind: 1,
          startTimeUnixNano: ns(760), endTimeUnixNano: ns(770), status: { code: 0 },
          attributes: [{ key: 'gen_ai.usage.input_tokens', value: { intValue: '25276' } }],
        },
      }),
    }]);

    const ids = engine.getSessions(db).map(s => s.sessionId);
    check(ids.includes('sess-codex'), 'a keyed codex session is listed');
    check(ids.includes(bgTrace(9)),
      'an unkeyed trace that did real work is kept, not collapsed');
    eq(ids.length, 2, 'housekeeping traces do not become sessions');
    for (let i = 1; i <= 3; i++) {
      check(!ids.includes(bgTrace(i)), `housekeeping trace ${i} is collapsed out of Sessions`);
    }

    const bg = engine.getBackgroundTraceStats(db);
    eq(bg.traceCount, 3, 'background traces are classified as background, not as sessions');
    eq(bg.spanCount, 3, 'background span count is reported');
    check(bg.serviceNames.includes('codex-app-server'), 'background stats name the producing service');

    // Nothing is deleted: the Traces tab has no session filter and still shows them.
    const traceIds = engine.getTraces(db).map(t => t.traceId);
    for (let i = 1; i <= 3; i++) {
      check(traceIds.includes(bgTrace(i)), `collapsed trace ${i} remains browsable in Traces`);
    }

    // Deep links must still resolve a collapsed trace rather than 404.
    check(engine.getSessionSummary(db, bgTrace(1)) !== null,
      'a collapsed trace is still reachable by direct session lookup');
  } finally {
    try { store.close(); } catch { /* already closed */ }
    cleanup();
  }
}

module.exports = { backgroundTraceChecks };
