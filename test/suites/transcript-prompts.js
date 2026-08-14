'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { check, eq } = require('../lib/assert');
const { chatSpan } = require('../lib/fixtures');

async function transcriptPromptChecks() {
  const dbPath = path.join(os.tmpdir(), `agent-prompts-${process.pid}-${Date.now()}.db`);
  const cleanup = () => {
    for (const f of [dbPath, `${dbPath}.tmp`, `${dbPath}.sync.tmp`]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  };

  const store = new TelemetryStore(dbPath);
  await store.initialize();

  try {
    const db = store.getDb();
    const answered = [{ role: 'assistant', parts: [{ type: 'text', content: 'answered' }] }];
    const turnOf = (session) =>
      ((engine.getSessionMessages(db, session) || {}).turns || [])[0] || {};

    // 1) A session's opening request ends with a SEPARATE, scaffolding-only user
    //    message declaring the deferred tool manifest. Reading the last user
    //    message outright showed that reminder and dropped the question above
    //    it, so the first turn of every session rendered as nothing but a
    //    collapsed reminder.
    const deferredTools = `<system_reminder>\nIMPORTANT: The tools listed below are deferred.\n${
      'tool docs. '.repeat(150)}\n</system_reminder>`;
    store.insertSpans([chatSpan(60, 'sess-opening', [
      { role: 'user', parts: [{ type: 'text', content: 'is this the best name?\n\n<tagged_files>\n* a.ts\n</tagged_files>' }] },
      { role: 'user', parts: [{ type: 'text', content: deferredTools }] },
    ], answered)]);
    const opening = turnOf('sess-opening');
    check(opening.inputPreview?.includes('is this the best name?'),
      'the prompt is read past a trailing scaffolding-only user message');
    check(!opening.inputPreview?.includes('deferred'),
      'the trailing tool manifest does not stand in for the prompt');
    check(opening.inputPreview?.includes('<tagged_files>'),
      'the chosen message still keeps its own context blocks for the transcript');

    // 2) The chosen message must also arrive whole. A cap truncated from the
    //    front, where the host's injected context sits, so the prompt was cut
    //    off inside the scaffolding. The webview only offers "Show full message"
    //    above 800 chars, so a preview capped below that could never expand.
    const longPrompt = `<current_datetime>2026-08-11T10:11:07.208-07:00</current_datetime>\n\n${
      'why is this happening and what should I do about it?\n'.repeat(30)}`.trim();
    check(longPrompt.length > 800, 'the fixture is long enough to exercise both limits');
    store.insertSpans([chatSpan(61, 'sess-long',
      [{ role: 'user', parts: [{ type: 'text', content: longPrompt }] }], answered)]);
    const long = turnOf('sess-long');
    eq(long.inputPreview?.length, longPrompt.length, 'a transcript prompt arrives whole');
    check(!long.inputPreview?.endsWith('…'), 'a transcript prompt is not truncated');
    check((long.inputPreview?.length || 0) > 800,
      'a long prompt stays long enough for the webview to offer expansion');

    // 3) Every user message being pure injection is not a reason to render an
    //    empty bubble — something was sent, so the last one still shows.
    store.insertSpans([chatSpan(62, 'sess-allctx',
      [{ role: 'user', parts: [{ type: 'text', content: '<system_reminder>\nonly context\n</system_reminder>' }] }],
      answered)]);
    check(turnOf('sess-allctx').inputPreview?.includes('only context'),
      'a turn whose every user message is injection still shows the last one');

    // 4) The ordinary case still anchors to the LAST real message, not the first:
    //    a turn mid-conversation replays history and must show the newest ask.
    store.insertSpans([chatSpan(63, 'sess-multi', [
      { role: 'user', parts: [{ type: 'text', content: 'the first thing I asked' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'ok' }] },
      { role: 'user', parts: [{ type: 'text', content: 'the newest thing I asked' }] },
    ], answered)]);
    eq(turnOf('sess-multi').inputPreview, 'the newest thing I asked',
      'replayed history still anchors the turn to the newest real prompt');
  } finally {
    store.close();
    cleanup();
  }
}

module.exports = { transcriptPromptChecks };
