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
                asInt: '10', startTimeUnixNano: ns(0), timeUnixNano: ns(100),
                attributes: [
                  { key: 'type', value: { stringValue: 'input' } },
                  { key: 'model', value: { stringValue: 'claude-sonnet' } },
                ],
              },
              {
                asInt: '20', startTimeUnixNano: ns(0), timeUnixNano: ns(110),
                attributes: [
                  { key: 'type', value: { stringValue: 'input' } },
                  { key: 'model', value: { stringValue: 'claude-sonnet' } },
                ],
              },
              {
                asInt: '5', startTimeUnixNano: ns(0), timeUnixNano: ns(100),
                attributes: [
                  { key: 'type', value: { stringValue: 'output' } },
                  { key: 'model', value: { stringValue: 'claude-opus' } },
                ],
              },
              {
                asInt: '8', startTimeUnixNano: ns(0), timeUnixNano: ns(110),
                attributes: [
                  { key: 'type', value: { stringValue: 'output' } },
                  { key: 'model', value: { stringValue: 'claude-opus' } },
                ],
              },
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

// ── retention + persistence ───────────────────────────────────────────────────
// sql.js cannot write incrementally: every save serializes the WHOLE database
// and rewrites the file. Retention is therefore what bounds save cost, and it
// has to bound BYTES — a row cap alone does not, since one span carrying
// captured model content can be tens of kilobytes. These checks use deliberately
// tiny budgets so the same rules can be exercised with a handful of spans.

const PAD = 4096;
const sid = (i) => String(i).padStart(16, '0');

/** A span of roughly PAD bytes, attributed to `service`. */
function padSpan(i, service) {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scope: { name: 'retention.test' },
      span: {
        traceId: String(i).padStart(32, '0'),
        spanId:  sid(i),
        name:    `span-${i}`,
        kind:    1,
        startTimeUnixNano: ns(i),
        endTimeUnixNano:   ns(i + 1),
        status:  { code: 0 },
        attributes: [{ key: 'pad', value: { stringValue: 'x'.repeat(PAD) } }],
      },
    }),
  };
}

const spanIds  = (db) => db.prepare('SELECT span_id AS id FROM raw_spans').all().map(r => r.id);
// Mirrors the store's byte budget, which counts the payload columns together:
// `attributes` holds a flattened copy of the same content as `raw`, so counting
// raw alone understates the real footprint by close to half.
const rawBytes = (db) => db.prepare('SELECT COALESCE(SUM(LENGTH(raw) + COALESCE(LENGTH(attributes),0)), 0) AS b FROM raw_spans').get().b;

// ── materialized columns + schema migration ──────────────────────────────────
// Queryable fields are stored as real columns, not derived in the views: a view
// of json_extract() calls makes every scan re-parse each row's payload, which is
// what made loading and searching traces slow. Two properties have to hold, and
// both are easy to break silently:
//   1. the columns exist and are correct, including after upgrading an old file;
//   2. they are physically ordered BEFORE the payload columns. SQLite stores a
//      row's columns in declaration order, so a scalar declared after a multi-KB
//      value costs a walk over that value (measured 226 ms vs 23 ms per scan).

