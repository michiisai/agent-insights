'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { check, eq } = require('../lib/assert');
const { ns } = require('../lib/otlp');
const { logRow, strAttr } = require('../lib/fixtures');

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

module.exports = { codexLogShapeChecks };
