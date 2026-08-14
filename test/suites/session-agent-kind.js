'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { check, eq } = require('../lib/assert');
const { titleSpan, promptSpan } = require('../lib/fixtures');

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

module.exports = { sessionAgentKindChecks };