async function materializationChecks() {
  const dbPath = path.join(os.tmpdir(), `agent-materialize-${process.pid}-${Date.now()}.db`);
  const cleanup = () => {
    for (const f of [dbPath, `${dbPath}.tmp`, `${dbPath}.sync.tmp`]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  };

  try {
    // Build a database, then rewrite raw_spans into the OLD pre-materialization
    // shape (payload first, no derived scalars) and persist that, so reopening
    // exercises the upgrade path a real user's file will take.
    const seed = new TelemetryStore(dbPath);
    await seed.initialize();
    seed.enablePersistence();
    seed.insertSpans([padSpan(1, 'copilot'), padSpan(2, 'copilot'), padSpan(3, 'claude')]);

    const sdb = seed.getDb();
    // Views are reparsed by ALTER TABLE ... RENAME, so they must go first;
    // initialize() recreates them from the canonical definitions anyway.
    sdb.exec(`
      DROP VIEW IF EXISTS spans;
      CREATE TABLE legacy_spans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        raw TEXT NOT NULL,
        attributes TEXT,
        service_name TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO legacy_spans (id, raw, attributes, service_name, created_at)
        SELECT id, raw, attributes, service_name, created_at FROM raw_spans;
      DROP TABLE raw_spans;
      ALTER TABLE legacy_spans RENAME TO raw_spans;
      CREATE INDEX idx_raw_spans_trace ON raw_spans(json_extract(raw, '$.span.traceId'));
    `);
    // The insert above left the store dirty, so this persists the legacy shape.
    seed.flush();
    seed.close();

    const store = new TelemetryStore(dbPath);
    await store.initialize();
    const db = store.getDb();

    const cols = db.prepare("SELECT name FROM pragma_table_info('raw_spans') ORDER BY cid").all().map(r => r.name);
    eq(cols[cols.length - 1], 'raw', 'payload column is stored last, after every scalar');
    check(cols.indexOf('trace_id') < cols.indexOf('attributes'),
      'scalar columns are stored before the payload columns');
    check(cols.includes('derived_v'), 'rows carry the derived-column version');

    // Values must survive the rebuild, derived from the payload.
    const row = db.prepare('SELECT * FROM spans WHERE span_id = ?').get(sid(1));
    eq(row.trace_id, String(1).padStart(32, '0'), 'trace_id materialized from the payload');
    eq(row.name, 'span-1', 'name materialized');
    eq(row.service_name, 'copilot', 'service_name preserved through the rebuild');
    check(Math.abs(row.duration_ms - 1) < 0.001, `duration_ms computed from stored times (${row.duration_ms})`);
    check(JSON.parse(row.attributes).pad.length === PAD, 'attributes carried over intact');
    eq(spanIds(db).length, 3, 'no rows lost in the rebuild');

    // A view of json_extract() calls is what made scans slow; make sure the
    // indexes did not silently stay on the old expression form either.
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name LIKE 'idx_raw_spans%'").all();
    check(idx.every(i => !/json_extract/.test(i.sql || '')),
      'expression indexes replaced by plain column indexes');

    store.close();

    // Reopening must not rebuild or re-derive: parent_span_id is NULL on every
    // root span and status_message NULL on every success, so a NULL-based test
    // (rather than the version marker) would redo this work on every startup.
    const again = new TelemetryStore(dbPath);
    await again.initialize();
    const pending = again.getDb()
      .prepare('SELECT COUNT(*) AS n FROM raw_spans WHERE derived_v IS NULL').get().n;
    eq(pending, 0, 'reopening leaves no rows needing re-derivation');
    eq(spanIds(again.getDb()).length, 3, 'data intact after reopen');
    const cols2 = again.getDb().prepare("SELECT name FROM pragma_table_info('raw_spans') ORDER BY cid").all().map(r => r.name);
    eq(cols2.join(','), cols.join(','), 'layout stable across reopen (no repeat rebuild)');
    again.close();
  } finally {
    cleanup();
  }
}

async function retentionChecks() {
  const stamp   = `${process.pid}-${Date.now()}`;
  const dbPath  = path.join(os.tmpdir(), `agent-retention-${stamp}.db`);
  const dbPath2 = path.join(os.tmpdir(), `agent-clear-${stamp}.db`);
  const cleanup = () => {
    for (const p of [dbPath, dbPath2]) {
      for (const f of [p, `${p}.tmp`, `${p}.sync.tmp`]) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    }
  };

  // byteCheckDelta 0 measures the budget on every insert instead of once per
  // 8 MB, so the rule is observable without ingesting 8 MB of test data.
  //
  // perServiceFloor is deliberately left at the production value while the data
  // set is far smaller than it. That is the regression case: a row floor this
  // generous exempts every row from the row cap, so if the byte budget honoured
  // the same floor it would never evict anything and the store would grow
  // without bound. Only perServiceByteFloor is tightened.
  const limits = {
    maxRows: 1000,
    maxBytes: 5 * PAD,
    perServiceFloor: 5_000,
    perServiceByteFloor: 1,
    byteCheckDelta: 0,
  };
  const store = new TelemetryStore(dbPath, { raw_spans: limits });
  await store.initialize();
  store.enablePersistence();

  try {
    const db = store.getDb();

    // 1) Byte budget evicts oldest-first and keeps the newest data — and does so
    //    even though every row is inside the (production-sized) row floor.
    for (let i = 1; i <= 20; i++) { store.insertSpans([padSpan(i, 'noisy')]); }
    const kept = spanIds(db);
    check(kept.length > 0 && kept.length < 20, `byte budget prunes but keeps data (kept ${kept.length}/20)`);
    check(kept.includes(sid(20)), 'byte budget keeps the newest span');
    check(!kept.includes(sid(1)),  'byte budget evicts the oldest span');
    check(rawBytes(db) <= limits.maxBytes * 2,
      `retained bytes stay near the budget (${rawBytes(db)} vs ${limits.maxBytes})`);

    // 2) A quiet service keeps its newest row even against a noisy neighbour —
    //    otherwise agent-comparison views lose whichever agent was used less.
    store.insertSpans([padSpan(500, 'quiet')]);
    for (let i = 100; i < 130; i++) { store.insertSpans([padSpan(i, 'noisy')]); }
    check(spanIds(db).includes(sid(500)), 'per-service byte floor protects the quiet service');

    // 3) Saves are atomic: written beside the database, then renamed over it, so
    //    an interrupted save cannot truncate the real file.
    store.flush();
    check(fs.existsSync(dbPath), 'flush writes the database file');
    check(!fs.existsSync(`${dbPath}.tmp`) && !fs.existsSync(`${dbPath}.sync.tmp`),
      'flush leaves no scratch file behind');

    // 4) Flushing with nothing new must not rewrite the file — that is what makes
    //    an idle window free rather than a periodic full-database write.
    const mtime = fs.statSync(dbPath).mtimeMs;
    await new Promise(r => setTimeout(r, 50));
    store.flush();
    eq(fs.statSync(dbPath).mtimeMs, mtime, 'flush with no new data does not rewrite the file');

    // 5) The async path persists and cleans up after itself.
    store.insertSpans([padSpan(900, 'noisy')]);
    await store.flushAsync();
    check(!fs.existsSync(`${dbPath}.tmp`), 'async flush removes its scratch file');
    check(fs.statSync(dbPath).mtimeMs > mtime, 'async flush writes new data to disk');

    store.close();

    // 6) Reopening restores the data, and a store opened with tighter budgets
    //    enforces them on load — the path that rescues an oversized legacy file.
    const tighter = new TelemetryStore(dbPath, { raw_spans: { ...limits, maxBytes: 2 * PAD } });
    await tighter.initialize();
    const reloaded = spanIds(tighter.getDb());
    check(reloaded.length > 0, 'database reloads after close');
    check(reloaded.includes(sid(900)), 'reloaded database keeps the newest span');
    // Two services are present and each is guaranteed its newest row, so the
    // floor can legitimately hold slightly more than the budget itself.
    const widest = tighter.getDb()
      .prepare('SELECT MAX(LENGTH(raw) + COALESCE(LENGTH(attributes),0)) AS b FROM raw_spans').get().b;
    check(rawBytes(tighter.getDb()) <= 2 * PAD + 2 * widest,
      'startup reclaim applies a tighter byte budget to an existing file');
    tighter.close();

    // 7) Clearing must actually shrink the file. Deleted rows leave free pages
    //    that export() would otherwise keep serializing, so "clear all data"
    //    would leave saves as slow as before.
    const roomy = { maxRows: 100_000, maxBytes: 64 * 1024 * 1024, perServiceFloor: 5_000, perServiceByteFloor: 50, byteCheckDelta: 1 << 30 };
    const store2 = new TelemetryStore(dbPath2, { raw_spans: roomy });
    await store2.initialize();
    store2.enablePersistence();
    for (let i = 1; i <= 200; i++) { store2.insertSpans([padSpan(i, 'noisy')]); }
    store2.flush();
    const before = fs.statSync(dbPath2).size;
    store2.clear();
    const after = fs.statSync(dbPath2).size;
    check(after < before, `clear() reclaims disk space (${before} -> ${after} bytes)`);
    eq(spanIds(store2.getDb()).length, 0, 'clear() empties the store');
    store2.close();
  } finally {
    cleanup();
  }
}

// ── session titles ───────────────────────────────────────────────────────────
// Titles arrive as one throwaway metadata span early in a session, so reading
// them back off the span list is unreliable: retention evicts old spans first,
// and a mid-session install never sees the span at all. The store projects
// titles into their own table, and untitled sessions fall back to a prompt.

const CONV_ATTR  = 'gen_ai.conversation.id';
const TITLE_SPAN = 'vscode.agent_host.session.title_changed';
const URI_ATTR   = 'vscode.agent_host.session.uri';

/** A ~PAD-byte title span for `session`, so retention treats it like any other.
 *  `uri` is the agent host's session URI — its scheme is the only signal that
 *  separates Claude from Codex from Copilot CLI. Omit it for a host build that
 *  doesn't send one. */
function titleSpan(i, session, title, uri) {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'copilot' } }] },
      scope: { name: 'title.test' },
      span: {
        traceId: String(i).padStart(32, '0'),
        spanId:  sid(i),
        name:    TITLE_SPAN,
        kind:    1,
        startTimeUnixNano: ns(i),
        endTimeUnixNano:   ns(i),
        status:  { code: 0 },
        attributes: [
          { key: CONV_ATTR, value: { stringValue: session } },
          { key: 'vscode.agent_host.session.title', value: { stringValue: title } },
          ...(uri === undefined ? [] : [{ key: URI_ATTR, value: { stringValue: uri } }]),
          { key: 'pad', value: { stringValue: 'x'.repeat(PAD) } },
        ],
      },
    }),
  };
}

