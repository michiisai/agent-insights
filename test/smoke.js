/*
 * End-to-end smoke test for the views-over-raw storage model.
 *
 * Exercises the FULL ingest path exactly as a real OTLP exporter would:
 *   real OtlpReceiver HTTP server  ->  parser  ->  TelemetryStore (raw_* tables)
 * then reads back through the REAL engine query functions (which read the
 * spans/metric_points/logs SQL views) and asserts the derived values.
 *
 * This is the check a passing build cannot give: the views fail silently
 * (a wrong json path just yields NULL), so we verify real values come out.
 *
 * Run with:  npm test   (or: node test/smoke.js)
 * No test framework — plain Node assertions. Exit code 0 = pass, 1 = fail.
 */
'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { TelemetryStore, OtlpReceiver } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');

const PORT = 44318; // deliberately not the default 4318 to avoid clashing with a running extension
const HOST = '127.0.0.1';

// ── tiny assertion helpers ────────────────────────────────────────────────────
let pass = 0;
const failures = [];
function check(cond, msg) {
  if (cond) { pass++; } else { failures.push(msg); console.error('  FAIL:', msg); }
}
function eq(actual, expected, msg) {
  check(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ── OTLP payload builders (shapes a real SDK exporter emits over JSON) ─────────
const START = 1_753_120_000_000_000_000n; // ns since epoch
const ns = (ms) => (START + BigInt(ms) * 1_000_000n).toString();

const resource = {
  attributes: [
    { key: 'service.name', value: { stringValue: 'checkout-api' } },
    { key: 'deployment.environment', value: { stringValue: 'prod' } },
  ],
};
const scope = { name: 'my.instrumentation', version: '1.4.0' };

const tracesPayload = {
  resourceSpans: [{
    resource, schemaUrl: 'https://opentelemetry.io/schemas/1.24.0',
    scopeSpans: [{
      scope, schemaUrl: 'https://opentelemetry.io/schemas/1.24.0',
      spans: [
        {
          traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', spanId: '1111111111111111',
          name: 'POST /checkout', kind: 2,
          startTimeUnixNano: ns(0), endTimeUnixNano: ns(128), status: { code: 1 },
          attributes: [
            { key: 'http.method', value: { stringValue: 'POST' } },
            { key: 'http.status_code', value: { intValue: '200' } },
          ],
        },
        {
          traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', spanId: '2222222222222222',
          parentSpanId: '1111111111111111', name: 'chat gpt-4o', kind: 3,
          startTimeUnixNano: ns(12), endTimeUnixNano: ns(96),
          status: { code: 2, message: 'rate limited' },
          attributes: [
            { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } },
            { key: 'gen_ai.usage.input_tokens', value: { intValue: '1024' } },
            { key: 'gen_ai.usage.output_tokens', value: { intValue: '256' } },
            { key: 'gen_ai.input.messages', value: { stringValue: JSON.stringify([
              { role: 'user', parts: [{ type: 'text', content: 'Place my order' }] },
            ]) } },
            { key: 'gen_ai.output.messages', value: { stringValue: JSON.stringify([
              { role: 'assistant', parts: [{ type: 'text', content: 'Order placed.' }], finish_reason: 'stop' },
            ]) } },
          ],
          // Exception recorded as an OTLP span event (semconv), NOT as
          // span-level attributes — getRecentErrorTraces must read it from here.
          events: [{
            name: 'exception', timeUnixNano: ns(90),
            attributes: [
              { key: 'exception.type', value: { stringValue: 'RateLimitError' } },
              { key: 'exception.message', value: { stringValue: 'Too many requests' } },
            ],
          }],
        },
      ],
    }],
  }, {
    // A standalone vscode.lm "utility" call: single-span, parentless root chat
    // with a model but NO session/conversation id. Must be surfaced by
    // getUtilityCalls and EXCLUDED from getSessions (copilot-chat).
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'copilot-chat' } }] },
    scopeSpans: [{
      scope,
      spans: [{
        traceId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', spanId: '3333333333333333',
        name: 'chat gpt-4o-mini', kind: 3,
        startTimeUnixNano: ns(200), endTimeUnixNano: ns(240), status: { code: 1 },
        attributes: [
          { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o-mini' } },
          { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
          { key: 'gen_ai.usage.input_tokens', value: { intValue: '100' } },
          { key: 'gen_ai.usage.output_tokens', value: { intValue: '20' } },
        ],
      }],
    }],
  }, {
    // An agent session spanning TWO traces (turns), each failing — the Sessions
    // tab must surface EVERY failure, not just one representative message.
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'github-copilot' } }] },
    scopeSpans: [{
      scope,
      spans: [
        {
          traceId: 'cccccccccccccccccccccccccccccccc', spanId: '4444444444444444',
          name: 'chat gpt-5', kind: 3,
          startTimeUnixNano: ns(300), endTimeUnixNano: ns(360),
          status: { code: 2, message: 'tool timeout' },
          attributes: [
            { key: 'gen_ai.conversation.id', value: { stringValue: 'sess-multi' } },
            { key: 'gen_ai.request.model', value: { stringValue: 'gpt-5' } },
          ],
        },
        {
          traceId: 'cccccccccccccccccccccccccccccccc', spanId: '4444444444444445',
          parentSpanId: '4444444444444444', name: 'execute_tool bash', kind: 1,
          startTimeUnixNano: ns(310), endTimeUnixNano: ns(350),
          status: { code: 2, message: 'exit code 1' },
          attributes: [{ key: 'gen_ai.tool.name', value: { stringValue: 'bash' } }],
        },
        {
          traceId: 'dddddddddddddddddddddddddddddddd', spanId: '5555555555555555',
          name: 'chat gpt-5', kind: 3,
          startTimeUnixNano: ns(400), endTimeUnixNano: ns(470),
          status: { code: 2, message: 'context length exceeded' },
          attributes: [
            { key: 'gen_ai.conversation.id', value: { stringValue: 'sess-multi' } },
            { key: 'gen_ai.request.model', value: { stringValue: 'gpt-5' } },
          ],
        },
      ],
    }],
  }],
};

