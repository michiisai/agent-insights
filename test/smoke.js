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

/** A ~PAD-byte title span for `session`, so retention treats it like any other. */
function titleSpan(i, session, title) {
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
          { key: 'pad', value: { stringValue: 'x'.repeat(PAD) } },
        ],
      },
    }),
  };
}

/** An LLM span for `session` carrying a captured user prompt. */
function promptSpan(i, session, prompt) {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'copilot' } }] },
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