/** An LLM span for `session` carrying a captured user prompt. */
function promptSpan(i, session, prompt, service = 'copilot') {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scope: { name: 'title.test' },
      span: {
        traceId: String(i).padStart(32, '0'),
        spanId:  sid(i),
        name:    'chat gpt-5',
        kind:    1,
        startTimeUnixNano: ns(i),
        endTimeUnixNano:   ns(i + 1),
        status:  { code: 0 },
        attributes: [
          { key: CONV_ATTR, value: { stringValue: session } },
          { key: 'gen_ai.request.model', value: { stringValue: 'gpt-5' } },
          {
            key: 'gen_ai.input.messages',
            value: { stringValue: JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: prompt }] }]) },
          },
        ],
      },
    }),
  };
}

async function sessionTitleChecks() {
  const dbPath = path.join(os.tmpdir(), `agent-titles-${process.pid}-${Date.now()}.db`);
  const cleanup = () => {
    for (const f of [dbPath, `${dbPath}.tmp`, `${dbPath}.sync.tmp`]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  };

  // Tight enough that a handful of padded spans evicts the earliest rows,
  // which is where the title spans sit.
  const limits = {
    maxRows: 1000, maxBytes: 4 * PAD,
    perServiceFloor: 5_000, perServiceByteFloor: 1, byteCheckDelta: 0,
  };
  const store = new TelemetryStore(dbPath, { raw_spans: limits });
  await store.initialize();
  store.enablePersistence();

  try {
    const db = store.getDb();

    // 1) The newest title wins.
    store.insertSpans([titleSpan(1, 'sess-a', 'First title')]);
    store.insertSpans([titleSpan(2, 'sess-a', 'Renamed session')]);
    store.insertSpans([promptSpan(3, 'sess-a', 'Ship the release')]);
    eq(engine.getSessionSummary(db, 'sess-a')?.title, 'Renamed session',
      'newest title wins');

    // 2) Retention evicts the title spans, but the title survives.
    for (let i = 10; i < 20; i++) { store.insertSpans([padSpan(i, 'copilot')]); }
    store.insertSpans([promptSpan(30, 'sess-a', 'Ship the release')]);
    const titleRows = db.prepare(
      `SELECT COUNT(*) AS n FROM raw_spans WHERE name = '${TITLE_SPAN}'`,
    ).get().n;
    eq(titleRows, 0, 'retention evicted every title span');
    eq(engine.getSessionSummary(db, 'sess-a')?.title, 'Renamed session',
      'title outlives the span that carried it');

    // 3) A session whose title span was never seen (extension installed
    //    mid-session) is labelled by its opening prompt.
    store.insertSpans([promptSpan(40, 'sess-b', 'Why is the build failing?')]);
    store.insertSpans([promptSpan(41, 'sess-b', 'Try again')]);
    const untitled = engine.getSessions(db).find(s => s.sessionId === 'sess-b') || {};
    eq(untitled.title, 'Why is the build failing?',
      'untitled session falls back to its opening prompt');

    // 4) Searching by title finds the session. Title spans live on a synthetic
    //    trace id that session queries exclude, so this needs its own lookup.
    const found = engine.getSessions(db, { nameSearch: 'Renamed' });
    check(found.some(s => s.sessionId === 'sess-a'), 'search matches a session title');
    check(found.every(s => s.sessionId !== 'sess-b'), 'title search excludes other sessions');
    eq((found.find(s => s.sessionId === 'sess-a') || {}).traceCount,
      (engine.getSessions(db).find(s => s.sessionId === 'sess-a') || {}).traceCount,
      'a title match returns the session with all its traces');

    // 5) Titles persist across a restart, and clearing removes them.
    store.flush();
    store.close();
    const reopened = new TelemetryStore(dbPath, { raw_spans: limits });
    await reopened.initialize();
    try {
      eq(engine.getSessionSummary(reopened.getDb(), 'sess-a')?.title, 'Renamed session',
        'title survives close and reopen');
      reopened.clear();
      eq(reopened.getDb().prepare('SELECT COUNT(*) AS n FROM session_titles').get().n, 0,
        'clear() removes stored titles');
    } finally {
      reopened.close();
    }
  } finally {
    try { store.close(); } catch { /* already closed */ }
    cleanup();
  }
}

// ── agent kind ───────────────────────────────────────────────────────────────
// Which agent the host launched, from the scheme of the title span's session
// URI. Distinct from service name, which each agent stamps on itself and the
// host has no say in (`claude` → `claude-code`, `copilotcli` → `github-copilot`,
// `codex` → `codex-app-server`). The scheme rides the same span, and the same
// conversation id, the title does.

async function sessionAgentKindChecks() {
  const dbPath = path.join(os.tmpdir(), `agent-kind-${process.pid}-${Date.now()}.db`);
  const cleanup = () => {
    for (const f of [dbPath, `${dbPath}.tmp`, `${dbPath}.sync.tmp`]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  };

  const store = new TelemetryStore(dbPath);
  await store.initialize();
  store.enablePersistence();

  try {
    const db = store.getDb();
    const get = id => engine.getSessions(db).find(s => s.sessionId === id) || {};

    // 1) The scheme is the agent kind, on both read paths.
    store.insertSpans([titleSpan(1, 'sess-x', 'Claude session', 'claude:/sess-x')]);
    store.insertSpans([promptSpan(2, 'sess-x', 'Ship it')]);
    eq(get('sess-x').agent, 'claude', 'session URI scheme is the agent kind');
    eq(engine.getSessionSummary(db, 'sess-x')?.agent, 'claude',
      'session summary reports the agent kind too');

    // The other two schemes the host emits, so no single-value coincidence passes.
    store.insertSpans([titleSpan(3, 'sess-y', 'CLI session', 'copilotcli:/sess-y')]);
    store.insertSpans([promptSpan(4, 'sess-y', 'Run the build')]);
    store.insertSpans([titleSpan(5, 'sess-z', 'Codex session', 'codex:/sess-z')]);
    store.insertSpans([promptSpan(6, 'sess-z', 'Refactor this')]);
    eq(get('sess-y').agent, 'copilotcli', 'copilotcli scheme survives');
    eq(get('sess-z').agent, 'codex', 'codex scheme survives');

    // 2) No URI at all (older host build, or capture off): title still resolves.
    store.insertSpans([titleSpan(7, 'sess-nouri', 'Untagged session')]);
    store.insertSpans([promptSpan(8, 'sess-nouri', 'Anything')]);
    eq(get('sess-nouri').agent, null, 'a title span with no URI yields no agent kind');
    eq(get('sess-nouri').title, 'Untagged session', 'the title still resolves without a URI');

    // 3) A URI with no colon: `instr` returns 0, and substr(...,1,-1) would give
    //    '' — NULL, not an empty-string agent that renders as a blank cell.
    store.insertSpans([titleSpan(9, 'sess-bad', 'Malformed', 'claude')]);
    store.insertSpans([promptSpan(10, 'sess-bad', 'Anything')]);
    eq(get('sess-bad').agent, null, 'a colonless URI yields no agent kind');

    // 4) A harness run outside the host emits no title span, so it has no agent
    //    kind and must fall back to its own service name. (Run *inside* the
    //    host, claude-code has both: its own spans and a `claude:` title span.)
    store.insertSpans([promptSpan(11, 'sess-cc', 'Direct export', 'claude-code')]);
    eq(get('sess-cc').agent, null, 'a session with no title span has no agent kind');
    eq(get('sess-cc').serviceName, 'claude-code', 'claude-code keeps its own service name');

    // 5) The agent kind lives with the title, so it outlives its span and a
    //    restart. A later title with no URI must not erase it.
    store.insertSpans([titleSpan(12, 'sess-x', 'Renamed, untagged')]);
    eq(get('sess-x').title, 'Renamed, untagged', 'the newer title still wins');
    eq(get('sess-x').agent, 'claude', 'a later untagged title does not erase the agent kind');

    store.flush();
    store.close();
    const reopened = new TelemetryStore(dbPath);
    await reopened.initialize();
    try {
      const after = engine.getSessions(reopened.getDb()).find(s => s.sessionId === 'sess-x') || {};
      eq(after.agent, 'claude', 'agent kind survives close and reopen');
    } finally {
      reopened.close();
    }
  } finally {
    try { store.close(); } catch { /* already closed */ }
    cleanup();
  }
}

// ── agent-host session anchors ───────────────────────────────────────────────
// microsoft/vscode#328529 routes native Copilot/Claude/Codex telemetry through
// the agent host, which parents provider spans under its own
// `vscode.agent_host.session` anchor on the SAME trace. That anchor is not
// agent activity: it must not be counted, must not be reported as the session's
// service (its name sorts after every provider's, so a plain MAX would win),
// and must not name the turn. It DOES carry the conversation id, which is the
// only thing tying a provider trace to its session.

const ANCHOR_SPAN = 'vscode.agent_host.session';
const NATIVE_TRACE = '9'.repeat(32);

/** One span in the native-session trace, from `service`. */
function nativeSpan(service, spanId, name, parentSpanId, attributes, at) {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scope: { name: 'agent-host.test' },
      span: {
        traceId: NATIVE_TRACE,
        spanId:  sid(spanId),
        ...(parentSpanId ? { parentSpanId: sid(parentSpanId) } : {}),
        name,
        kind: 1,
        startTimeUnixNano: ns(at),
        endTimeUnixNano:   ns(at + 10),
        status: { code: 0 },
        attributes,
      },
    }),
  };
}