const metricsPayload = {
  resourceMetrics: [{
    resource,
    scopeMetrics: [{
      scope,
      metrics: [
        {
          name: 'gen_ai.client.token.usage', unit: '{token}',
          sum: {
            aggregationTemporality: 2, isMonotonic: true,
            dataPoints: [{
              asInt: '1280', startTimeUnixNano: ns(0), timeUnixNano: ns(128),
              attributes: [{ key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } }],
            }],
          },
        },
        {
          name: 'process.runtime.memory', unit: 'By',
          gauge: {
            dataPoints: [{
              asDouble: 734003200.5, timeUnixNano: ns(128),
              attributes: [{ key: 'state', value: { stringValue: 'used' } }],
            }],
          },
        },
        {
          // Cumulative counter observed across a RESTART: the same attribute set
          // accumulates to 12, the process restarts (new startTimeUnixNano) and
          // the counter restarts from zero, climbing to 9. Lifetime total is
          // 12 + 9 = 21; keying series by attributes alone would report only 9.
          name: 'test.counter.resets', unit: '{call}',
          sum: {
            aggregationTemporality: 2, isMonotonic: true,
            dataPoints: [
              { asInt: '5',  startTimeUnixNano: ns(0),  timeUnixNano: ns(10), attributes: [{ key: 'tool', value: { stringValue: 'edit' } }] },
              { asInt: '12', startTimeUnixNano: ns(0),  timeUnixNano: ns(20), attributes: [{ key: 'tool', value: { stringValue: 'edit' } }] },
              { asInt: '3',  startTimeUnixNano: ns(30), timeUnixNano: ns(40), attributes: [{ key: 'tool', value: { stringValue: 'edit' } }] },
              { asInt: '9',  startTimeUnixNano: ns(30), timeUnixNano: ns(50), attributes: [{ key: 'tool', value: { stringValue: 'edit' } }] },
            ],
          },
        },
      ],
    }],
  }],
};

const logsPayload = {
  resourceLogs: [{
    resource,
    scopeLogs: [{
      scope,
      logRecords: [
        {
          timeUnixNano: ns(90), observedTimeUnixNano: ns(91),
          severityNumber: 17, severityText: 'ERROR',
          body: { stringValue: 'OpenAI request failed: rate limited' },
          traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', spanId: '2222222222222222',
          attributes: [{ key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } }],
        },
        {
          timeUnixNano: ns(130), severityNumber: 9, severityText: 'INFO',
          body: { stringValue: 'checkout completed' },
          attributes: [{ key: 'order.id', value: { stringValue: 'ord_123' } }],
        },
      ],
    }],
  }],
};

