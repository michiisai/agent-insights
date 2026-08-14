'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore } = require('@agent-insights/receiver');
const { check, eq } = require('../lib/assert');
const { sid } = require('../lib/otlp');
const { padSpan, spanIds, PAD } = require('../lib/fixtures');

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

module.exports = { materializationChecks };