async function agentHostAnchorChecks() {
  const dbPath = path.join(os.tmpdir(), `agent-host-${process.pid}-${Date.now()}.db`);
  const cleanup = () => {
    for (const f of [dbPath, `${dbPath}.tmp`, `${dbPath}.sync.tmp`]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  };

  const store = new TelemetryStore(dbPath);
  await store.initialize();
  store.enablePersistence();

  try {
    const db = store.getDb();

    // The host anchor is the trace root; the provider's own root hangs off it.
    store.insertSpans([
      nativeSpan('vscode-agent-host', 800, ANCHOR_SPAN, null,
        [{ key: CONV_ATTR, value: { stringValue: 'sess-native' } }], 800),
      nativeSpan('claude-code', 801, 'chat claude-opus-5', 800, [
        { key: 'session.id', value: { stringValue: 'sess-native' } },
        { key: 'gen_ai.request.model', value: { stringValue: 'claude-opus-5' } },
        { key: 'gen_ai.usage.input_tokens', value: { intValue: '120' } },
        { key: 'gen_ai.usage.output_tokens', value: { intValue: '30' } },
      ], 801),
      nativeSpan('claude-code', 802, 'execute_tool bash', 801,
        [{ key: 'gen_ai.tool.name', value: { stringValue: 'bash' } }], 802),
    ]);

    const session = engine.getSessions(db).find(s => s.sessionId === 'sess-native') || {};
    eq(session.sessionId, 'sess-native', 'host anchor keeps the provider trace resolvable to its session');
    eq(session.serviceName, 'claude-code', 'session reports the provider, not the agent host');
    eq(session.spanCount, 2, 'host anchor does not inflate session span count');
    eq(session.traceCount, 1, 'host anchor shares the provider trace');
    eq(session.totalTokens, 150, 'provider tokens survive the host anchor');

    const summary = engine.getSessionSummary(db, 'sess-native') || {};
    eq(summary.serviceName, 'claude-code', 'session summary reports the provider');
    eq(summary.spanCount, 2, 'session summary span count excludes the host anchor');
    eq((summary.turns || []).length, 1, 'session summary has the one native turn');
    eq((summary.turns || [])[0]?.rootName, 'chat claude-opus-5',
      'turn is named after the provider root, not the host anchor');
    eq((summary.turns || [])[0]?.spanCount, 2, 'turn span count excludes the host anchor');

    // A turn whose anchor was evicted by retention still resolves a root name.
    db.prepare(`DELETE FROM raw_spans WHERE span_id = ?`).run(sid(800));
    eq((engine.getSessionSummary(db, 'sess-native')?.turns || [])[0]?.rootName, 'chat claude-opus-5',
      'orphaned provider root is still named when the anchor is gone');

    // Losing the anchor drops the host's conversation id, but Claude also stamps
    // `session.id` on its own spans, so the session stays identified rather than
    // falling back to the trace id — and is never mistaken for background noise.
    const stillListed = engine.getSessions(db).find(s => s.sessionId === 'sess-native') || {};
    eq(stillListed.sessionId, 'sess-native', 'the session survives losing its host anchor');
    eq(stillListed.totalTokens, 150, 'the session keeps its token total without the anchor');
    eq(engine.getBackgroundTraceStats(db).traceCount, 0,
      'a trace that did agent work is never counted as background');
  } finally {
    try { store.close(); } catch { /* already closed */ }
    cleanup();
  }
}

// ── background traces ─────────────────────────────────────────────────────────
// SESSION_ID_EXPR falls back to trace_id when a trace carries no conversation
// key, minting one "session" per trace. Codex's app-server emits a trace for
// each piece of its own housekeeping (config reads, list_models, skills/list),
// none of which carry a conversation id — enough to bury the real sessions. Such
// traces are collapsed out of Sessions, but only when they ALSO show no agent
// activity, and they stay visible in Traces.

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
    eq(bg.traceCount, 3, 'background traces are counted, not silently dropped');
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

// ── Claude transcripts ────────────────────────────────────────────────────────
// Claude Code splits conversation content across two channels: the user's
// message is a `user_prompt` attribute on the `claude_code.interaction` span,
// while the model's reply is an OTel LOG record stamped with that same span id.
// The agent host routes provider logs past its own store (microsoft/vscode#328529),
// so this receiver is the only place the reply exists. getSessionMessages must
// rejoin them, or a fully captured Claude session renders as "no captured
// model responses".

/** One Claude content log record, stamped with the interaction span it belongs to. */
function claudeLog(at, spanId, attributes, severityNumber = 9) {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
      scope: { name: 'com.anthropic.claude_code.events' },
      logRecord: {
        timeUnixNano: ns(at),
        severityNumber,
        severityText: severityNumber >= 17 ? 'ERROR' : 'INFO',
        body: { stringValue: '' },
        traceId: NATIVE_TRACE,
        spanId: sid(spanId),
        attributes,
      },
    }),
  };
}

