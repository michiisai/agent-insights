'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { TelemetryStore } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { check, eq } = require('../lib/assert');
const { sid } = require('../lib/otlp');
const { nativeSpan, providerSpan, CONV_ATTR, TITLE_SPAN, ANCHOR_SPAN, NATIVE_TRACE } = require('../lib/fixtures');

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

    // Codex can overflow its batch span queue on a span-heavy turn. The
    // long-lived operation parents finish last and can be dropped while their
    // completed descendants survive. With one unambiguous turn root, keep those
    // orphaned Codex subtrees in that turn instead of listing each missing
    // operation parent as a separate unresolved trace.
    const DROPPED_CODEX_TRACE = '7b'.repeat(16);
    store.insertSpans([
      providerSpan(DROPPED_CODEX_TRACE, 'vscode-agent-host', 870, ANCHOR_SPAN, null,
        [{ key: CONV_ATTR, value: { stringValue: 'sess-codex-dropped' } }], 870),
      providerSpan(DROPPED_CODEX_TRACE, 'codex-app-server', 871, 'thread/start', 870, [], 871),
      providerSpan(DROPPED_CODEX_TRACE, 'codex-app-server', 872, 'turn/start', 870,
        [{ key: 'gen_ai.usage.input_tokens', value: { intValue: '1' } }], 872),
      providerSpan(DROPPED_CODEX_TRACE, 'codex-app-server', 873,
        'app_server.serialized_request_queue', 872, [], 873),
      providerSpan(DROPPED_CODEX_TRACE, 'codex-app-server', 875,
        'needle.repaired_operation', 874, [], 875),
      providerSpan(DROPPED_CODEX_TRACE, 'codex-app-server', 876,
        'world_state.build', 874, [], 876),
      providerSpan(DROPPED_CODEX_TRACE, 'codex-app-server', 877,
        'skills.executor.catalog_snapshot', 876, [], 877),
    ]);
    const repairedCodexSegments = engine.getTraces(db)
      .filter(t => t.physicalTraceId === DROPPED_CODEX_TRACE);
    eq(repairedCodexSegments.length, 2,
      'dropped Codex operation parents do not create unresolved trace rows');
    const repairedCodexTurn = repairedCodexSegments.find(t => t.rootSpanName === 'turn/start') || {};
    eq(repairedCodexTurn.isPartial, true,
      'a repaired Codex turn remains marked partial because spans were lost');
    eq(repairedCodexTurn.spanCount, 5,
      'the Codex turn includes its connected and orphaned descendants');
    eq(engine.getSpansByTraceId(db, repairedCodexTurn.traceId).length, 5,
      'opening a repaired Codex turn loads the recovered orphan subtrees');
    const repairedSearch = engine.getTraces(db, { nameSearch: 'needle.repaired' })
      .find(t => t.traceId === repairedCodexTurn.traceId) || {};
    eq(repairedSearch.rootSpanName, 'turn/start',
      'search attributes an orphaned Codex match to the repaired turn');
    check(engine.getTraceMatches(db, {
      search: 'needle.repaired',
      traceIds: [repairedCodexTurn.traceId],
    }).some(m => m.spanName === 'needle.repaired_operation'),
    'search previews include matches from repaired Codex subtrees');

    // Do not repair a missing parent shared across providers: getTraces and the
    // logical span loader must agree that this remains an unresolved segment.
    const MIXED_ORPHAN_TRACE = '7c'.repeat(16);
    store.insertSpans([
      providerSpan(MIXED_ORPHAN_TRACE, 'vscode-agent-host', 880, ANCHOR_SPAN, null,
        [{ key: CONV_ATTR, value: { stringValue: 'sess-mixed-orphan' } }], 880),
      providerSpan(MIXED_ORPHAN_TRACE, 'codex-app-server', 881, 'turn/start', 880,
        [{ key: 'gen_ai.usage.input_tokens', value: { intValue: '1' } }], 881),
      providerSpan(MIXED_ORPHAN_TRACE, 'codex-app-server', 883,
        'codex.orphan', 882, [], 883),
      providerSpan(MIXED_ORPHAN_TRACE, 'github-copilot', 884,
        'copilot.orphan', 882, [], 884),
    ]);
    const mixedSegments = engine.getTraces(db)
      .filter(t => t.physicalTraceId === MIXED_ORPHAN_TRACE);
    const mixedTurn = mixedSegments.find(t => t.rootSpanName === 'turn/start') || {};
    check(mixedSegments.some(t => t.rootSpanName === 'Unresolved operation'),
      'a mixed-provider orphan group remains unresolved');
    eq(mixedTurn.spanCount, 1,
      'the Codex turn does not claim one child from a mixed-provider orphan group');
    eq(engine.getSpansByTraceId(db, mixedTurn.traceId).length, 1,
      'opening the Codex turn agrees with its displayed mixed-orphan span count');

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

    // Clicking a bubble jumps to its span via the segment's own waterfall, so
    // every turn a segment reports must name a span that segment also renders.
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
  } finally {
    try { store.close(); } catch { /* already closed */ }
    cleanup();
  }
}

module.exports = { agentHostAnchorChecks };
