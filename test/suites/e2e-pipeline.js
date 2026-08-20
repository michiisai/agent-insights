'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore, OtlpReceiver } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { check, eq } = require('../lib/assert');
const { PORT, ns, post } = require('../lib/otlp');

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
            { key: 'gen_ai.output.messages', value: { stringValue: JSON.stringify([{
              role: 'assistant',
              parts: [
                { type: 'tool_call', id: 'bash-call', name: 'bash', arguments: { command: 'false' } },
                { type: 'tool_call_response', id: 'bash-call', response: 'exit code 1' },
              ],
            }]) } },
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

const titleMetadataPayload = {
  resourceSpans: [{
    resource: { attributes: [] },
    scopeSpans: [{
      scope,
      spans: [{
        traceId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', spanId: '6666666666666666',
        name: 'vscode.agent_host.session.title_changed', kind: 1,
        startTimeUnixNano: ns(480), endTimeUnixNano: ns(480), status: { code: 1 },
        attributes: [
          { key: 'gen_ai.conversation.id', value: { stringValue: 'sess-multi' } },
          { key: 'vscode.agent_host.session.title', value: { stringValue: 'Initial session title' } },
        ],
      }, {
        traceId: 'ffffffffffffffffffffffffffffffff', spanId: '7777777777777777',
        name: 'vscode.agent_host.session.title_changed', kind: 1,
        startTimeUnixNano: ns(490), endTimeUnixNano: ns(490), status: { code: 1 },
        attributes: [
          { key: 'gen_ai.conversation.id', value: { stringValue: 'sess-multi' } },
          { key: 'vscode.agent_host.session.title', value: { stringValue: 'Refined session title' } },
        ],
      }],
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
          // Copilot currently omits the token unit, so the standard metric name
          // must still select additive token-activity semantics.
          name: 'gen_ai.client.token.usage',
          histogram: {
            aggregationTemporality: 2,
            dataPoints: [
              {
                count: '1', sum: 1000, min: 1000, max: 1000,
                startTimeUnixNano: ns(0), timeUnixNano: ns(128),
                attributes: [
                  { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } },
                  { key: 'gen_ai.token.type', value: { stringValue: 'input' } },
                ],
              },
              {
                count: '2', sum: 1200, min: 200, max: 1000,
                startTimeUnixNano: ns(0), timeUnixNano: ns(138),
                attributes: [
                  { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } },
                  { key: 'gen_ai.token.type', value: { stringValue: 'input' } },
                ],
              },
              {
                count: '1', sum: 280, min: 280, max: 280,
                startTimeUnixNano: ns(0), timeUnixNano: ns(128),
                attributes: [
                  { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } },
                  { key: 'gen_ai.token.type', value: { stringValue: 'output' } },
                ],
              },
              {
                count: '2', sum: 400, min: 120, max: 280,
                startTimeUnixNano: ns(0), timeUnixNano: ns(138),
                attributes: [
                  { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } },
                  { key: 'gen_ai.token.type', value: { stringValue: 'output' } },
                ],
              },
            ],
          },
        },
        {
          name: 'process.runtime.memory', unit: 'By',
          gauge: {
            dataPoints: [
              {
                asDouble: 734003200.5, timeUnixNano: ns(128),
                attributes: [{ key: 'state', value: { stringValue: 'used' } }],
              },
              {
                asDouble: 104857600, timeUnixNano: ns(128),
                attributes: [{ key: 'state', value: { stringValue: 'free' } }],
              },
            ],
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
        {
          name: 'test.delta.counter', unit: '{call}',
          sum: {
            aggregationTemporality: 1, isMonotonic: true,
            dataPoints: [
              { asInt: '4', startTimeUnixNano: ns(0), timeUnixNano: ns(60) },
              { asInt: '6', startTimeUnixNano: ns(0), timeUnixNano: ns(70) },
            ],
          },
        },
        {
          name: 'test.request.duration', unit: 'ms',
          histogram: {
            aggregationTemporality: 2,
            dataPoints: [
              { count: '2', sum: 10, min: 4, max: 6, startTimeUnixNano: ns(0), timeUnixNano: ns(80) },
              { count: '4', sum: 30, min: 4, max: 12, startTimeUnixNano: ns(0), timeUnixNano: ns(90) },
            ],
          },
        },
        {
          name: 'test.delta.zero-baseline', unit: '{call}',
          sum: {
            aggregationTemporality: 1, isMonotonic: true,
            dataPoints: [
              { asInt: '0', startTimeUnixNano: ns(0), timeUnixNano: ns(60) },
              { asInt: '5', startTimeUnixNano: ns(0), timeUnixNano: ns(80) },
            ],
          },
        },
        {
          name: 'claude_code.token.usage', unit: 'tokens',
          sum: {
            aggregationTemporality: 2, isMonotonic: true,
            dataPoints: [
              {
                asInt: '10', startTimeUnixNano: ns(95), timeUnixNano: ns(100),
                attributes: [
                  { key: 'type', value: { stringValue: 'input' } },
                  { key: 'model', value: { stringValue: 'claude-sonnet' } },
                ],
              },
              {
                asInt: '20', startTimeUnixNano: ns(95), timeUnixNano: ns(110),
                attributes: [
                  { key: 'type', value: { stringValue: 'input' } },
                  { key: 'model', value: { stringValue: 'claude-sonnet' } },
                ],
              },
              {
                asInt: '5', startTimeUnixNano: ns(95), timeUnixNano: ns(100),
                attributes: [
                  { key: 'type', value: { stringValue: 'output' } },
                  { key: 'model', value: { stringValue: 'claude-opus' } },
                ],
              },
              {
                asInt: '8', startTimeUnixNano: ns(95), timeUnixNano: ns(110),
                attributes: [
                  { key: 'type', value: { stringValue: 'output' } },
                  { key: 'model', value: { stringValue: 'claude-opus' } },
                ],
              },
            ],
          },
        },
        {
          name: 'test.exponential.duration', unit: 'ms',
          exponentialHistogram: {
            aggregationTemporality: 2,
            dataPoints: [
              { count: '1', sum: 10, min: 10, max: 10, startTimeUnixNano: ns(0), timeUnixNano: ns(120) },
              { count: '3', sum: 40, min: 5, max: 20, startTimeUnixNano: ns(0), timeUnixNano: ns(130) },
            ],
          },
        },
        {
          name: 'test.summary.duration', unit: 'ms',
          summary: {
            dataPoints: [
              { count: '2', sum: 10, startTimeUnixNano: ns(0), timeUnixNano: ns(140), quantileValues: [] },
              { count: '4', sum: 30, startTimeUnixNano: ns(0), timeUnixNano: ns(150), quantileValues: [] },
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

async function e2ePipelineChecks() {
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
    const utilityTrace = traces.find(t => t.traceId === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') || {};
    eq(utilityTrace.isBackground, false, 'token-bearing standalone utility trace stays visible');

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
    const byAttrTrace = byAttr.find(t => t.traceId === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') || {};
    eq(byAttrTrace.spanCount, 2, 'nameSearch preserves the matching trace full span count');
    eq(byAttrTrace.rootSpanName, 'POST /checkout', 'nameSearch preserves the matching trace root span');

    const byRoot = engine.getTraces(db, { nameSearch: 'checkout' });
    check(byRoot.some(t => t.traceId === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      'nameSearch matches the root span name');

    const byLiteralWildcard = engine.getTraces(db, { nameSearch: 'gpt%mini' });
    eq(byLiteralWildcard.length, 0, 'nameSearch treats SQL wildcard characters literally');

    // 4c) Match previews: each snippet edge is reported independently, so the
    // UI only draws an ellipsis on a side that really has more text beyond it.
    const nameMatches = engine.getTraceMatches(db, {
      search: 'gpt-4o', traceIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    });
    const nameHit = nameMatches.find(m => m.field === 'name') || {};
    eq(nameHit.snippet, 'chat gpt-4o', 'match snippet holds the whole short span name');
    eq(nameHit.truncatedStart, false, 'short span name is not marked truncated at the start');
    eq(nameHit.truncatedEnd, false, 'short span name is not marked truncated at the end');
    eq(nameHit.snippet.slice(nameHit.matchOffset, nameHit.matchOffset + 'gpt-4o'.length), 'gpt-4o',
      'matchOffset points at the hit inside the snippet');

    // The hit sits near the END of this attribute, so the snippet is cut at the
    // start but reaches the value's end — trailing ellipsis must stay off.
    const attrMatches = engine.getTraceMatches(db, {
      search: 'Place my order', traceIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    });
    const attrHit = attrMatches.find(m => m.attrKey === 'gen_ai.input.messages') || {};
    eq(attrHit.truncatedStart, true, 'long attribute snippet is marked truncated at the start');
    eq(attrHit.truncatedEnd, false, 'snippet reaching the value end is not marked truncated at the end');

    // Every listed trace is previewed — no per-trace or overall match cap.
    const allIds = engine.getTraces(db, { nameSearch: 'chat' }).map(t => t.traceId);
    const allMatches = engine.getTraceMatches(db, { search: 'chat', traceIds: allIds });
    eq(new Set(allMatches.map(m => m.traceId)).size, allIds.length,
      'getTraceMatches returns hits for every matched trace (uncapped)');

    // 4d) A span whose materialized attributes column is not valid JSON must not
    // abort the whole search — json_each() raises "malformed JSON" on such values.
    const attrRow = db.prepare('SELECT id, attributes FROM raw_spans LIMIT 1').get();
    db.prepare('UPDATE raw_spans SET attributes = ? WHERE id = ?').run('', attrRow.id);
    let survivedBadAttrs = true;
    try {
      engine.getTraces(db, { nameSearch: 'checkout' });
      engine.getTraceMatches(db, { search: 'checkout', traceIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] });
    } catch { survivedBadAttrs = false; }
    db.prepare('UPDATE raw_spans SET attributes = ? WHERE id = ?').run(attrRow.attributes, attrRow.id);
    check(survivedBadAttrs, 'trace search survives a span whose attributes are not valid JSON');

    // 4e) matchOffset is a Unicode CODE POINT index (SQLite instr/substr
    // semantics). Astral characters (emoji) are 2 UTF-16 units each, so slicing
    // the snippet by JS index would shift the highlight off the hit.
    const emojiRow = db.prepare(
      "SELECT id, attributes FROM raw_spans WHERE json_extract(raw,'$.span.spanId') = '2222222222222222'").get();
    db.prepare('UPDATE raw_spans SET attributes = ? WHERE id = ?')
      .run(JSON.stringify({ 'emoji.note': 'Done! 🙂🙂🙂 summary: NEEDLE here' }), emojiRow.id);
    const emojiHit = engine.getTraceMatches(db, {
      search: 'NEEDLE', traceIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    }).find(m => m.attrKey === 'emoji.note') || {};
    const emojiChars = Array.from(emojiHit.snippet ?? '');
    eq(emojiChars.slice(emojiHit.matchOffset, emojiHit.matchOffset + 'NEEDLE'.length).join(''), 'NEEDLE',
      'matchOffset stays aligned with the hit across astral characters');
    db.prepare('UPDATE raw_spans SET attributes = ? WHERE id = ?').run(emojiRow.attributes, emojiRow.id);

    // 5) Agent analytics: token usage + summary counts through the views.
    const analytics = engine.getAgentAnalytics(db);
    const gpt = analytics.tokenUsage.find(t => t.model === 'gpt-4o') || {};
    eq(gpt.promptTokens, 1024, 'token usage prompt_tokens aggregated');
    eq(gpt.completionTokens, 256, 'token usage completion_tokens aggregated');
    eq(analytics.summary.totalSpans, 6, 'summary.totalSpans');
    eq(analytics.summary.totalTraces, 4, 'summary.totalTraces');
    eq(analytics.summary.totalLogs, 2, 'summary.totalLogs');
    eq(analytics.summary.totalMetricPoints, 24, 'summary.totalMetricPoints across all OTLP metric types');
    eq(analytics.summary.errorTraces, 3, 'summary.errorTraces');
    eq(analytics.summary.llmCalls, 4, 'summary.llmCalls');
    eq(analytics.summary.inputTokens, 1124, 'summary.inputTokens');
    eq(analytics.summary.outputTokens, 276, 'summary.outputTokens');

    // 5b) Cumulative counter resets: a series run is (attributes, startTimeUnixNano),
    // so a restart begins a new run instead of discarding the completed one.
    const resetSvc = 'checkout-api';
    const resets = engine.getMetricDetail(db, 'test.counter.resets', resetSvc);
    check(resets.isCumulative, 'reset counter detected as cumulative');
    eq(resets.stats.seriesCount, 1, 'reset counter has a single attribute set');
    eq(resets.observedWindow.sinceNano, ns(10), 'all-time detail records its first report timestamp');
    eq(resets.observedWindow.untilNano, ns(50), 'all-time detail records its last report timestamp');
    eq(resets.stats.total, 21, 'cumulative total sums per-run finals across a restart (12 + 9)');
    eq(resets.chart.kind, 'activity', 'monotonic counter is presented as interval activity');
    eq(JSON.stringify(resets.chart.series.map(p => p.value)), JSON.stringify([21]),
      'all-time activity includes first reports from valid metric runs');
    check(resets.chart.unattributed === undefined,
      'all-time activity leaves no valid metric run unattributed');
    eq(resets.chart.total, resets.stats.total, 'counter activity chart reconciles with the reported total');
    const toolDimension = resets.dimensions.find(d => d.key === 'tool') || {};
    const editContribution = (toolDimension.values || []).find(v => v.value === 'edit') || {};
    eq(editContribution.total, 21, 'metric dimension total preserves cumulative contribution across resets');
    eq(editContribution.count, 2, 'metric dimension count reports contributing runs');
    const memory = engine.getMetricDetail(db, 'process.runtime.memory', resetSvc);
    eq(memory.observedWindow.sinceNano, ns(128),
      'single-timestamp metric reports its observed start');
    eq(memory.observedWindow.untilNano, ns(128),
      'single-timestamp metric reports the same observed end');
    const stateDimension = memory.dimensions.find(d => d.key === 'state') || {};
    eq(stateDimension.values[0]?.value, 'used', 'metric dimension values rank by contribution total');
    eq(stateDimension.values[0]?.total, 734003200.5, 'metric dimension preserves gauge contribution total');

    // Window starting after the first run ended: only the second run contributes.
    const secondRun = engine.getMetricDetail(db, 'test.counter.resets', resetSvc, ns(25));
    eq(secondRun.stats.total, 9,
      'windowed total counts a run with no pre-window baseline in full');
    check(secondRun.chart.unattributed === undefined,
      'a first report whose run began inside the selected window is timed');
    eq(JSON.stringify(secondRun.chart.series.map(p => p.value)), JSON.stringify([9]),
      'windowed activity includes the new run first report and later difference');
    eq(secondRun.chart.total, 9,
      'windowed total includes both the first-report value and timed differences');
    eq(secondRun.observedWindow.sinceNano, ns(40),
      'windowed detail exposes its first in-range report');
    eq(secondRun.observedWindow.untilNano, ns(50),
      'windowed detail exposes its last in-range report');
    const wideResetWindow = engine.getMetricDetail(
      db, 'test.counter.resets', resetSvc, ns(0), ns(7 * 24 * 60 * 60 * 1000));
    eq(wideResetWindow.chart.bucketMs, resets.chart.bucketMs,
      'fixed ranges bucket charts over observed reports rather than empty requested time');
    eq(JSON.stringify(wideResetWindow.chart.series.map(p => p.value)), JSON.stringify([21]),
      'fixed ranges time first reports for runs that demonstrably began inside the range');
    check(wideResetWindow.chart.unattributed === undefined,
      'fixed ranges leave no first-report value unattributed when every run began inside the range');
    // Window splitting the first run: 12-5 accrued in-window, plus all of run two.
    eq(engine.getMetricDetail(db, 'test.counter.resets', resetSvc, ns(15)).stats.total, 16,
      'windowed total subtracts the per-run baseline ((12-5) + 9)');
    const boundedReset = engine.getMetricDetail(db, 'test.counter.resets', resetSvc, ns(15), ns(25));
    eq(boundedReset.stats.total, 7,
      'bounded cumulative window excludes runs and points after its upper edge');
    eq(JSON.stringify(boundedReset.chart.series.map(p => p.value)), JSON.stringify([7]),
      'bounded activity chart subtracts the pre-window baseline');
    eq(boundedReset.comparison?.previousValue, 5,
      'bounded activity compares against the immediately preceding equal-duration window');
    eq(boundedReset.comparison?.changePercent, 40,
      'bounded activity reports percentage change from the preceding window');
    eq(engine.getMetricDetail(db, 'test.counter.resets', resetSvc, undefined, ns(25)).stats.total, 12,
      'upper-bounded cumulative total uses the latest point per run before the edge');
    eq(engine.getMetricDetail(db, 'test.counter.resets', resetSvc, ns(20), ns(20)).stats.total, 7,
      'metric window bounds are inclusive at both edges');
    eq(engine.getMetricInstruments(db, ns(21), ns(29)).some(i => i.name === 'test.counter.resets'), false,
      'instrument discovery excludes instruments without points inside both bounds');
    eq(engine.getMetricInstruments(db, ns(20), ns(20)).some(i => i.name === 'test.counter.resets'), true,
      'instrument discovery includes points exactly on a window boundary');

    const tokenHistogram = engine.getMetricDetail(db, 'gen_ai.client.token.usage', resetSvc);
    eq(tokenHistogram.metricType, 'histogram', 'Copilot token usage retains its histogram type');
    eq(tokenHistogram.chart.kind, 'activity', 'token histogram is presented as interval activity');
    eq(tokenHistogram.chart.total, 1600, 'cumulative token histogram activity uses its sum');
    check(tokenHistogram.chart.unattributed === undefined,
      'all-time token usage charts each valid series first report');
    const tokenTypeBreakdown = (tokenHistogram.chart.breakdowns || []).find(b => b.key === 'tokenType') || {};
    eq(JSON.stringify((tokenTypeBreakdown.series || []).map(s => s.label)), JSON.stringify(['Input', 'Output']),
      'Copilot token types are normalized into a stacked breakdown');
    eq(JSON.stringify((tokenTypeBreakdown.series || []).map(s => s.points[0]?.value)), JSON.stringify([1200, 400]),
      'Copilot token-type stacks contain all-time activity including first reports');
    eq((tokenTypeBreakdown.series || []).reduce((total, s) => total + Number(s.points[0]?.value || 0), 0),
      tokenHistogram.chart.series[0]?.value,
      'Copilot token-type stacks reconcile with the interval total');
    const boundedTokens = engine.getMetricDetail(
      db, 'gen_ai.client.token.usage', resetSvc, ns(130), ns(140));
    eq(boundedTokens.stats.sum, 320, 'bounded cumulative histogram subtracts its sum baseline');
    eq(boundedTokens.chart.total, 320, 'bounded token activity reconciles with the histogram sum');

    const deltaCounter = engine.getMetricDetail(db, 'test.delta.counter', resetSvc);
    eq(deltaCounter.chart.kind, 'activity', 'delta-temporality counter is presented as activity');
    eq(deltaCounter.chart.total, 10, 'delta-temporality activity sums independent reports');
    check(deltaCounter.comparison === undefined, 'all-time metric detail omits period comparison');

    const noPrevious = engine.getMetricDetail(db, 'test.delta.counter', resetSvc, ns(60), ns(70));
    eq(noPrevious.comparison?.hasPreviousData, false,
      'bounded detail distinguishes a preceding window with no reports');
    check(noPrevious.comparison?.changePercent === undefined,
      'preceding window without reports has no percentage change');

    const zeroPrevious = engine.getMetricDetail(
      db, 'test.delta.zero-baseline', resetSvc, ns(70), ns(80));
    eq(zeroPrevious.comparison?.hasPreviousData, true,
      'zero-valued preceding report still counts as previous-period data');
    eq(zeroPrevious.comparison?.previousValue, 0,
      'previous-period zero is preserved');
    check(zeroPrevious.comparison?.changePercent === undefined,
      'zero previous value does not produce an infinite percentage');

    const durationHistogram = engine.getMetricDetail(db, 'test.request.duration', resetSvc);
    eq(durationHistogram.chart.kind, 'average', 'duration histogram is presented as interval averages');
    check(durationHistogram.chart.unattributedCount === undefined,
      'all-time duration charts include observations from valid first reports');
    eq(JSON.stringify(durationHistogram.chart.series.map(p => p.value)), JSON.stringify([7.5]),
      'duration chart averages all cumulative observations in all-time views');

    const exponentialHistogram = engine.getMetricDetail(db, 'test.exponential.duration', resetSvc);
    eq(exponentialHistogram.chart.kind, 'average', 'exponential histogram is presented as interval averages');
    eq(exponentialHistogram.stats.totalCount, 3, 'exponential histogram uses the latest cumulative count');
    eq(JSON.stringify(exponentialHistogram.chart.series.map(p => p.value)), JSON.stringify([40 / 3]),
      'exponential histogram averages all cumulative observations in all-time views');

    const summaryMetric = engine.getMetricDetail(db, 'test.summary.duration', resetSvc);
    check(summaryMetric.isCumulative, 'OTLP summary is cumulative without a temporality field');
    eq(summaryMetric.stats.totalCount, 4, 'summary uses the latest cumulative count');
    eq(JSON.stringify(summaryMetric.chart.series.map(p => p.value)), JSON.stringify([7.5]),
      'summary averages all cumulative observations in all-time views');

    const claudeTokens = engine.getMetricDetail(db, 'claude_code.token.usage', resetSvc);
    eq(claudeTokens.chart.total, 28, 'Claude token counter total aggregates token series');
    const claudeBreakdowns = claudeTokens.chart.breakdowns || [];
    eq(JSON.stringify(claudeBreakdowns.map(b => b.key)), JSON.stringify(['tokenType', 'model']),
      'Claude token counters support token-type and model stacks');
    const claudeModels = claudeBreakdowns.find(b => b.key === 'model') || {};
    eq(JSON.stringify((claudeModels.series || []).map(s => s.label)),
      JSON.stringify(['claude-sonnet', 'claude-opus']),
      'model stacks rank models by observed interval activity');
    eq((claudeModels.series || []).reduce((total, s) => total + Number(s.points[0]?.value || 0), 0),
      claudeTokens.chart.series[0]?.value,
      'model stacks reconcile with the interval total');
    const windowedClaudeTokens = engine.getMetricDetail(
      db, 'claude_code.token.usage', resetSvc, ns(90), ns(110));
    check(windowedClaudeTokens.chart.unattributed === undefined,
      'token first reports are timed when their metric runs began inside the selected window');
    eq(windowedClaudeTokens.chart.series.reduce((total, point) => total + point.value, 0), 28,
      'windowed token chart includes the full first cumulative reports');
    const windowedClaudeModels = (windowedClaudeTokens.chart.breakdowns || [])
      .find(b => b.key === 'model') || {};
    eq((windowedClaudeModels.series || []).reduce(
      (total, series) => total + series.points.reduce((sum, point) => sum + point.value, 0), 0),
    windowedClaudeTokens.chart.total,
    'token breakdowns include and reconcile attributed first reports');
    const preWindowClaudeTokens = engine.getMetricDetail(
      db, 'claude_code.token.usage', resetSvc, ns(97), ns(110));
    eq(preWindowClaudeTokens.chart.unattributed, 15,
      'first reports remain unattributed when their metric runs began before the selected window');
    eq(preWindowClaudeTokens.chart.series.reduce((total, point) => total + point.value, 0), 13,
      'pre-window runs chart only activity after their first observed report');

    // 6) Logs read back with derived columns.
    const logs = engine.getLogs(db);
    eq(logs.length, 2, 'getLogs returns 2 logs');
    const errLog = logs.find(l => l.severityText === 'ERROR') || {};
    check((errLog.body || '').includes('rate limited'), 'error log body derived');
    eq(errLog.attributes && errLog.attributes['gen_ai.request.model'], 'gpt-4o', 'log flat attribute derived');
    eq(errLog.traceId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'log trace_id derived');
    const sessionLogs = engine.getLogs(db, { sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    eq(sessionLogs.length, 1, 'getLogs filters to exact session trace ids');
    eq(sessionLogs[0].spanId, '2222222222222222', 'session log preserves its correlated span id');
    eq(engine.getLogs(db, { sessionId: 'sess-multi' }).length, 0,
      'getLogs excludes logs from traces outside the requested session');

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
    const categorizedUtilityTrace = engine.getTraces(db)
      .find(t => t.traceId === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') || {};
    eq(categorizedUtilityTrace.category, 'utilityModelCall',
      'single parentless model request without a session is a utility model call');
    const utilityOnly = engine.getTraces(db, { categories: ['utilityModelCall'], limit: 1 });
    eq(utilityOnly.length, 1, 'trace category filtering is applied before the limit');
    eq(utilityOnly[0]?.traceId, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'category filter returns the utility call despite newer traces in other categories');
    const genericTrace = engine.getTraces(db)
      .find(t => t.traceId === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') || {};
    eq(genericTrace.category, 'other',
      'generic application telemetry falls back to other telemetry');

    // 10) Session-title metadata is visible as ordinary traces, globally and
    // alongside the activity traces for its correlated session.
    const titlePost = await post('/v1/traces', titleMetadataPayload);
    eq(titlePost.status, 200, 'POST /v1/traces accepts title metadata');
    const tracesWithMetadata = engine.getTraces(db);
    eq(tracesWithMetadata.length, 6, 'getTraces includes 2 session-title metadata traces');
    const titleTrace = tracesWithMetadata.find(t => t.traceId === 'ffffffffffffffffffffffffffffffff') || {};
    eq(titleTrace.rootSpanName, 'vscode.agent_host.session.title_changed',
      'title metadata trace keeps its span name');
    const titleSpans = engine.getSpansByTraceId(db, 'ffffffffffffffffffffffffffffffff');
    eq(titleSpans[0]?.attributes?.['vscode.agent_host.session.title'], 'Refined session title',
      'title metadata attributes are available in span details');
    const sessionTracesWithMetadata = engine.getTraces(db, { sessionId: 'sess-multi' });
    eq(sessionTracesWithMetadata.length, 4,
      'session trace list includes 2 activity traces and 2 title metadata traces');
    check(sessionTracesWithMetadata.filter(t => t.rootSpanName === 'vscode.agent_host.session.title_changed').length === 2,
      'session trace list correlates title metadata by conversation id');

    // 11) Sessions must EXCLUDE utility and title-metadata traces from activity
    // counts, while using the newest title.
    const sessions = engine.getSessions(db);
    check(sessions.every(s => s.serviceName !== 'copilot-chat'),
      'getSessions excludes copilot-chat utility calls');
    check(sessions.every(s => s.sessionId !== 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      'utility trace does not appear as a session');
    eq(engine.getSessionIdForTrace(db, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'getSessionIdForTrace uses the trace-id fallback');
    eq(engine.getSessionIdForTrace(db, 'cccccccccccccccccccccccccccccccc'), 'sess-multi',
      'getSessionIdForTrace resolves a conversation id from any span in the trace');
    eq(engine.getSessionIdForTrace(db, 'ffffffffffffffffffffffffffffffff'), 'sess-multi',
      'getSessionIdForTrace resolves title metadata traces');
    check(engine.getSessionIdForTrace(db, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') === null,
      'getSessionIdForTrace excludes copilot-chat utility traces');
    check(engine.getSessionIdForTrace(db, 'missing-trace') === null,
      'getSessionIdForTrace returns null for an unknown trace');

    // 12) getSessionSummary: full breakdown for one session (the checkout trace,
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

    // 13) getSessionMessages: captured conversation turns for the checkout session.
    const msgs = engine.getSessionMessages(db, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    check(msgs != null, 'getSessionMessages returns data');
    eq(msgs.sessionId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'session messages sessionId');
    check(msgs.captureEnabled === true, 'session messages captureEnabled when content present');
    eq(msgs.turns.length, 1, 'session messages has one captured turn');
    eq(msgs.turns[0].model, 'gpt-4o', 'session messages turn model');
    eq(msgs.turns[0].spanId, '2222222222222222', 'session messages turn spanId');
    eq(msgs.turns[0].sourceSpanId, '2222222222222222',
      'span-captured turns expose their exact source span');
    check(msgs.turns[0].hasError === true, 'session messages turn surfaces error status');
    check(msgs.turns[0].outputMessages.includes('Order placed.'),
      'session messages carries raw output messages JSON');
    eq(msgs.turns[0].inputPreview, 'Place my order', 'session messages extracts last user prompt');
    check(engine.getSessionMessages(db, 'nonexistent-session') === null,
      'getSessionMessages returns null for unknown session');
    check(engine.getSessionMessages(db, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') === null,
      'getSessionMessages excludes copilot-chat utility trace');

    // 13b) getTraceMessages: the same transcript, addressed by trace instead of
    // session — which is the only way the Traces tab can reach one, since most of
    // what it lists (utility calls, host activity) belongs to no session at all.
    const traceMsgs = engine.getTraceMessages(db, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    check(traceMsgs != null, 'getTraceMessages returns data');
    eq(traceMsgs.traceId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'trace messages echo the id asked for');
    eq(traceMsgs.captureEnabled, true, 'trace messages captureEnabled when content present');
    eq(traceMsgs.turns.length, msgs.turns.length, 'trace messages match the session transcript length');
    eq(JSON.stringify(traceMsgs.turns), JSON.stringify(msgs.turns),
      'a trace read by trace id yields the same turns as reading its session');

    // The copilot-chat utility trace is excluded from sessions entirely, so this
    // is the case the session-keyed query could never serve.
    const utilityMsgs = engine.getTraceMessages(db, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    check(utilityMsgs != null, 'getTraceMessages resolves a trace that belongs to no session');
    eq(utilityMsgs.captureEnabled, false, 'a trace with no captured content reports capture off');
    eq(utilityMsgs.turns.length, 0, 'a trace with no captured content has no turns');
    check(engine.getTraceMessages(db, 'deadbeefdeadbeefdeadbeefdeadbeef') === null,
      'getTraceMessages returns null for unknown trace');
    check(engine.getTraceMessages(db, '') === null,
      'getTraceMessages returns null for a blank trace id');

    // 14) A session that fails in MULTIPLE traces must list EVERY failure, not
    // just one representative message (Sessions tab summary card).
    const multi = sessions.find(s => s.sessionId === 'sess-multi') || {};
    eq(multi.traceCount, 2, 'multi-failure session spans 2 traces');
    eq(multi.spanCount, 3, 'title metadata does not inflate session span count');
    eq(multi.title, 'Refined session title', 'session uses the newest title metadata');
    eq(multi.errorCount, 3, 'multi-failure session errorCount counts every errored span');
    eq((multi.failures || []).length, 3, 'multi-failure session lists all 3 failures');
    const multiMsgs = (multi.failures || []).map(f => f.message).sort();
    check(multiMsgs.join('|') === ['context length exceeded', 'exit code 1', 'tool timeout'].sort().join('|'),
      `multi-failure session surfaces every failure message (got ${JSON.stringify(multiMsgs)})`);
    check((multi.failures || []).some(f => f.traceId === 'cccccccccccccccccccccccccccccccc')
      && (multi.failures || []).some(f => f.traceId === 'dddddddddddddddddddddddddddddddd'),
      'failures carry the trace they happened in');

    const multiSummary = engine.getSessionSummary(db, 'sess-multi') || {};
    eq(multiSummary.title, 'Refined session title', 'session summary uses newest title metadata');
    eq((multiSummary.failures || []).length, 3, 'session summary lists all 3 failures');
    eq(multiSummary.errorCount, 3, 'session summary errorCount');
    eq((multiSummary.turns || []).length, 2, 'session summary has both failing turns');
    check((multiSummary.turns || []).every(t => t.hasError && t.errorCount > 0),
      'each failing turn reports its own error count');
    const turnC = (multiSummary.turns || []).find(t => t.traceId === 'cccccccccccccccccccccccccccccccc') || {};
    eq((turnC.failures || []).length, 2, 'turn with two errored spans lists both failures');
    check((multiSummary.errors || []).every(e => !!e.traceId),
      'session summary error details carry a trace id');
    const multiMessages = engine.getSessionMessages(db, 'sess-multi') || {};
    const multiParts = JSON.parse(multiMessages.turns[0].outputMessages)[0].parts;
    check(multiParts.some(part => part.id === 'bash-call'
      && part.type === 'tool_call' && part.sourceSpanId === '4444444444444445'),
    'Copilot tool call resolves to its unique descendant execute_tool span');
    check(multiParts.some(part => part.id === 'bash-call'
      && part.type === 'tool_call_response' && part.sourceSpanId === '4444444444444445'),
    'Copilot tool result shares its call source span');
    const multiTraceMessages = engine.getTraceMessages(
      db,
      'cccccccccccccccccccccccccccccccc',
    ) || {};
    const multiTraceParts = JSON.parse(multiTraceMessages.turns[0].outputMessages)[0].parts;
    check(multiTraceParts.some(part => part.id === 'bash-call'
      && part.sourceSpanId === '4444444444444445'),
    'trace-scoped Copilot messages preserve exact descendant tool sources');

    // 15) Codex runtime spans expose future lifetime as OTel duration and actual
    // work as busy_ns. Latency views and trace rows must report the work time,
    // while retaining wall time solely for waterfall positioning.
    const runtimePayload = {
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'codex-app-server' } }] },
        scopeSpans: [{
          scope: { name: 'codex.runtime' },
          spans: ['session_loop', 'thread/list', 'list_models'].map((name, i) => ({
            traceId: `${i + 5}a`.repeat(16),
            spanId: `${i + 5}b`.repeat(8),
            name,
            kind: 1,
            startTimeUnixNano: ns(2_000 + i * 20_000),
            endTimeUnixNano: ns(18_000 + i * 20_000),
            status: { code: 1 },
            attributes: [
              { key: 'busy_ns', value: { intValue: String(564_000_000 + i * 1_000_000) } },
              { key: 'idle_ns', value: { intValue: String(15_436_000_000 - i * 1_000_000) } },
            ],
          })),
        }],
      }],
    };
    eq((await post('/v1/traces', runtimePayload)).status, 200, 'POST runtime traces returns 200');

    const runtimeTrace = engine.getTraces(db).find(t => t.rootSpanName === 'session_loop') || {};
    eq(runtimeTrace.durationMs, 564, 'runtime trace duration uses busy_ns instead of 16s wall time');
    eq(runtimeTrace.isBackground, true, 'known standalone runtime trace is marked as background');
    eq(runtimeTrace.category, 'hostActivity', 'known standalone runtime trace is host activity');
    check(engine.getTraces(db, { categories: ['hostActivity'] })
      .every(t => t.category === 'hostActivity'),
    'host activity filter excludes other trace categories');
    eq(engine.getTraces(db, { categories: [] }).length, 0,
      'an empty trace category selection intentionally returns no rows');
    const runtimeSpan = engine.getSpansByTraceId(db, '5a'.repeat(16))[0] || {};
    eq(runtimeSpan.durationMs, 564, 'runtime span chart duration uses busy_ns');
    eq(runtimeSpan.wallDurationMs, 16_000, 'runtime span retains wall duration for timeline positioning');

    const runtimeAnalytics = engine.getAgentAnalytics(db).slowestOperations
      .find(op => op.name === 'session_loop') || {};
    eq(runtimeAnalytics.avgDurationMs, 564, 'slowest-operation ranking uses busy_ns');
    const runtimeService = engine.getServiceSummary(db, 'codex-app-server') || {};
    const runtimeServiceOp = (runtimeService.slowestOperations || [])
      .find(op => op.name === 'session_loop') || {};
    eq(runtimeServiceOp.avgDurationMs, 564, 'service latency ranking uses busy_ns');
  } finally {
    await receiver.stop();
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
}

module.exports = { e2ePipelineChecks };