const strAttr = (key, v) => ({ key, value: { stringValue: v } });

async function claudeLogTranscriptChecks() {
  const dbPath = path.join(os.tmpdir(), `claude-logs-${process.pid}-${Date.now()}.db`);
  const cleanup = () => {
    for (const f of [dbPath, `${dbPath}.tmp`, `${dbPath}.sync.tmp`]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  };

  const store = new TelemetryStore(dbPath);
  await store.initialize();

  try {
    const db = store.getDb();

    // Claude spans never carry `gen_ai.output.messages` — the shape that
    // produced an empty transcript before the log fallback existed.
    store.insertSpans([
      nativeSpan('vscode-agent-host', 900, ANCHOR_SPAN, null,
        [{ key: CONV_ATTR, value: { stringValue: 'sess-claude' } }], 900),
      nativeSpan('claude-code', 901, 'claude_code.interaction', 900, [
        strAttr('session.id', 'sess-claude'),
        strAttr('user_prompt', [
          'summarize the repo',
          '<system-reminder>ignore me</system-reminder>',
          'Repository name: vscode',
          'Owner: microsoft',
          'Current branch: main',
          'Default branch: main',
          '',
          'Repository name: agent-insights',
          'Owner: michiisai',
          'Current branch: main',
          'Default branch: main',
        ].join('\n')),
      ], 901),
      // A second turn whose span recorded no prompt, so the response has to fall
      // back to threading through the log records' `prompt.id`.
      nativeSpan('claude-code', 902, 'claude_code.interaction', 900,
        [strAttr('session.id', 'sess-claude')], 905),
    ]);

    const beforeLogs = engine.getSessionMessages(db, 'sess-claude') || {};
    eq(beforeLogs.captureEnabled, false, 'claude session without content logs reports capture off');

    store.insertLogs([
      // Pure context injection: entirely <system-reminder>, so it must not be
      // shown as something the user said.
      claudeLog(902, 901, [
        strAttr('event.name', 'user_prompt'), strAttr('prompt.id', 'p-1'),
        { key: 'event.sequence', value: { intValue: '1' } },
        strAttr('prompt', '<system-reminder>editor context</system-reminder>'),
      ]),
      claudeLog(903, 901, [
        strAttr('event.name', 'assistant_response'), strAttr('prompt.id', 'p-1'),
        { key: 'event.sequence', value: { intValue: '2' } },
        strAttr('model', 'claude-opus-5'), strAttr('response', 'It is a telemetry viewer.'),
      ]),
      // Out-of-band ordering: a LATER sequence arriving first must still sort by time.
      claudeLog(907, 902, [
        strAttr('event.name', 'assistant_response'), strAttr('prompt.id', 'p-2'),
        { key: 'event.sequence', value: { intValue: '4' } },
        strAttr('model', 'claude-opus-5'), strAttr('response', 'Second answer.'),
      ], 17),
      claudeLog(906, 902, [
        strAttr('event.name', 'user_prompt'), strAttr('prompt.id', 'p-2'),
        { key: 'event.sequence', value: { intValue: '3' } },
        strAttr('prompt', 'and the tests?'),
      ]),
      // No response text — metadata only, so it must not become a turn.
      claudeLog(908, 902, [
        strAttr('event.name', 'assistant_response'), strAttr('prompt.id', 'p-2'),
        { key: 'event.sequence', value: { intValue: '5' } },
      ]),
    ]);

    const msgs = engine.getSessionMessages(db, 'sess-claude') || {};
    eq(msgs.captureEnabled, true, 'claude transcript is recovered from log records');
    eq((msgs.turns || []).length, 2, 'one turn per captured assistant_response with text');

    const [first, second] = msgs.turns;
    eq(first.model, 'claude-opus-5', 'claude turn carries the response model');
    eq(first.spanName, 'claude_code.interaction', 'claude turn names the span the log was stamped with');
    eq(first.inputPreview, 'summarize the repo',
      'user text strips system-reminder and trailing repository-context scaffolding');
    check(first.outputMessages.includes('It is a telemetry viewer.'),
      'claude response is reshaped into gen_ai.output.messages form');
    eq(JSON.parse(first.outputMessages)[0].role, 'assistant', 'reshaped claude turn is an assistant message');
    eq(first.hasError, false, 'INFO-severity claude turn is not an error');

    eq(second.inputPreview, 'and the tests?',
      'a turn whose span recorded no prompt threads through the log prompt.id');
    eq(second.hasError, true, 'ERROR-severity claude response is flagged');
    check(BigInt(second.startTimeUnixNano) > BigInt(first.startTimeUnixNano),
      'claude turns are ordered by log timestamp');

    // The same log records are the last resort for a label. Here the session's
    // FIRST prompt record is entirely a system-reminder, so titling has to look
    // past it rather than settle for untitled.
    const listed = engine.getSessions(db).find(s => s.sessionId === 'sess-claude') || {};
    eq(listed.title, 'and the tests?',
      'a claude session with no title span is labelled from its prompt logs');
  } finally {
    try { store.close(); } catch { /* already closed */ }
    cleanup();
  }
}

// ── Codex-shaped log records ─────────────────────────────────────────────────
// Codex emits valid OTLP that uses two fields differently from Claude and
// Copilot, and both differences silently voided its logs:
//
//   "timeUnixNano": "0"  with the real clock in observedTimeUnixNano
//   "body": null         with the message in the event.name attribute
//
// The old derivation COALESCEd on NULL alone, so the literal "0" won and every
// Codex log landed at the epoch — sorted last, rendered as 1970, and dropped by
// any time window — while `body` came out empty and the Logs tab showed blanks.

/** One log record, in whatever shape the caller wants to exercise. */
function logRow(service, logRecord) {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scope: { name: 'codex_otel.log_only' },
      logRecord,
    }),
  };
}

