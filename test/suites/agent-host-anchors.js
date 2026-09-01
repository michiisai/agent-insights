'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { check, eq } = require('../lib/assert');
const { sid } = require('../lib/otlp');
const {
  nativeSpan,
  providerSpan,
  claudeLog,
  CONV_ATTR,
  TITLE_SPAN,
  URI_ATTR,
  ANCHOR_SPAN,
  NATIVE_TRACE,
} = require('../lib/fixtures');

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
    const failedTool = nativeSpan('claude-code', 802, 'execute_tool bash', 801,
      [{ key: 'gen_ai.tool.name', value: { stringValue: 'bash' } }], 802);
    const failedToolRaw = JSON.parse(failedTool.raw);
    failedToolRaw.span.status = { code: 2, message: 'command failed' };
    failedTool.raw = JSON.stringify(failedToolRaw);
    store.insertSpans([
      nativeSpan('vscode-agent-host', 800, ANCHOR_SPAN, null,
        [{ key: CONV_ATTR, value: { stringValue: 'sess-native' } }], 800),
      nativeSpan('claude-code', 801, 'chat claude-opus-5', 800, [
        { key: 'session.id', value: { stringValue: 'sess-native' } },
        { key: 'gen_ai.request.model', value: { stringValue: 'claude-opus-5' } },
        { key: 'gen_ai.usage.input_tokens', value: { intValue: '120' } },
        { key: 'gen_ai.usage.output_tokens', value: { intValue: '30' } },
      ], 801),
      failedTool,
      nativeSpan('vscode-agent-host', 803, TITLE_SPAN, 800, [
        { key: CONV_ATTR, value: { stringValue: 'sess-native' } },
        { key: 'vscode.agent_host.session.title', value: { stringValue: 'Native session' } },
      ], 803),
    ]);
    store.insertLogs([
      claudeLog(804, 802, [
        { key: 'event.name', value: { stringValue: 'tool_result' } },
      ]),
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
    eq(summary.failures?.[0]?.spanId, sid(802), 'session failure targets the errored span');
    eq(summary.failures?.[0]?.targetTraceId, `${NATIVE_TRACE}:${sid(801)}`,
      'session failure targets the logical host-trace segment containing the span');

    const projected = engine.getTraces(db).filter(t => t.physicalTraceId === NATIVE_TRACE);
    eq(projected.length, 2, 'host wrapper is replaced by each of its direct children');
    const projectedTurn = projected.find(t => t.rootSpanName === 'chat claude-opus-5') || {};
    eq(projectedTurn.category, 'agentActivity',
      'promoted host child is classified as agent activity');
    eq(projectedTurn.rootSpanName, 'chat claude-opus-5',
      'projection does not depend on a provider-specific turn name');
    eq(projectedTurn.spanCount, 2, 'promoted child owns its descendant subtree');
    eq(projectedTurn.traceId, `${NATIVE_TRACE}:${sid(801)}`,
      'logical trace identity combines the physical trace and promoted root');
    eq(engine.getSpansByTraceId(db, projectedTurn.traceId).length, 2,
      'logical trace span loading excludes the host wrapper');
    const projectedLog = engine.getLogs(db, { sessionId: 'sess-native' })[0] || {};
    eq(projectedLog.traceId, NATIVE_TRACE,
      'session log preserves its physical OTLP trace id for display');
    eq(projectedLog.targetTraceId, projectedTurn.traceId,
      'session log navigation targets the logical segment containing its span');
    const projectedError = engine.getRecentErrorTraces(db)
      .find(t => t.traceId === projectedTurn.traceId) || {};
    eq(projectedError.physicalTraceId, NATIVE_TRACE,
      'recent errors preserve the physical host trace id as metadata');
    eq(projectedError.errorSpans?.[0]?.spanId, sid(802),
      'recent-error span links stay inside their logical host-trace segment');
    const projectedTitle = projected.find(t => t.rootSpanName === TITLE_SPAN) || {};
    eq(projectedTitle.spanCount, 1, 'host title metadata is promoted as its own trace row');
    eq(projectedTitle.category, 'agentActivity',
      'all promoted host children remain available as agent activity');

    const projectedSearch = engine.getTraces(db, { nameSearch: 'execute_tool bash' })
      .find(t => t.traceId === projectedTurn.traceId) || {};
    eq(projectedSearch.spanCount, 2, 'search returns the complete matching logical subtree');
    const projectedMatches = engine.getTraceMatches(db, {
      search: 'execute_tool bash',
      traceIds: [projectedTurn.traceId],
    });
    check(projectedMatches.some(m => m.traceId === projectedTurn.traceId && m.spanName === 'execute_tool bash'),
      'search previews retain the logical trace identity');

    const CLAUDE_TRACE = '8'.repeat(32);
    const CODEX_HOST_TRACE = '7a'.repeat(16);
    store.insertSpans([
      providerSpan(CLAUDE_TRACE, 'vscode-agent-host', 810, ANCHOR_SPAN, null,
        [{ key: CONV_ATTR, value: { stringValue: 'sess-claude-shape' } }], 810),
      providerSpan(CLAUDE_TRACE, 'claude-code', 811, 'claude_code.interaction', 810,
        [{ key: 'span.type', value: { stringValue: 'interaction' } }], 811),
      providerSpan(CLAUDE_TRACE, 'claude-code', 812, 'claude_code.llm_request', 811,
        [{ key: 'gen_ai.request.model', value: { stringValue: 'claude-opus-5' } }], 812),
      providerSpan(CODEX_HOST_TRACE, 'vscode-agent-host', 820, ANCHOR_SPAN, null,
        [{ key: CONV_ATTR, value: { stringValue: 'sess-codex-shape' } }], 820),
      providerSpan(CODEX_HOST_TRACE, 'codex-app-server', 821, 'thread/start', 820, [], 821),
      providerSpan(CODEX_HOST_TRACE, 'codex-app-server', 822, 'session_init', 821, [], 822),
      providerSpan(CODEX_HOST_TRACE, 'codex-app-server', 823, 'turn/start', 820,
        [{ key: 'gen_ai.usage.input_tokens', value: { intValue: '1' } }], 823),
      providerSpan(CODEX_HOST_TRACE, 'codex-app-server', 824, 'session_task.turn', 823, [], 824),
    ]);
    const providerSegments = engine.getTraces(db);
    const claudeSegment = providerSegments.find(t => t.physicalTraceId === CLAUDE_TRACE) || {};
    eq(claudeSegment.rootSpanName, 'claude_code.interaction',
      'Claude interaction is promoted structurally');
    eq(claudeSegment.spanCount, 2, 'Claude interaction keeps its LLM descendant');
    const codexSegments = providerSegments.filter(t => t.physicalTraceId === CODEX_HOST_TRACE);
    eq(codexSegments.length, 2, 'Codex thread/start and turn/start become separate logical traces');
    check(codexSegments.some(t => t.rootSpanName === 'thread/start' && t.spanCount === 2),
      'Codex thread/start keeps initialization descendants');
    check(codexSegments.some(t => t.rootSpanName === 'turn/start' && t.spanCount === 2),
      'Codex turn/start keeps turn descendants');

    // A span processor can export completed children before their still-open
    // direct parent. Group them under that missing parent id until it arrives.
    const ACTIVE_TRACE = '6a'.repeat(16);
    store.insertSpans([
      providerSpan(ACTIVE_TRACE, 'vscode-agent-host', 830, ANCHOR_SPAN, null,
        [{ key: CONV_ATTR, value: { stringValue: 'sess-active-shape' } }], 830),
      providerSpan(ACTIVE_TRACE, 'github-copilot', 832, 'chat gpt-5', 831,
        [{ key: 'gen_ai.request.model', value: { stringValue: 'gpt-5' } }], 832),
      providerSpan(ACTIVE_TRACE, 'github-copilot', 833, 'execute_tool rg', 832, [], 833),
    ]);
    const activeSegment = engine.getTraces(db)
      .find(t => t.traceId === `${ACTIVE_TRACE}:${sid(831)}`) || {};
    eq(activeSegment.rootSpanName, 'Unresolved operation',
      'missing direct parent uses the unresolved operation fallback');
    eq(activeSegment.isPartial, true, 'missing direct parent is represented as a partial segment');
    eq(activeSegment.spanCount, 2, 'partial segment groups descendants by missing parent id');
    eq(engine.getSpansByTraceId(db, activeSegment.traceId).length, 2,
      'partial logical trace loads the available descendant subtree');
    store.insertLogs([
      claudeLog(834, 833, [
        { key: 'event.name', value: { stringValue: 'tool_result' } },
      ], 9, ACTIVE_TRACE),
    ]);
    const partialLog = engine.getLogs(db, { sessionId: 'sess-active-shape' })[0] || {};
    eq(partialLog.targetTraceId, activeSegment.traceId,
      'log navigation targets a partial segment whose root has not arrived');

    // Two turns of the SAME host trace become two logical traces, so a per-trace
    // transcript has to be cut down to the segment the user clicked — otherwise
    // every turn of the session reads as belonging to all of them.
    const SEG_TRACE = '5a'.repeat(16);
    const chatOutput = (text) => JSON.stringify([
      { role: 'assistant', parts: [{ type: 'text', content: text }], finish_reason: 'stop' },
    ]);
    store.insertSpans([
      providerSpan(SEG_TRACE, 'vscode-agent-host', 840, ANCHOR_SPAN, null,
        [{ key: CONV_ATTR, value: { stringValue: 'sess-segmented' } }], 840),
      providerSpan(SEG_TRACE, 'github-copilot', 841, 'chat gpt-5', 840, [
        { key: 'gen_ai.request.model', value: { stringValue: 'gpt-5' } },
        { key: 'gen_ai.input.messages', value: { stringValue: JSON.stringify([
          { role: 'user', parts: [{ type: 'text', content: 'first question' }] },
        ]) } },
        { key: 'gen_ai.output.messages', value: { stringValue: chatOutput('First answer.') } },
      ], 841),
      providerSpan(SEG_TRACE, 'github-copilot', 842, 'chat gpt-5', 840, [
        { key: 'gen_ai.request.model', value: { stringValue: 'gpt-5' } },
        { key: 'gen_ai.output.messages', value: { stringValue: chatOutput('Second answer.') } },
      ], 851),
    ]);

    const firstSegment = engine.getTraceMessages(db, `${SEG_TRACE}:${sid(841)}`) || {};
    eq((firstSegment.turns || []).length, 1, 'a segment transcript holds only its own turn');
    check((firstSegment.turns || [])[0]?.outputMessages.includes('First answer.'),
      'segment transcript carries that segment turn');
    eq((firstSegment.turns || [])[0]?.inputPreview, 'first question',
      'segment transcript extracts the prompt that produced the turn');
    const secondSegment = engine.getTraceMessages(db, `${SEG_TRACE}:${sid(842)}`) || {};
    eq((secondSegment.turns || []).length, 1, 'the sibling segment holds only its own turn');
    check((secondSegment.turns || [])[0]?.outputMessages.includes('Second answer.'),
      'sibling segments do not leak turns into each other');
    eq((engine.getTraceMessages(db, SEG_TRACE)?.turns || []).length, 2,
      'the physical trace still reads as the whole conversation');
    check(engine.getTraceMessages(db, `${SEG_TRACE}:${sid(849)}`) === null,
      'a segment id naming no span resolves to nothing');

    // Clicking a conversation bubble jumps to the span that produced it, by looking
    // that span up in the waterfall the row is showing. That only lands if every turn
    // a segment reports names a span that same segment renders — both sides walk
    // SEGMENT_SPANS_CTE, so it holds, but a silent no-op is the failure mode.
    const segmentDrawn = new Set(
      engine.getSpansByTraceId(db, `${SEG_TRACE}:${sid(841)}`).map(s => s.spanId));
    check((firstSegment.turns || []).every(t => segmentDrawn.has(t.spanId)),
      'every segment turn names a span the segment waterfall draws');

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

    // Claude keeps its provider thread URI when Agent Host assigns a fresh
    // conversation id to a resumed chat. The provider id is the durable identity.
    const CLAUDE_ORIGINAL_TRACE = '4a'.repeat(16);
    const CLAUDE_RESUMED_TRACE = '4b'.repeat(16);
    store.insertSpans([
      providerSpan(CLAUDE_ORIGINAL_TRACE, 'vscode-agent-host', 860, ANCHOR_SPAN, null, [
        { key: CONV_ATTR, value: { stringValue: 'claude-thread' } },
        { key: URI_ATTR, value: { stringValue: 'claude:/claude-thread' } },
      ], 860),
      providerSpan(CLAUDE_ORIGINAL_TRACE, 'claude-code', 861, 'claude_code.interaction', 860, [
        { key: 'session.id', value: { stringValue: 'claude-thread' } },
      ], 861),
      providerSpan(CLAUDE_ORIGINAL_TRACE, 'claude-code', 862, 'claude_code.llm_request', 861, [
        { key: 'session.id', value: { stringValue: 'claude-thread' } },
      ], 862),
      providerSpan(CLAUDE_RESUMED_TRACE, 'vscode-agent-host', 870, ANCHOR_SPAN, null, [
        { key: CONV_ATTR, value: { stringValue: 'fresh-host-id' } },
        { key: URI_ATTR, value: { stringValue: 'claude:/claude-thread' } },
      ], 870),
      providerSpan(CLAUDE_RESUMED_TRACE, 'claude-code', 871, 'claude_code.interaction', 870, [
        { key: 'session.id', value: { stringValue: 'fresh-host-id' } },
      ], 871),
      providerSpan(CLAUDE_RESUMED_TRACE, 'claude-code', 872, 'claude_code.llm_request', 871, [
        { key: 'session.id', value: { stringValue: 'fresh-host-id' } },
      ], 872),
    ]);
    eq(engine.getSessionIdForTrace(db, CLAUDE_RESUMED_TRACE), 'claude-thread',
      'a resumed Claude trace resolves to its stable provider thread');
    eq(engine.getSessions(db).filter(s => s.sessionId === 'claude-thread').length, 1,
      'the resumed Claude trace remains in the original session');
    check(!engine.getSessions(db).some(s => s.sessionId === 'fresh-host-id'),
      'the transient Agent Host id does not mint a duplicate Claude session');

    const COPILOT_MISMATCH_TRACE = '4c'.repeat(16);
    store.insertSpans([
      providerSpan(COPILOT_MISMATCH_TRACE, 'vscode-agent-host', 880, ANCHOR_SPAN, null, [
        { key: CONV_ATTR, value: { stringValue: 'copilot-host-id' } },
        { key: URI_ATTR, value: { stringValue: 'copilotcli:/different-uri-id' } },
      ], 880),
      providerSpan(COPILOT_MISMATCH_TRACE, 'github-copilot', 881, 'chat gpt-5', 880, [
        { key: 'gen_ai.request.model', value: { stringValue: 'gpt-5' } },
      ], 881),
    ]);
    eq(engine.getSessionIdForTrace(db, COPILOT_MISMATCH_TRACE), 'copilot-host-id',
      'provider URI aliasing does not change Copilot session identity');
  } finally {
    try { store.close(); } catch { /* already closed */ }
    cleanup();
  }
}

module.exports = { agentHostAnchorChecks };
