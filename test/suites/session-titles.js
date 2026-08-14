'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { check, eq } = require('../lib/assert');
const { titleSpan, promptSpan, chatSpan, padSpan, PAD, TITLE_SPAN } = require('../lib/fixtures');

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

    // 3a) Agent Host wraps the prompt in context it injected: a leading
    //     <current_datetime> stamp (66 chars, over half the label budget) and
    //     trailing <system_reminder> / <tagged_files> sections. Cleaning has to
    //     happen before the cap or the label is nothing but a timestamp.
    store.insertSpans([promptSpan(45, 'sess-ctx', [
      '<current_datetime>2026-08-07T10:28:23.912-07:00</current_datetime>',
      '',
      'what are the current fallbacks for session titles',
      '',
      '<system_reminder>',
      '<sql_tables>Available tables: todos, todo_deps</sql_tables>',
      '</system_reminder>',
      '',
      '<tagged_files>',
      '* c:\\src\\webview.js (3770 lines)',
      '</tagged_files>',
    ].join('\n'))]);
    eq((engine.getSessions(db).find(s => s.sessionId === 'sess-ctx') || {}).title,
      'what are the current fallbacks for session titles',
      'a span-derived title strips the context blocks Agent Host injected');

    // 3b) Prose that merely mentions a tag is not scaffolding: only a complete
    //     block standing on its own lines is, so inline angle brackets survive.
    store.insertSpans([promptSpan(46, 'sess-inline', 'why does #include <string> fail')]);
    eq((engine.getSessions(db).find(s => s.sessionId === 'sess-inline') || {}).title,
      'why does #include <string> fail',
      'inline angle brackets are left in the label');

    // 3c) A first user message that is entirely injected context cleans away to
    //     nothing, so titling looks at the next one rather than giving up —
    //     the span-content analogue of the log path's lookahead.
    store.insertSpans([chatSpan(47, 'sess-skip', [
      { role: 'user',      parts: [{ type: 'text', content: '<system_reminder>\neditor context\n</system_reminder>' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'ignored: not a user turn' }] },
      { role: 'user',      parts: [{ type: 'text', content: 'now do the thing' }] },
    ])]);
    eq((engine.getSessions(db).find(s => s.sessionId === 'sess-skip') || {}).title,
      'now do the thing',
      'titling skips a user message that is pure injected context');

    // 3d) The transcript keeps what the label strips: the webview renders these
    //     blocks as collapsed, labelled sections, so pre-stripping them here
    //     would lose content the reader asked for.
    store.insertSpans([chatSpan(48, 'sess-keep',
      [{ role: 'user', parts: [{ type: 'text', content: 'ship it\n\n<tagged_files>\n* a.ts\n</tagged_files>' }] }],
      [{ role: 'assistant', parts: [{ type: 'text', content: 'done' }] }])]);
    const kept = engine.getSessionMessages(db, 'sess-keep') || {};
    check((kept.turns || [])[0]?.inputPreview?.includes('<tagged_files>'),
      'a transcript turn keeps the context blocks the label strips');

    // 3e) Skills are injected as a final user-role message whose opening tag has
    //     both a hyphenated name and an attribute. It is scaffolding, not the
    //     prompt that produced the response, so the transcript uses the preceding
    //     user message just as it does for plain context blocks.
    store.insertSpans([chatSpan(49, 'sess-skill', [
      { role: 'user', parts: [{ type: 'text', content: 'explain the first user message' }] },
      { role: 'user', parts: [{ type: 'text', content: '<skill-context name="agent-insights">\ninjected instructions\n</skill-context>' }] },
    ], [{ role: 'assistant', parts: [{ type: 'text', content: 'done' }] }])]);
    const skillTurn = (engine.getSessionMessages(db, 'sess-skill')?.turns || [])[0];
    eq(skillTurn?.inputPreview, 'explain the first user message',
      'a transcript skips an attribute-bearing injected skill context message');

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

module.exports = { sessionTitleChecks };