async function codexLogShapeChecks() {
  const dbPath = path.join(os.tmpdir(), `codex-logs-${process.pid}-${Date.now()}.db`);
  const cleanup = () => {
    for (const f of [dbPath, `${dbPath}.tmp`, `${dbPath}.sync.tmp`]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  };

  let store = new TelemetryStore(dbPath);
  await store.initialize();

  try {
    store.enablePersistence();
    store.insertLogs([
      // The dominant Codex shape: zeroed time, null body, name + kind.
      logRow('codex-app-server', {
        timeUnixNano: '0', observedTimeUnixNano: ns(500),
        severityNumber: 9, severityText: 'INFO', body: null,
        eventName: 'event otel\\src\\events\\session_telemetry.rs:927',
        attributes: [
          strAttr('event.name', 'codex.sse_event'),
          strAttr('event.kind', 'response.completed'),
        ],
      }),
      // No kind to qualify it — the name alone is the message.
      logRow('codex-app-server', {
        timeUnixNano: '0', observedTimeUnixNano: ns(510),
        severityNumber: 9, severityText: 'INFO', body: null,
        attributes: [strAttr('event.name', 'codex.startup_phase')],
      }),
      // Neither attribute: eventName is the last resort, not a blank row.
      logRow('codex-app-server', {
        timeUnixNano: '0', observedTimeUnixNano: ns(520),
        severityNumber: 9, severityText: 'INFO', body: null,
        eventName: 'event otel\\src\\lib.rs:12', attributes: [],
      }),
      // An ordinary record must be untouched by any of the fallbacks: its own
      // clock wins over observedTimeUnixNano, its own body over event.name.
      logRow('claude-code', {
        timeUnixNano: ns(530), observedTimeUnixNano: ns(999),
        severityNumber: 17, severityText: 'ERROR',
        body: { stringValue: 'upstream rate limited' },
        attributes: [strAttr('event.name', 'api_request')],
      }),
    ]);

    const db = store.getDb();
    const byBody = (needle) => engine.getLogs(db).find(l => (l.body || '').includes(needle)) || {};

    const sse = byBody('codex.sse_event');
    eq(sse.body, 'codex.sse_event: response.completed',
      'a null body falls back to event.name qualified by event.kind');
    eq(sse.timestampUnixNano, ns(500),
      'a zeroed timeUnixNano falls through to observedTimeUnixNano');

    eq(byBody('codex.startup_phase').body, 'codex.startup_phase',
      'event.name stands alone when there is no event.kind');
    check(byBody('lib.rs:12').body.startsWith('event '),
      'eventName is used when no event attribute names the record');

    const claude = byBody('rate limited');
    eq(claude.timestampUnixNano, ns(530), 'a real timeUnixNano is preferred over observedTimeUnixNano');
    eq(claude.body, 'upstream rate limited', 'a populated body is never replaced by event.name');

    // The regression that mattered most: epoch-stamped logs vanished from every
    // windowed query, so they were missing rather than merely misplaced.
    const windowed = engine.getLogs(db, { sinceNano: ns(400), untilNano: ns(600) });
    eq(windowed.length, 4, 'codex logs survive a time window that spans their real timestamps');
    eq(windowed[0].timestampUnixNano, ns(530), 'logs sort newest-first on the corrected timestamps');

    // Every existing store holds these rows already derived the old way. Force
    // the version marker back and reopen: the backfill must repair them.
    db.exec('UPDATE raw_logs SET derived_v = 1, timestamp_unix_nano = \'0\', body = \'\'');
    store.flush();
    store.close();

    store = new TelemetryStore(dbPath);
    await store.initialize();
    const fixed = engine.getLogs(store.getDb()).find(l => (l.body || '').includes('codex.sse_event')) || {};
    eq(fixed.timestampUnixNano, ns(500), 'stale rows are re-derived on the version bump');
    eq(fixed.body, 'codex.sse_event: response.completed', 'stale bodies are re-derived too');
  } finally {
    try { store.close(); } catch { /* already closed */ }
    cleanup();
  }
}

// ── Codex session transcripts ────────────────────────────────────────────────
// Codex reports conversation content only as log records, and only the user's
// half of it: `codex.user_prompt` carries what was typed, `codex.tool_result`
// carries what the agent did, and the model's prose is stripped from the
// `codex.sse_event` stream before export. It also emits no title span, so the
// session list has to reach the same logs for a label and the anchor span's
// URI for the agent badge — otherwise every Codex session lists as an
// untitled, unattributed row with an empty transcript.

const CODEX_TRACE = 'c0'.repeat(16);

/** One span on the Codex session trace, from `service`. */
function codexSpan(service, spanId, name, parentSpanId, attributes, at) {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scope: { name: 'agent-host.test' },
      span: {
        traceId: CODEX_TRACE,
        spanId:  sid(spanId),
        ...(parentSpanId ? { parentSpanId: sid(parentSpanId) } : {}),
        name,
        kind: 1,
        startTimeUnixNano: ns(at),
        endTimeUnixNano:   ns(at + 10),
        status: { code: 0 },
        attributes,
      },
    }),
  };
}

