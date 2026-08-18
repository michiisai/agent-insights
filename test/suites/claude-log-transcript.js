'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { check, eq } = require('../lib/assert');
const { sid } = require('../lib/otlp');
const { nativeSpan, providerSpan, claudeLog, strAttr, CONV_ATTR, ANCHOR_SPAN, NATIVE_TRACE } = require('../lib/fixtures');

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
        // The host's real injection shape, and the one that used to survive
        // cleaning: a single newline glues the first block to what the user
        // typed, blocks are joined to each other by a blank line (one per repo
        // in a multi-root window), and the reminder trails the lot.
        strAttr('user_prompt', [
          'summarize the repo',
          'Repository name: vscode',
          'Owner: microsoft',
          'Current branch: main',
          'Default branch: main',
          '',
          'Repository name: agent-insights',
          'Owner: michiisai',
          'Current branch: main',
          'Default branch: main',
          '<system-reminder>ignore me</system-reminder>',
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
        { key: 'event.sequence', value: { intValue: '6' } },
        strAttr('model', 'claude-opus-5'), strAttr('response', 'Second answer.'),
      ], 17),
      claudeLog(906, 902, [
        strAttr('event.name', 'user_prompt'), strAttr('prompt.id', 'p-2'),
        { key: 'event.sequence', value: { intValue: '3' } },
        // Single block, no reminder to break the paragraph — the shape most
        // captured prompts actually have, on the log channel this time.
        strAttr('prompt', [
          'and the tests?',
          'Repository name: agent-insights',
          'Owner: michiisai',
          'Current branch: main',
          'Default branch: main',
        ].join('\n')),
      ]),
      claudeLog(9061, 902, [
        strAttr('event.name', 'api_request'), strAttr('prompt.id', 'p-2'),
        { key: 'event.sequence', value: { intValue: '4' } },
        strAttr('model', 'claude-opus-5'), strAttr('effort', 'high'),
        strAttr('speed', 'normal'), strAttr('query_source', 'repl_main_thread'),
        { key: 'input_tokens', value: { intValue: '500' } },
        { key: 'output_tokens', value: { intValue: '80' } },
      ]),
      claudeLog(9062, 902, [
        strAttr('event.name', 'tool_result'), strAttr('prompt.id', 'p-2'),
        { key: 'event.sequence', value: { intValue: '5' } },
        strAttr('tool_name', 'Bash'), strAttr('tool_use_id', 'tool-1'),
        strAttr('success', 'true'), strAttr('decision_source', 'user_temporary'),
        strAttr('tool_input', '{"command":"npm test"}'),
        { key: 'duration_ms', value: { intValue: '42' } },
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
      'user text strips a repository-context stack the host glued on with one newline');
    check(first.outputMessages.includes('It is a telemetry viewer.'),
      'claude response is reshaped into gen_ai.output.messages form');
    eq(JSON.parse(first.outputMessages)[0].role, 'assistant', 'reshaped claude turn is an assistant message');
    eq(first.hasError, false, 'INFO-severity claude turn is not an error');

    eq(second.inputPreview, 'and the tests?',
      'a turn whose span recorded no prompt threads through the log prompt.id, repository context stripped');
    eq(second.hasError, true, 'ERROR-severity claude response is flagged');
    check(BigInt(second.startTimeUnixNano) > BigInt(first.startTimeUnixNano),
      'claude turns are ordered by log timestamp');
    const secondParts = JSON.parse(second.outputMessages)[0].parts;
    check(secondParts.some(part => part.type === 'tool_call' && part.name === 'Bash'),
      'claude tool events are included in the prompt turn');
    check(secondParts.some(part => part.type === 'tool_call_response' && part.id === 'tool-1'),
      'claude tool result metadata is paired with its call');
    check(second.details.some(section => section.title === 'API request'
      && section.items.some(item => item.label === 'Effort' && item.value === 'high')),
    'claude API effort is exposed as rich turn metadata');
    check(second.details.some(section => section.title === 'Tool result · Bash'
      && section.items.some(item => item.label === 'Decision source' && item.value === 'user_temporary')),
    'claude tool permission metadata is exposed');

    // Missing prompt IDs are common, and one session can span multiple traces.
    // Interleaved traces must keep their fallback prompt/tool state independent.
    const traceA = 'a1'.repeat(16);
    const traceB = 'b2'.repeat(16);
    store.insertSpans([
      providerSpan(traceA, 'claude-code', 920, 'claude_code.interaction', null,
        [strAttr('session.id', 'sess-interleaved'), strAttr('user_prompt', 'alpha prompt')], 920),
      providerSpan(traceB, 'claude-code', 921, 'claude_code.interaction', null,
        [strAttr('session.id', 'sess-interleaved'), strAttr('user_prompt', 'beta prompt')], 921),
    ]);
    store.insertLogs([
      claudeLog(920, 920, [
        strAttr('event.name', 'user_prompt'), strAttr('prompt', '<system-reminder>context</system-reminder>'),
      ], 9, traceA),
      claudeLog(921, 921, [
        strAttr('event.name', 'user_prompt'), strAttr('prompt', '<system-reminder>context</system-reminder>'),
      ], 9, traceB),
      claudeLog(922, 920, [
        strAttr('event.name', 'tool_result'), strAttr('tool_name', 'Read'),
        strAttr('tool_use_id', 'trace-a-tool'), strAttr('success', 'true'),
      ], 9, traceA),
      claudeLog(923, 920, [
        strAttr('event.name', 'assistant_response'), strAttr('response', 'alpha answer'),
      ], 9, traceA),
      claudeLog(924, 921, [
        strAttr('event.name', 'assistant_response'), strAttr('response', 'beta answer'),
      ], 9, traceB),
    ]);
    const interleaved = (engine.getSessionMessages(db, 'sess-interleaved') || {}).turns || [];
    const alpha = interleaved.find(turn => turn.traceId === traceA) || {};
    const beta = interleaved.find(turn => turn.traceId === traceB) || {};
    eq(alpha.inputPreview, 'alpha prompt', 'prompt fallback state is scoped to the physical trace');
    check(alpha.outputMessages.includes('trace-a-tool'), 'trace-local tool metadata stays on the alpha turn');
    check(!beta.outputMessages.includes('trace-a-tool'), 'interleaved beta turn does not inherit alpha tools');

    // The Traces tab reaches the same log-sourced transcript by trace id, with no
    // session to key off — and a segment of that trace gets only its own turns,
    // even though the log records themselves are keyed by trace alone.
    const byTrace = engine.getTraceMessages(db, NATIVE_TRACE) || {};
    eq(byTrace.captureEnabled, true, 'claude log fallback is reached by trace id');
    eq((byTrace.turns || []).length, 2, 'trace transcript recovers both claude turns');
    const secondInteraction = engine.getTraceMessages(db, `${NATIVE_TRACE}:${sid(902)}`) || {};
    eq((secondInteraction.turns || []).length, 1,
      'log-sourced turns are cut to the segment that was clicked');
    eq((secondInteraction.turns || [])[0]?.inputPreview, 'and the tests?',
      'the segment keeps the turn that happened inside it');
    // Same bubble-to-span invariant as the span-attribute path, on the log path: a
    // log record is stamped with the interaction span, which is the segment root.
    const logSegmentDrawn = new Set(
      engine.getSpansByTraceId(db, `${NATIVE_TRACE}:${sid(902)}`).map(s => s.spanId));
    check((secondInteraction.turns || []).every(t => logSegmentDrawn.has(t.spanId)),
      'a log-sourced segment turn names a span the segment waterfall draws');

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

module.exports = { claudeLogTranscriptChecks };