// ── HTTP POST helper (mimics an OTLP/HTTP exporter) ───────────────────────────
function post(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      { host: HOST, port: PORT, path: urlPath, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  const dbPath = path.join(os.tmpdir(), `agent-smoke-${process.pid}-${Date.now()}.db`);
  const store = new TelemetryStore(dbPath);
  await store.initialize();
  const receiver = new OtlpReceiver(store, PORT);
  await receiver.start();

  try {
    // 1) Ingest exactly like an exporter: POST over HTTP.
    const rt = await post('/v1/traces', tracesPayload);
    const rm = await post('/v1/metrics', metricsPayload);
    const rl = await post('/v1/logs', logsPayload);
    eq(rt.status, 200, 'POST /v1/traces returns 200');
    eq(rm.status, 200, 'POST /v1/metrics returns 200');
    eq(rl.status, 200, 'POST /v1/logs returns 200');

    // Idempotency: re-POST traces; span dedupe (INSERT OR IGNORE) must keep 2 spans.
    await post('/v1/traces', tracesPayload);

    const db = store.getDb();

    // 2) Services derive from resource.attributes via the view.
    const services = engine.getServices(db);
    check(services.includes('checkout-api'), `getServices includes checkout-api (got ${JSON.stringify(services)})`);

    // 3) Traces aggregate + error detection.
    const traces = engine.getTraces(db);
    eq(traces.length, 4, 'getTraces returns 4 traces (checkout + utility + 2 agent turns, dedupe held)');
    const tr = traces.find(t => t.traceId === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') || {};
    eq(tr.spanCount, 2, 'trace has 2 spans');
    eq(tr.serviceName, 'checkout-api', 'trace service_name derived');
    eq(tr.rootSpanName, 'POST /checkout', 'root span name derived');
    eq(tr.hasError, true, 'trace flagged as error (child status_code=2)');
    // root duration = (128 - 0) ms
    eq(tr.durationMs, 128, 'root duration_ms derived from nanos');

    // 4) Spans by trace: attributes rebuilt to flat dotted-key JSON + raw preserved.
    const spans = engine.getSpansByTraceId(db, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    eq(spans.length, 2, 'getSpansByTraceId returns 2 spans');
    const child = spans.find(s => s.spanId === '2222222222222222') || {};
    eq(child.attributes && child.attributes['gen_ai.request.model'], 'gpt-4o', 'flat attribute json_extract works');
    eq(child.attributes && child.attributes['gen_ai.usage.input_tokens'], 1024, 'int attribute typed as number in flat view');
    eq(child.durationMs, 84, 'child duration_ms = 84');
    // raw hydration preserves the full event (events array survives).
    const rawEvents = child.raw && child.raw.span && child.raw.span.events;
    check(Array.isArray(rawEvents) && rawEvents[0] && rawEvents[0].name === 'exception',
      'raw span preserves events array (lossless)');

    // 4b) Search filter: a term found on a nested span (name or attribute
    // value), not on the trace id / root span name, still includes the trace
    // in the results — the waterfall highlights *where* it matched on expand.
    const byName = engine.getTraces(db, { nameSearch: 'gpt-4o' });
    check(byName.some(t => t.traceId === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      'nameSearch matches a nested span name');

    const byAttr = engine.getTraces(db, { nameSearch: 'Place my order' });
    check(byAttr.some(t => t.traceId === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      'nameSearch matches a nested span attribute value');

    const byRoot = engine.getTraces(db, { nameSearch: 'checkout' });
    check(byRoot.some(t => t.traceId === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      'nameSearch matches the root span name');

    // 5) Metrics dashboard: token usage + summary counts through the views.
    const md = engine.getMetricsData(db);
    const gpt = md.tokenUsage.find(t => t.model === 'gpt-4o') || {};
    eq(gpt.promptTokens, 1024, 'token usage prompt_tokens aggregated');
    eq(gpt.completionTokens, 256, 'token usage completion_tokens aggregated');
    eq(md.summary.totalSpans, 6, 'summary.totalSpans');
    eq(md.summary.totalTraces, 4, 'summary.totalTraces');
    eq(md.summary.totalLogs, 2, 'summary.totalLogs');
    eq(md.summary.totalMetricPoints, 6, 'summary.totalMetricPoints (gauge + sum data points)');
    eq(md.summary.errorTraces, 3, 'summary.errorTraces');
    eq(md.summary.llmCalls, 4, 'summary.llmCalls');
    eq(md.summary.inputTokens, 1124, 'summary.inputTokens');
    eq(md.summary.outputTokens, 276, 'summary.outputTokens');

    // 5b) Cumulative counter resets: a series run is (attributes, startTimeUnixNano),
    // so a restart begins a new run instead of discarding the completed one.
    const resetSvc = 'checkout-api';
    const resets = engine.getMetricDetail(db, 'test.counter.resets', resetSvc);
    check(resets.isCumulative, 'reset counter detected as cumulative');
    eq(resets.stats.seriesCount, 1, 'reset counter has a single attribute set');
    eq(resets.stats.total, 21, 'cumulative total sums per-run finals across a restart (12 + 9)');

    // Window starting after the first run ended: only the second run contributes.
    eq(engine.getMetricDetail(db, 'test.counter.resets', resetSvc, ns(25)).stats.total, 9,
      'windowed total counts a run with no pre-window baseline in full');
    // Window splitting the first run: 12-5 accrued in-window, plus all of run two.
    eq(engine.getMetricDetail(db, 'test.counter.resets', resetSvc, ns(15)).stats.total, 16,
      'windowed total subtracts the per-run baseline ((12-5) + 9)');

    // 6) Logs read back with derived columns.
    const logs = engine.getLogs(db);
    eq(logs.length, 2, 'getLogs returns 2 logs');
    const errLog = logs.find(l => l.severityText === 'ERROR') || {};
    check((errLog.body || '').includes('rate limited'), 'error log body derived');
    eq(errLog.attributes && errLog.attributes['gen_ai.request.model'], 'gpt-4o', 'log flat attribute derived');
    eq(errLog.traceId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'log trace_id derived');

    // 7) Error traces with exception details pulled from flat attributes.
    const errTraces = engine.getRecentErrorTraces(db);
    eq(errTraces.length, 3, 'getRecentErrorTraces returns 3');
    const checkoutErr = errTraces.find(t => t.traceId === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') || {};
    const es = (checkoutErr.errorSpans && checkoutErr.errorSpans[0]) || {};
    eq(es.exceptionType, 'RateLimitError', 'error span exception.type derived from event attributes');
    eq(es.exceptionMessage, 'Too many requests', 'error span exception.message derived from event attributes');

    // 8) Per-service summary.
    const svc = engine.getServiceSummary(db, 'checkout-api');
    check(svc != null, 'getServiceSummary returns a summary');
    if (svc) {
      eq(svc.totalSpans, 2, 'service summary totalSpans');
      eq(svc.errorSpans, 1, 'service summary errorSpans');
      const svcGpt = svc.tokenUsage.find(t => t.model === 'gpt-4o') || {};
      eq(svcGpt.promptTokens, 1024, 'service summary token usage');
    }

    // 9) Utility / LM-API calls: the single-span parentless chat with no session
    // id is classified as utility (surfaced on Home), aggregated by model.
    const uc = engine.getUtilityCalls(db);
    eq(uc.totalCalls, 1, 'getUtilityCalls totalCalls (only the standalone chat)');
    eq(uc.totalTokens, 120, 'getUtilityCalls totalTokens (100 in + 20 out)');
    eq(uc.byModel.length, 1, 'getUtilityCalls one model bucket');
    const ucm = uc.byModel[0] || {};
    eq(ucm.model, 'gpt-4o-mini', 'utility model name kept verbatim');
    eq(ucm.callCount, 1, 'utility model callCount');
    eq(ucm.totalTokens, 120, 'utility model totalTokens');
    const ucCall = uc.calls[0] || {};
    eq(ucCall.traceId, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'utility call trace id (drill-down target)');
    eq(ucCall.inputTokens, 100, 'utility call inputTokens');
    eq(ucCall.outputTokens, 20, 'utility call outputTokens');
    // The multi-span checkout trace and its child chat are NOT utility calls.
    check(uc.calls.every(c => c.traceId !== 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      'multi-span agent trace excluded from utility calls');

    // 10) Sessions must EXCLUDE the utility call (copilot-chat / no session id).
    const sessions = engine.getSessions(db);
    check(sessions.every(s => s.serviceName !== 'copilot-chat'),
      'getSessions excludes copilot-chat utility calls');
    check(sessions.every(s => s.sessionId !== 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      'utility trace does not appear as a session');

    // 11) getSessionSummary: full breakdown for one session (the checkout trace,
    // whose session id falls back to its trace id since it carries no conv id).
    const summary = engine.getSessionSummary(db, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    check(summary != null, 'getSessionSummary returns a summary');
    eq(summary.sessionId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'session summary sessionId');
    eq(summary.serviceName, 'checkout-api', 'session summary serviceName');
    check(summary.hasError === true, 'session summary hasError');
    eq(summary.failureReason, 'rate limited', 'session summary failureReason');
    eq(summary.traceCount, 1, 'session summary traceCount');
    eq(summary.llmRequestCount, 1, 'session summary llmRequestCount');
    eq(summary.totalTokens, 1280, 'session summary totalTokens');
    eq(summary.inputTokens, 1024, 'session summary inputTokens');
    eq(summary.outputTokens, 256, 'session summary outputTokens');
    eq(summary.turns.length, 1, 'session summary has one turn');
    eq(summary.turns[0].rootName, 'POST /checkout', 'session summary turn rootName');
    check(summary.modelTokens.some(m => m.model === 'gpt-4o' && m.totalTokens === 1280),
      'session summary modelTokens includes gpt-4o');
    check(summary.errors.some(e => e.statusMessage === 'rate limited'),
      'session summary surfaces the errored span');
    check(engine.getSessionSummary(db, 'nonexistent-session') === null,
      'getSessionSummary returns null for unknown session');
    check(engine.getSessionSummary(db, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') === null,
      'getSessionSummary excludes copilot-chat utility trace');

    // 12) getSessionMessages: captured conversation turns for the checkout session.
    const msgs = engine.getSessionMessages(db, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    check(msgs != null, 'getSessionMessages returns data');
    eq(msgs.sessionId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'session messages sessionId');
    check(msgs.captureEnabled === true, 'session messages captureEnabled when content present');
    eq(msgs.turns.length, 1, 'session messages has one captured turn');
    eq(msgs.turns[0].model, 'gpt-4o', 'session messages turn model');
    eq(msgs.turns[0].spanId, '2222222222222222', 'session messages turn spanId');
    check(msgs.turns[0].hasError === true, 'session messages turn surfaces error status');
    check(msgs.turns[0].outputMessages.includes('Order placed.'),
      'session messages carries raw output messages JSON');
    eq(msgs.turns[0].inputPreview, 'Place my order', 'session messages extracts last user prompt');
    check(engine.getSessionMessages(db, 'nonexistent-session') === null,
      'getSessionMessages returns null for unknown session');
    check(engine.getSessionMessages(db, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') === null,
      'getSessionMessages excludes copilot-chat utility trace');

    // 13) A session that fails in MULTIPLE traces must list EVERY failure, not
    // just one representative message (Sessions tab summary card).
    const multi = sessions.find(s => s.sessionId === 'sess-multi') || {};
    eq(multi.traceCount, 2, 'multi-failure session spans 2 traces');
    eq(multi.errorCount, 3, 'multi-failure session errorCount counts every errored span');
    eq((multi.failures || []).length, 3, 'multi-failure session lists all 3 failures');
    const multiMsgs = (multi.failures || []).map(f => f.message).sort();
    check(multiMsgs.join('|') === ['context length exceeded', 'exit code 1', 'tool timeout'].sort().join('|'),
      `multi-failure session surfaces every failure message (got ${JSON.stringify(multiMsgs)})`);
    check((multi.failures || []).some(f => f.traceId === 'cccccccccccccccccccccccccccccccc')
      && (multi.failures || []).some(f => f.traceId === 'dddddddddddddddddddddddddddddddd'),
      'failures carry the trace they happened in');

    const multiSummary = engine.getSessionSummary(db, 'sess-multi') || {};
    eq((multiSummary.failures || []).length, 3, 'session summary lists all 3 failures');
    eq(multiSummary.errorCount, 3, 'session summary errorCount');
    eq((multiSummary.turns || []).length, 2, 'session summary has both failing turns');
    check((multiSummary.turns || []).every(t => t.hasError && t.errorCount > 0),
      'each failing turn reports its own error count');
    const turnC = (multiSummary.turns || []).find(t => t.traceId === 'cccccccccccccccccccccccccccccccc') || {};
    eq((turnC.failures || []).length, 2, 'turn with two errored spans lists both failures');
    check((multiSummary.errors || []).every(e => !!e.traceId),
      'session summary error details carry a trace id');
  } finally {
    await receiver.stop();
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }

  const total = pass + failures.length;
  if (failures.length) {
    console.error(`\nSMOKE TEST FAILED: ${failures.length}/${total} assertions failed`);
    process.exit(1);
  }
  console.log(`\nSMOKE TEST PASSED: ${pass}/${total} assertions`);
  process.exit(0);
})().catch((err) => {
  console.error('SMOKE TEST ERROR:', err);
  process.exit(1);
});
