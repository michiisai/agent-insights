'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore } = require('@agent-insights/receiver');
const { check, eq } = require('../lib/assert');
const { sid } = require('../lib/otlp');
const { padSpan, spanIds, PAD } = require('../lib/fixtures');

// Mirrors the store's byte budget, which counts the payload columns together:
// `attributes` holds a flattened copy of the same content as `raw`, so counting
// raw alone understates the real footprint by close to half.
const rawBytes = (db) => db.prepare('SELECT COALESCE(SUM(LENGTH(raw) + COALESCE(LENGTH(attributes),0)), 0) AS b FROM raw_spans').get().b;

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

    // 3) A retained child keeps its older parent. Otherwise agent-host anchors
    // and invocation roots disappear first and leave misleading orphan trees.
    const treeTrace = 'ab'.repeat(16);
    store.insertSpans([padSpan(600, 'tree', { traceId: treeTrace })]);
    store.insertSpans([padSpan(601, 'tree', { traceId: treeTrace, parentSpanId: sid(600) })]);
    check(spanIds(db).includes(sid(601)), 'retention keeps the newest child span');
    check(spanIds(db).includes(sid(600)), 'retention preserves a parent referenced by a retained child');

    // 4) Saves are atomic: written beside the database, then renamed over it, so
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
    // Three services are present, each keeps its newest row, and the retained
    // tree child also protects its parent, so integrity can hold a few rows
    // beyond the byte target.
    const widest = tighter.getDb()
      .prepare('SELECT MAX(LENGTH(raw) + COALESCE(LENGTH(attributes),0)) AS b FROM raw_spans').get().b;
    const tightenedBytes = rawBytes(tighter.getDb());
    check(tightenedBytes <= 2 * PAD + 4 * widest,
      `startup reclaim applies a tighter byte budget to an existing file (${tightenedBytes})`);
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

module.exports = { retentionChecks };
