'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { check, eq } = require('../lib/assert');
const { ns } = require('../lib/otlp');
const { providerSpan, codexSpan, codexLog, strAttr, CONV_ATTR, ANCHOR_SPAN, CODEX_TRACE } = require('../lib/fixtures');

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
      'the unused chat is classified as background rather than as a session');

    store.insertLogs([
      codexLog(704, [
        strAttr('event.name', 'codex.conversation_starts'),
        strAttr('conversation.id', 'conv-codex'),
        strAttr('provider_name', 'openai'), strAttr('model', 'gpt-5-codex'),
        strAttr('reasoning_effort', 'high'), strAttr('reasoning_summary', 'concise'),
        strAttr('approval_policy', 'on-request'), strAttr('sandbox_policy', 'workspace-write'),
        strAttr('mcp_servers', 'github, playwright'), strAttr('app.version', '1.2.3'),
        { key: 'context_window', value: { intValue: '200000' } },
      ]),
      // A session commonly opens with a record that is nothing but injected
      // context. It is not something the user said, so it must neither become a
      // turn nor be taken as the session's label.
      codexLog(705, [
        strAttr('event.name', 'codex.user_prompt'),
        strAttr('conversation.id', 'conv-codex'),
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
        strAttr('conversation.id', 'conv-codex'),
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
        strAttr('conversation.id', 'conv-codex'),
        strAttr('event.kind', 'response.output_text.delta'),
      ], ''),
      // The first round trip of the reply. Codex logs it once the call has
      // finished, so the prompt is still the open draft and this adopts it
      // rather than leaving the prompt in a turn of its own.
      codexLog(712, [
        strAttr('event.name', 'codex.api_request'),
        strAttr('conversation.id', 'conv-codex'),
        strAttr('endpoint', '/responses'), strAttr('duration_ms', '3353'),
        { key: 'http.response.status_code', value: { intValue: '200' } },
        { key: 'attempt', value: { intValue: '0' } },
      ]),
      // Codex reports what a round trip cost on a stream event that carries no
      // trace id at all — only the conversation it belongs to.
      codexLog(713, [
        strAttr('event.name', 'codex.sse_event'), strAttr('event.kind', 'response.completed'),
        strAttr('conversation.id', 'conv-codex'),
        strAttr('model_reasoning_effort', 'high'), strAttr('service_tier', 'priority'),
        { key: 'input_token_count', value: { intValue: '900' } },
        { key: 'output_token_count', value: { intValue: '120' } },
        { key: 'reasoning_token_count', value: { intValue: '60' } },
      ], ''),
      // The same completion is also logged with nothing but how long the stream
      // took to close. Reporting it twice would read as a second round trip.
      codexLog(714, [
        strAttr('event.name', 'codex.sse_event'), strAttr('event.kind', 'response.completed'),
        strAttr('conversation.id', 'conv-codex'), strAttr('duration_ms', '41'),
      ], ''),
      codexLog(715, [
        strAttr('event.name', 'codex.tool_result'),
        strAttr('conversation.id', 'conv-codex'),
        strAttr('tool_name', 'shell_command'), strAttr('call_id', 'call-1'),
        strAttr('arguments', '{"command":"npm test"}'),
        strAttr('output', 'ok'), strAttr('success', 'true'),
      ]),
      codexLog(716, [
        strAttr('event.name', 'codex.tool_result'),
        strAttr('conversation.id', 'conv-codex'),
        strAttr('tool_name', 'shell_command'), strAttr('call_id', 'call-2'),
        strAttr('arguments', '{"command":"npm run typecheck"}'),
        strAttr('success', 'false'),
      ]),
      codexLog(717, [
        strAttr('event.name', 'codex.tool_decision'),
        strAttr('conversation.id', 'conv-codex'),
        strAttr('tool_name', 'shell_command'), strAttr('call_id', 'call-2'),
        strAttr('decision', 'approved'), strAttr('source', 'user'),
      ]),
      codexLog(718, [
        strAttr('event.name', 'codex.sandbox_outcome'),
        strAttr('conversation.id', 'conv-codex'),
        strAttr('tool_name', 'shell_command'), strAttr('call_id', 'call-2'),
        strAttr('outcome', 'escalated'),
        { key: 'initial_duration_ms', value: { intValue: '12' } },
        { key: 'escalated_duration_ms', value: { intValue: '30' } },
      ]),
      // The agent loop calls the model again with the tool output. That is a
      // second call of the same reply, not a second reply.
      codexLog(719, [
        strAttr('event.name', 'codex.api_request'),
        strAttr('conversation.id', 'conv-codex'),
        strAttr('endpoint', '/responses'), strAttr('duration_ms', '2412'),
        { key: 'http.response.status_code', value: { intValue: '200' } },
      ]),
      codexLog(720, [
        strAttr('event.name', 'codex.turn_cost'), strAttr('turn.id', 'turn-1'),
        strAttr('conversation.id', 'conv-codex'),
        strAttr('usage.estimated_usd', '0.04'), strAttr('reasoning_effort', 'high'),
        strAttr('turn.interrupted', 'false'),
      ]),
      // A prompt Codex answered in prose alone: no tool_result follows, and the
      // reply text was stripped before export. It is still a turn.
      codexLog(721, [
        strAttr('event.name', 'codex.user_prompt'),
        strAttr('conversation.id', 'conv-codex'),
        strAttr('prompt', 'and the tests?'),
      ]),
    ]);

    const msgs = engine.getSessionMessages(db, 'sess-codex') || {};
    eq(msgs.captureEnabled, true, 'codex transcript is recovered from log records');
    eq((msgs.turns || []).length, 3,
      'each round trip is a turn, so a two-call reply and a second prompt make three');

    // Codex is the second of the two log fallbacks, so reaching it by trace id
    // proves the per-trace query walks the same chain as the session query.
    const codexByTrace = engine.getTraceMessages(db, CODEX_TRACE) || {};
    eq(codexByTrace.captureEnabled, true, 'codex log fallback is reached by trace id');
    eq((codexByTrace.turns || []).length, 3, 'trace transcript recovers the same codex turns');

    const [first, secondCall, second] = msgs.turns;
    eq(first.inputPreview, 'is this emitting otel metrics\n\n@c:\\src\\OTEL.md',
      'a repository block wedged mid-prompt is stripped without taking the file reference with it');
    eq(secondCall.inputPreview, first.inputPreview,
      'every call of a reply carries the prompt it is answering, so the transcript groups them');
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
    eq(JSON.parse(secondCall.outputMessages)[0].parts.length, 0,
      'the round trip that ended the reply issued no tools, and Codex exports no prose');
    check(first.details.some(section => section.title === 'Session configuration'
      && section.items.some(item => item.label === 'Approval policy' && item.value === 'on-request')),
    'codex session configuration is attached to the first turn');
    check(first.details.some(section => section.title === 'API request'
      && section.items.some(item => item.label === 'Duration (ms)' && item.value === '3353')),
    'the round trip a call is reports on itself');
    check(first.details.some(section => section.title === 'Tool decision · shell_command'),
      'codex tool approval decisions are exposed');
    check(first.details.some(section => section.title === 'Sandbox outcome · shell_command'
      && section.items.some(item => item.label === 'Outcome' && item.value === 'escalated')),
    'codex sandbox escalation is exposed');
    eq(first.details.filter(section => section.title === 'Response usage').length, 1,
      'the duration-only twin of a completion reports nothing and is dropped');
    check(first.details.some(section => section.title === 'Response usage'
      && section.items.some(item => item.label === 'Reasoning tokens' && item.value === '60')),
    'codex response usage is recovered from the trace-less SSE stream by conversation');
    check(!secondCall.details.some(section => section.title === 'Response usage'),
      'usage lands on the round trip that reported it, not on whichever call is last');
    check(secondCall.details.some(section => section.title === 'Turn cost'
      && section.items.some(item => item.label === 'Reasoning effort' && item.value === 'high')),
    'codex turn cost includes reasoning effort');

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

    // Session-start config and open drafts are trace-local when one logical
    // session spans multiple physical traces.
    const traceA = 'd1'.repeat(16);
    const traceB = 'e2'.repeat(16);
    store.insertSpans([
      providerSpan(traceA, 'codex-app-server', 730, 'thread/start', null,
        [strAttr('session.id', 'sess-codex-interleaved')], 730),
      providerSpan(traceB, 'codex-app-server', 731, 'thread/start', null,
        [strAttr('session.id', 'sess-codex-interleaved')], 731),
    ]);
    store.insertLogs([
      codexLog(730, [
        strAttr('event.name', 'codex.conversation_starts'),
        strAttr('approval_policy', 'on-request'),
      ], traceA),
      codexLog(731, [
        strAttr('event.name', 'codex.conversation_starts'),
        strAttr('approval_policy', 'never'),
      ], traceB),
      codexLog(732, [
        strAttr('event.name', 'codex.user_prompt'), strAttr('prompt', 'alpha codex'),
      ], traceA),
      codexLog(733, [
        strAttr('event.name', 'codex.user_prompt'), strAttr('prompt', 'beta codex'),
      ], traceB),
      codexLog(734, [
        strAttr('event.name', 'codex.tool_result'), strAttr('tool_name', 'shell_command'),
        strAttr('call_id', 'alpha-call'), strAttr('success', 'true'),
      ], traceA),
      codexLog(735, [
        strAttr('event.name', 'codex.tool_result'), strAttr('tool_name', 'shell_command'),
        strAttr('call_id', 'beta-call'), strAttr('success', 'true'),
      ], traceB),
    ]);
    const interleaved = (engine.getSessionMessages(db, 'sess-codex-interleaved') || {}).turns || [];
    const alphaTurn = interleaved.find(turn => turn.traceId === traceA) || {};
    const betaTurn = interleaved.find(turn => turn.traceId === traceB) || {};
    const approvalOf = turn => turn.details?.find(section => section.title === 'Session configuration')
      ?.items.find(item => item.label === 'Approval policy')?.value;
    eq(approvalOf(alphaTurn), 'on-request', 'trace A keeps its own Codex session configuration');
    eq(approvalOf(betaTurn), 'never', 'trace B keeps its own Codex session configuration');
    check(alphaTurn.outputMessages.includes('alpha-call'), 'trace A keeps its own open tool draft');
    check(!betaTurn.outputMessages.includes('alpha-call'), 'trace B does not inherit trace A tool activity');

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

module.exports = { codexSessionTranscriptChecks };