/** One Codex content log — zeroed clock and null body, as Codex really sends. */
function codexLog(at, attributes) {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'codex-app-server' } }] },
      scope: { name: 'codex_otel.log_only' },
      logRecord: {
        timeUnixNano: '0', observedTimeUnixNano: ns(at),
        severityNumber: 9, severityText: 'INFO', body: null,
        traceId: CODEX_TRACE,
        spanId: sid(701),
        attributes,
      },
    }),
  };
}

async function codexSessionTranscriptChecks() {
  const dbPath = path.join(os.tmpdir(), `codex-session-${process.pid}-${Date.now()}.db`);
  const cleanup = () => {
    for (const f of [dbPath, `${dbPath}.tmp`, `${dbPath}.sync.tmp`]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  };

  const store = new TelemetryStore(dbPath);
  await store.initialize();

  try {
    const db = store.getDb();

    // No title span anywhere: the anchor is the only thing that names the agent,
    // and it carries the URI the title span would otherwise have carried.
    store.insertSpans([
      codexSpan('vscode-agent-host', 700, ANCHOR_SPAN, null, [
        strAttr(CONV_ATTR, 'sess-codex'),
        strAttr('vscode.agent_host.session.uri', 'codex:/sess-codex'),
      ], 700),
      // Codex's own spans are Rust `tracing` internals — no conversation id, no
      // gen_ai attributes. They exist only so the trace shows agent activity.
      codexSpan('codex-app-server', 701, 'append_items', 700,
        [strAttr('code.file.path', 'core/src/rollout.rs')], 701),
      // Thread startup names the model it *would* use, so a chat that was opened
      // and never typed into still looks model-bearing.
      codexSpan('codex-app-server', 702, 'get_model_info', 701,
        [strAttr('model', 'gpt-5-codex')], 702),
    ]);

    // The host mints the conversation id when the chat is created, not when it
    // is first used, so this much telemetry is a chat nobody has typed into.
    // It has a conversation key and a model, and is still not a conversation.
    eq(engine.getSessions(db).find(s => s.sessionId === 'sess-codex'), undefined,
      'a keyed chat with only thread-startup spans is not listed as a session');
    eq(engine.getBackgroundTraceStats(db).traceCount, 1,
      'the unused chat is disclosed as a background trace rather than dropped silently');

    store.insertLogs([
      // A session commonly opens with a record that is nothing but injected
      // context. It is not something the user said, so it must neither become a
      // turn nor be taken as the session's label.
      codexLog(705, [
        strAttr('event.name', 'codex.user_prompt'),
        strAttr('prompt', [
          'Repository name: agent-insights',
          'Owner: michiisai',
          'Current branch: main',
          'Default branch: main',
        ].join('\n')),
      ]),
      // The host injects its repository block *between* the user's words and the
      // file they attached, so it is not a trailing suffix and has to be matched
      // as a standalone paragraph.
      codexLog(710, [
        strAttr('event.name', 'codex.user_prompt'),
        strAttr('model', 'gpt-5-codex'),
        strAttr('prompt', [
          'is this emitting otel metrics',
          '',
          'Repository name: vscode',
          'Owner: microsoft',
          'Current branch: main',
          'Default branch: main',
          '',
          '@c:\\src\\OTEL.md',
        ].join('\n')),
      ]),
      // Content-free stream events must not become turns or parts.
      codexLog(711, [
        strAttr('event.name', 'codex.sse_event'),
        strAttr('event.kind', 'response.output_text.delta'),
      ]),
      codexLog(712, [
        strAttr('event.name', 'codex.tool_result'),
        strAttr('tool_name', 'shell_command'), strAttr('call_id', 'call-1'),
        strAttr('arguments', '{"command":"npm test"}'),
        strAttr('output', 'ok'), strAttr('success', 'true'),
      ]),
      codexLog(713, [
        strAttr('event.name', 'codex.tool_result'),
        strAttr('tool_name', 'shell_command'), strAttr('call_id', 'call-2'),
        strAttr('arguments', '{"command":"npm run typecheck"}'),
        strAttr('success', 'false'),
      ]),
      // A prompt Codex answered in prose alone: no tool_result follows, and the
      // reply text was stripped before export. It is still a turn.
      codexLog(714, [
        strAttr('event.name', 'codex.user_prompt'),
        strAttr('prompt', 'and the tests?'),
      ]),
    ]);

    const msgs = engine.getSessionMessages(db, 'sess-codex') || {};
    eq(msgs.captureEnabled, true, 'codex transcript is recovered from log records');
    eq((msgs.turns || []).length, 2, 'each codex.user_prompt opens a turn');

    const [first, second] = msgs.turns;
    eq(first.inputPreview, 'is this emitting otel metrics\n\n@c:\\src\\OTEL.md',
      'a repository block wedged mid-prompt is stripped without taking the file reference with it');
    eq(first.model, 'gpt-5-codex', 'codex turn carries the prompt model');
    eq(first.hasError, true, 'a tool_result with success=false flags the turn');
    check(BigInt(first.startTimeUnixNano) >= BigInt(ns(712)),
      'a codex turn is stamped when the agent replied, not when the prompt was typed');

    const parts = JSON.parse(first.outputMessages)[0].parts;
    eq(JSON.parse(first.outputMessages)[0].role, 'assistant', 'reshaped codex turn is an assistant message');
    eq(parts.length, 3, 'each tool call is a part, and its output another — the SSE event is neither');
    eq(parts[0].type, 'tool_call', 'tool activity is reshaped into gen_ai tool_call parts');
    eq(parts[0].name, 'shell_command', 'the tool call keeps its name');
    eq(parts[1].type, 'tool_call_response', 'a tool result with output emits a response part');
    eq(parts[1].id, 'call-1', 'call and response are paired by call_id');
    eq(parts[2].id, 'call-2', 'a tool result with no output emits the call alone');

    eq(second.inputPreview, 'and the tests?', 'the second prompt closes the turn before it');
    eq(JSON.parse(second.outputMessages)[0].parts.length, 0,
      'a prompt whose reply was never exported is still a turn, with nothing to show');
    // The label has to come from the same logs: Codex captures no span content
    // and emits no title span, so without this every Codex session is untitled.
    const listed = engine.getSessions(db).find(s => s.sessionId === 'sess-codex') || {};
    eq(listed.title, 'is this emitting otel metrics @c:\\src\\OTEL.md',
      'a codex session is titled from its opening prompt log, skipping context-only records');
    eq(listed.serviceName, 'codex-app-server', 'codex session reports the provider, not the host');
    eq(listed.agent, 'codex', 'agent badge falls back to the anchor span URI when no title span exists');

    // The prompt is the only thing that made it a session — Codex's spans carry
    // no gen_ai attributes, so span-derived activity alone never sees it.
    eq(listed.llmRequestCount, 0, 'codex reports no gen_ai request spans to count');
    eq(engine.getBackgroundTraceStats(db).traceCount, 0,
      'a chat that captured a prompt stops being background');
  } finally {
    try { store.close(); } catch { /* already closed */ }
    cleanup();
  }
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

    // 5) Metrics dashboard: token usage + summary counts through the views.
    const md = engine.getMetricsData(db);
    const gpt = md.tokenUsage.find(t => t.model === 'gpt-4o') || {};
    eq(gpt.promptTokens, 1024, 'token usage prompt_tokens aggregated');
    eq(gpt.completionTokens, 256, 'token usage completion_tokens aggregated');
    eq(md.summary.totalSpans, 6, 'summary.totalSpans');
    eq(md.summary.totalTraces, 4, 'summary.totalTraces');
    eq(md.summary.totalLogs, 2, 'summary.totalLogs');
    eq(md.summary.totalMetricPoints, 20, 'summary.totalMetricPoints (gauge + sum + histogram data points)');
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
    eq(resets.chart.kind, 'activity', 'monotonic counter is presented as interval activity');
    eq(JSON.stringify(resets.chart.series.map(p => p.value)), JSON.stringify([16]),
      'fixed activity bucket excludes usage that predates the first available report');
    eq(resets.chart.unattributed, 5, 'first cumulative value is identified as untimed prior usage');
    eq(resets.chart.total, resets.stats.total, 'counter activity chart reconciles with the reported total');
    const toolDimension = resets.dimensions.find(d => d.key === 'tool') || {};
    const editContribution = (toolDimension.values || []).find(v => v.value === 'edit') || {};
    eq(editContribution.total, 21, 'metric dimension total preserves cumulative contribution across resets');
    eq(editContribution.count, 2, 'metric dimension count reports contributing runs');
    const memory = engine.getMetricDetail(db, 'process.runtime.memory', resetSvc);
    const stateDimension = memory.dimensions.find(d => d.key === 'state') || {};
    eq(stateDimension.values[0]?.value, 'used', 'metric dimension values rank by contribution total');
    eq(stateDimension.values[0]?.total, 734003200.5, 'metric dimension preserves gauge contribution total');

    // Window starting after the first run ended: only the second run contributes.
    eq(engine.getMetricDetail(db, 'test.counter.resets', resetSvc, ns(25)).stats.total, 9,
      'windowed total counts a run with no pre-window baseline in full');
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
    eq(tokenHistogram.chart.unattributed, 1280,
      'token usage before the first available report is not rendered as a timed spike');
    const tokenTypeBreakdown = (tokenHistogram.chart.breakdowns || []).find(b => b.key === 'tokenType') || {};
    eq(JSON.stringify((tokenTypeBreakdown.series || []).map(s => s.label)), JSON.stringify(['Input', 'Output']),
      'Copilot token types are normalized into a stacked breakdown');
    eq(JSON.stringify((tokenTypeBreakdown.series || []).map(s => s.points[0]?.value)), JSON.stringify([200, 120]),
      'Copilot token-type stacks contain interval activity');
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
    eq(durationHistogram.chart.unattributedCount, 2,
      'cumulative observations before the first report are identified');
    eq(JSON.stringify(durationHistogram.chart.series.map(p => p.value)), JSON.stringify([10]),
      'duration chart averages the observed histogram sum and count changes');

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
    check(msgs.turns[0].hasError === true, 'session messages turn surfaces error status');
    check(msgs.turns[0].outputMessages.includes('Order placed.'),
      'session messages carries raw output messages JSON');
    eq(msgs.turns[0].inputPreview, 'Place my order', 'session messages extracts last user prompt');
    check(engine.getSessionMessages(db, 'nonexistent-session') === null,
      'getSessionMessages returns null for unknown session');
    check(engine.getSessionMessages(db, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') === null,
      'getSessionMessages excludes copilot-chat utility trace');

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
  } finally {
    await receiver.stop();
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }

  await retentionChecks();
  await materializationChecks();
  await sessionTitleChecks();
  await sessionAgentKindChecks();
  await agentHostAnchorChecks();
  await backgroundTraceChecks();
  await claudeLogTranscriptChecks();
  await codexLogShapeChecks();
  await codexSessionTranscriptChecks();

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
