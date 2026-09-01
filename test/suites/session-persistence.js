'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { TelemetryStore } = require('@agent-insights/receiver');
const engine = require('@agent-insights/engine');
const { check, eq } = require('../lib/assert');
const { sid } = require('../lib/otlp');
const {
  ANCHOR_SPAN, CONV_ATTR,
  providerSpan, strAttr, titleSpan, claudeLog, codexLog,
} = require('../lib/fixtures');

const num = (key, value) => ({ key, value: { intValue: String(value) } });
const tmpDb = (name) =>
  path.join(os.tmpdir(), `session-mvp-${name}-${process.pid}-${Date.now()}.db`);

function removeDb(dbPath) {
  for (const file of [dbPath, `${dbPath}.tmp`, `${dbPath}.sync.tmp`]) {
    try { fs.unlinkSync(file); } catch { /* already absent */ }
  }
}

function failedSpan(span, message) {
  const parsed = JSON.parse(span.raw);
  parsed.span.status = { code: 2, message };
  return { raw: JSON.stringify(parsed) };
}

function withoutService(span) {
  const parsed = JSON.parse(span.raw);
  parsed.resource.attributes = [];
  return { raw: JSON.stringify(parsed) };
}

function stamped(span, offsetMs) {
  const parsed = JSON.parse(span.raw);
  const base = BigInt(Date.now() + offsetMs) * 1_000_000n;
  parsed.span.startTimeUnixNano = base.toString();
  parsed.span.endTimeUnixNano = (base + 10_000_000n).toString();
  return { raw: JSON.stringify(parsed) };
}

function stampedLog(log, offsetMs) {
  const parsed = JSON.parse(log.raw);
  const timestamp = (BigInt(Date.now() + offsetMs) * 1_000_000n).toString();
  parsed.logRecord.timeUnixNano = timestamp;
  parsed.logRecord.observedTimeUnixNano = timestamp;
  return { raw: JSON.stringify(parsed) };
}

function durableShape(summary) {
  return summary && {
    sessionId: summary.sessionId,
    title: summary.title,
    agent: summary.agent,
    serviceName: summary.serviceName,
    models: [...summary.models].sort(),
    startTimeUnixNano: summary.startTimeUnixNano,
    endTimeUnixNano: summary.endTimeUnixNano,
    traceCount: summary.traceCount,
    spanCount: summary.spanCount,
    llmRequestCount: summary.llmRequestCount,
    toolCallCount: summary.toolCallCount,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    totalTokens: summary.totalTokens,
    errorCount: summary.errorCount,
    turns: summary.turns.map(turn => ({
      traceId: turn.traceId,
      rootName: turn.rootName,
      spanCount: turn.spanCount,
      llmRequestCount: turn.llmRequestCount,
      toolCallCount: turn.toolCallCount,
      totalTokens: turn.totalTokens,
      errorCount: turn.errorCount,
    })),
  };
}

function sessionSpans() {
  const traceA = 'a1'.repeat(16);
  const traceB = 'b2'.repeat(16);
  return {
    traceA,
    traceB,
    rows: [
      providerSpan(traceA, 'vscode-agent-host', 100, ANCHOR_SPAN, null,
        [strAttr(CONV_ATTR, 'sess-mvp')], 100),
      providerSpan(traceA, 'github-copilot', 101, 'chat gpt-5', 100, [
        strAttr('gen_ai.operation.name', 'chat'),
        strAttr('gen_ai.request.model', 'gpt-5'),
        num('gen_ai.usage.input_tokens', 100),
        num('gen_ai.usage.output_tokens', 10),
      ], 101),
      providerSpan(traceA, 'github-copilot', 102, 'execute_tool bash', 101,
        [strAttr('gen_ai.tool.name', 'bash')], 102),
      failedSpan(providerSpan(traceA, 'github-copilot', 103, 'apply patch', 101, [], 103),
        'patch failed'),
      providerSpan(traceB, 'vscode-agent-host', 200, ANCHOR_SPAN, null,
        [strAttr(CONV_ATTR, 'sess-mvp')], 200),
      providerSpan(traceB, 'github-copilot', 201, 'chat gpt-5', 200, [
        strAttr('gen_ai.operation.name', 'chat'),
        strAttr('gen_ai.request.model', 'gpt-5'),
        num('gen_ai.usage.input_tokens', 50),
        num('gen_ai.usage.output_tokens', 5),
      ], 201),
      titleSpan(900, 'sess-mvp', 'Persistent MVP', 'copilotcli:/sess-mvp'),
    ],
  };
}

async function sessionPersistenceChecks() {
  await durableHeadlineAndExpiringDetails();
  await incrementalRestartAndLateIdentity();
  await freshUpgradeBoundary();
  await durableEchoClassification();
  await availabilityAndLogOrdering();
  await logOnlyRetention();
  await retentionAndClear();
}

/** Headline facts survive while raw-only diagnostics intentionally expire. */
async function durableHeadlineAndExpiringDetails() {
  const dbPath = tmpDb('headline');
  const store = new TelemetryStore(dbPath);
  await store.initialize();
  try {
    const db = store.getDb();
    const { traceA, traceB, rows } = sessionSpans();
    store.insertSpans(rows);

    const before = engine.getSessionSummary(db, 'sess-mvp');
    check(before != null, 'a live session has a summary');
    eq(before.title, 'Persistent MVP', 'the durable reported title is used');
    eq(before.agent, 'copilotcli', 'the durable title also preserves agent kind');
    eq(before.traceCount, 2, 'the summary groups both traces');
    eq(before.spanCount, 4, 'host and title metadata are not activity spans');
    eq(before.llmRequestCount, 2, 'LLM calls are counted once');
    eq(before.toolCallCount, 1, 'tool calls are counted once');
    eq(before.inputTokens, 150, 'input tokens are durable');
    eq(before.outputTokens, 15, 'output tokens are durable');
    eq(before.totalTokens, 165, 'total tokens are durable');
    eq(before.errorCount, 1, 'error count is durable');
    eq(before.models.join(','), 'gpt-5', 'distinct model names are durable');
    eq(before.toolStats[0]?.toolName, 'bash', 'tool-name detail is available while raw spans exist');
    eq(before.modelTokens[0]?.totalTokens, 165,
      'per-model token detail is available while raw spans exist');
    eq(before.failures[0]?.message, 'patch failed',
      'failure text is available while raw spans exist');

    const expected = durableShape(before);
    db.prepare('DELETE FROM raw_spans WHERE span_id = ?').run(sid(102));
    const partial = engine.getSessionSummary(db, 'sess-mvp');
    eq(partial.detailsState, 'partial', 'removing some raw spans marks details partial');
    eq(JSON.stringify(durableShape(partial)), JSON.stringify(expected),
      'partial raw retention does not change durable facts');

    db.prepare('DELETE FROM raw_spans WHERE trace_id IN (?, ?)').run(traceA, traceB);
    const expired = engine.getSessionSummary(db, 'sess-mvp');
    eq(expired.detailsState, 'expired', 'removing all provider spans marks details expired');
    eq(JSON.stringify(durableShape(expired)), JSON.stringify(expected),
      'expired raw telemetry does not change durable facts');
    eq(expired.toolStats.length, 0, 'tool-name detail expires with raw spans');
    eq(expired.modelTokens.length, 0, 'per-model token detail expires with raw spans');
    eq(expired.failures.length, 0, 'failure text expires with raw spans');
    eq(expired.errors.length, 0, 'exception detail expires with raw spans');

    eq(engine.getSessions(db, { nameSearch: 'Persistent MVP' })[0]?.sessionId, 'sess-mvp',
      'an expired session remains searchable by durable title');
    eq(engine.getSessions(db, { nameSearch: 'gpt-5' })[0]?.sessionId, 'sess-mvp',
      'an expired session remains searchable by durable model');
    eq(engine.getSessions(db, { nameSearch: 'github-copilot' })[0]?.sessionId, 'sess-mvp',
      'an expired session remains searchable by durable service');
    eq(engine.getSessions(db, { nameSearch: 'bash' }).length, 0,
      'raw-only tool-name search expires with raw spans');
  } finally {
    store.close();
    removeDb(dbPath);
  }
}

/** Checkpoints dedupe retries, survive restart, and allow identity to arrive late. */
async function incrementalRestartAndLateIdentity() {
  const dbPath = tmpDb('incremental');
  const trace = 'c3'.repeat(16);
  const chat = providerSpan(trace, 'copilot-chat', 300, 'chat gpt-5', null, [
    strAttr('gen_ai.operation.name', 'chat'),
    strAttr('gen_ai.request.model', 'gpt-5'),
    num('gen_ai.usage.input_tokens', 20),
    num('gen_ai.usage.output_tokens', 2),
  ], 300);

  const store = new TelemetryStore(dbPath);
  await store.initialize();
  store.enablePersistence();
  try {
    store.insertSpans([chat]);
    eq(engine.getSessionSummary(store.getDb(), trace), null,
      'an unkeyed copilot-chat utility trace is not a session');
    store.insertSpans([chat]);
    store.insertSpans([
      providerSpan(trace, 'vscode-agent-host', 301, ANCHOR_SPAN, null,
        [strAttr(CONV_ATTR, 'sess-late')], 299),
    ]);
    const attributed = engine.getSessionSummary(store.getDb(), 'sess-late');
    eq(attributed.totalTokens, 22, 'late identity claims already summarized tokens');
    eq(attributed.spanCount, 1, 'a retried span is not counted twice');
    eq(attributed.llmRequestCount, 1, 'a retried model call is not counted twice');
    store.flush();
  } finally {
    store.close();
  }

  const reopened = new TelemetryStore(dbPath);
  await reopened.initialize();
  reopened.enablePersistence();
  try {
    const db = reopened.getDb();
    eq(engine.getSessionSummary(db, 'sess-late').totalTokens, 22,
      'a restart resumes after the persisted checkpoint');
    reopened.insertSpans([
      providerSpan(trace, 'copilot-chat', 302, 'chat gpt-5', 301, [
        strAttr('gen_ai.request.model', 'gpt-5'),
        num('gen_ai.usage.input_tokens', 8),
        num('gen_ai.usage.output_tokens', 1),
      ], 302),
    ]);
    const grown = engine.getSessionSummary(db, 'sess-late');
    eq(grown.totalTokens, 31, 'new telemetry continues the persisted summary');
    eq(grown.spanCount, 2, 'new activity increments the durable span count');
  } finally {
    reopened.close();
    removeDb(dbPath);
  }
}

/** Pre-persistence rows remain raw-only; durable history starts after update. */
async function freshUpgradeBoundary() {
  const dbPath = tmpDb('fresh-upgrade');
  const oldTrace = 'd4'.repeat(16);
  const oldAnchor = stamped(providerSpan(
    oldTrace, 'vscode-agent-host', 400, ANCHOR_SPAN, null,
    [strAttr(CONV_ATTR, 'sess-before-update')], 400,
  ), 0);
  const oldChat = stamped(providerSpan(oldTrace, 'github-copilot', 401, 'chat gpt-5', 400, [
    strAttr('gen_ai.operation.name', 'chat'),
    strAttr('gen_ai.request.model', 'gpt-5'),
    num('gen_ai.usage.input_tokens', 400),
    num('gen_ai.usage.output_tokens', 40),
  ], 401), 1);

  const initial = new TelemetryStore(dbPath);
  await initial.initialize();
  initial.enablePersistence();
  initial.insertSpans([oldAnchor, oldChat]);
  initial.flush();
  initial.close();

  // Simulate a database produced before persistent sessions existed.
  const preUpdate = new TelemetryStore(dbPath);
  await preUpdate.initialize();
  preUpdate.enablePersistence();
  const preUpdateDb = preUpdate.getDb();
  preUpdateDb.prepare('DELETE FROM session_trace_models').run();
  preUpdateDb.prepare('DELETE FROM session_trace_facts').run();
  preUpdateDb.prepare('DELETE FROM session_facts_meta').run();
  check(preUpdateDb.prepare('SELECT COUNT(*) AS n FROM token_facts').get().n > 0,
    'pre-update token facts still exist');
  preUpdate.insertSpans([oldAnchor]);
  preUpdate.flush();
  preUpdate.close();

  const updated = new TelemetryStore(dbPath);
  await updated.initialize();
  updated.enablePersistence();
  try {
    const db = updated.getDb();
    eq(engine.getSessionSummary(db, 'sess-before-update'), null,
      'pre-update sessions are not backfilled from raw spans');
    check(db.prepare('SELECT COUNT(*) AS n FROM token_facts').get().n > 0,
      'starting fresh does not alter the existing short-term token trend');

    const newTrace = 'd5'.repeat(16);
    updated.insertSpans([
      providerSpan(newTrace, 'vscode-agent-host', 402, ANCHOR_SPAN, null,
        [strAttr(CONV_ATTR, 'sess-after-update')], 402),
      providerSpan(newTrace, 'github-copilot', 403, 'chat gpt-5', 402, [
        strAttr('gen_ai.request.model', 'gpt-5'),
        num('gen_ai.usage.input_tokens', 30),
        num('gen_ai.usage.output_tokens', 3),
      ], 403),
    ]);
    eq(engine.getSessionSummary(db, 'sess-after-update')?.totalTokens, 33,
      'telemetry received after the update starts durable history');
    eq(engine.getSessionSummary(db, 'sess-before-update'), null,
      'new ingestion does not pull pre-update rows across the checkpoint');
  } finally {
    updated.close();
    removeDb(dbPath);
  }
}

/** Minimal durable log flags keep duplicate tool-echo traces excluded. */
async function durableEchoClassification() {
  const dbPath = tmpDb('echo');
  const mainTrace = 'e5'.repeat(16);
  const echoTrace = 'f6'.repeat(16);
  const store = new TelemetryStore(dbPath);
  await store.initialize();
  try {
    const db = store.getDb();
    store.insertSpans([
      providerSpan(mainTrace, 'claude-code', 500, 'claude_code.llm_request', null, [
        strAttr(CONV_ATTR, 'sess-echo'),
        strAttr('gen_ai.request.model', 'claude-sonnet'),
      ], 500),
      providerSpan(echoTrace, 'claude-code', 501, 'claude_code.tool', null, [
        strAttr(CONV_ATTR, 'sess-echo'),
        strAttr('tool_name', 'Read'),
      ], 501),
    ]);
    store.insertLogs([
      claudeLog(501, 501, [
        strAttr('event.name', 'tool_result'),
        strAttr('tool_name', 'Read'),
      ], 9, echoTrace),
    ]);

    let summary = engine.getSessionSummary(db, 'sess-echo');
    eq(summary.traceCount, 1, 'a tool-result echo trace is not counted as a turn');
    eq(summary.toolCallCount, 0, 'an echo does not inflate durable tool totals');
    eq(engine.getSessionIdForTrace(db, echoTrace), 'sess-echo',
      'the excluded echo trace still resolves to its owning session');

    db.prepare('DELETE FROM raw_logs WHERE trace_id = ?').run(echoTrace);
    db.prepare('DELETE FROM raw_spans WHERE trace_id = ?').run(echoTrace);
    summary = engine.getSessionSummary(db, 'sess-echo');
    eq(summary.traceCount, 1, 'echo classification survives raw log expiration');
  } finally {
    store.close();
    removeDb(dbPath);
  }
}

/** Log-only rows are not turns, and a missing service name is not expired data. */
async function availabilityAndLogOrdering() {
  const dbPath = tmpDb('edge-ordering');
  const noServiceTrace = '07'.repeat(16);
  const mainTrace = '08'.repeat(16);
  const logOnlyTrace = '09'.repeat(16);
  const store = new TelemetryStore(dbPath);
  await store.initialize();
  try {
    const db = store.getDb();
    store.insertSpans([
      withoutService(providerSpan(noServiceTrace, 'ignored', 750, 'chat gpt-5', null, [
        strAttr(CONV_ATTR, 'sess-no-service'),
        strAttr('gen_ai.request.model', 'gpt-5'),
        num('gen_ai.usage.input_tokens', 3),
      ], 750)),
    ]);
    const noService = engine.getSessionSummary(db, 'sess-no-service');
    eq(noService.detailsState, 'complete',
      'retained spans without service.name still count as available details');
    eq(noService.turns[0]?.rootName, 'chat gpt-5',
      'a missing service name does not hide the trace root');

    const unkeyedTrace = '0a'.repeat(16);
    store.insertSpans([
      withoutService(providerSpan(unkeyedTrace, 'ignored', 751, 'chat gpt-5', null, [
        strAttr('gen_ai.request.model', 'gpt-5'),
        num('gen_ai.usage.input_tokens', 4),
      ], 751)),
    ]);
    eq(engine.getSessionSummary(db, unkeyedTrace)?.totalTokens, 4,
      'an unkeyed trace without service.name remains visible under its trace id');

    store.insertLogs([
      codexLog(800, [
        strAttr('event.name', 'codex.user_prompt'),
        strAttr('conversation.id', 'conv-log-order'),
      ], mainTrace),
      codexLog(801, [
        strAttr('event.name', 'codex.user_prompt'),
        strAttr('conversation.id', 'conv-log-order'),
      ], logOnlyTrace),
    ]);
    store.insertSpans([
      providerSpan(mainTrace, 'vscode-agent-host', 800, ANCHOR_SPAN, null,
        [strAttr(CONV_ATTR, 'sess-log-order')], 800),
      providerSpan(mainTrace, 'codex-app-server', 801, 'run_sampling_request', 800,
        [strAttr('model', 'gpt-5.6-sol')], 801),
    ]);

    const ordered = engine.getSessionSummary(db, 'sess-log-order');
    eq(ordered.traceCount, 1, 'a log-only sibling is not exposed as a zero-span turn');
    check(ordered.durationMs < 1000, 'a log-only sibling cannot drag duration to the epoch');
    eq(engine.getSessionIdForTrace(db, logOnlyTrace), 'sess-log-order',
      'the pending log-only trace still remembers its late session identity');
  } finally {
    store.close();
    removeDb(dbPath);
  }
}

/** Log-only ingestion retains delayed logs, then prunes facts by their arrival age. */
async function logOnlyRetention() {
  const dbPath = tmpDb('log-retention');
  const oldTrace = '19'.repeat(16);
  const recentTrace = '29'.repeat(16);
  const rescuedTrace = '39'.repeat(16);
  const day = 24 * 60 * 60 * 1000;
  const store = new TelemetryStore(dbPath);
  await store.initialize();
  try {
    store.insertLogs([
      stampedLog(claudeLog(900, 900, [
        strAttr('event.name', 'user_prompt'),
      ], 9, oldTrace), -2 * day),
      stampedLog(claudeLog(901, 901, [
        strAttr('event.name', 'user_prompt'),
      ], 9, recentTrace), 0),
      stampedLog(claudeLog(902, 902, [
        strAttr('event.name', 'user_prompt'),
      ], 9, rescuedTrace), -2 * day),
    ]);

    const db = store.getDb();
    eq(db.prepare('SELECT COUNT(*) AS n FROM session_trace_facts WHERE trace_id = ?')
      .get(oldTrace).n, 1, 'a delayed log gets time for its matching spans to arrive');
    store.insertSpans([
      providerSpan(rescuedTrace, 'github-copilot', 902, 'chat gpt-5', null, [
        strAttr('gen_ai.request.model', 'gpt-5'),
      ], 902),
    ]);
    const rescued = db.prepare(
      `SELECT span_count, has_content_log, has_user_prompt
         FROM session_trace_facts
        WHERE trace_id = ?`,
    ).get(rescuedTrace);
    eq(rescued.span_count, 1, 'a matching span promotes the delayed log fact');
    eq(rescued.has_content_log, 1, 'promotion preserves delayed content classification');
    eq(rescued.has_user_prompt, 1, 'promotion preserves the delayed user-prompt flag');

    db.prepare('UPDATE session_trace_facts SET updated_at = updated_at - ? WHERE trace_id = ?')
      .run(2 * 24 * 60 * 60, oldTrace);
    store.lastSessionFactPruneDay = '';
    store.insertLogs([
      stampedLog(claudeLog(903, 903, [
        strAttr('event.name', 'user_prompt'),
      ], 9, recentTrace), 0),
    ]);

    eq(db.prepare('SELECT COUNT(*) AS n FROM session_trace_facts WHERE trace_id = ?')
      .get(oldTrace).n, 0, 'log ingestion prunes facts after the transient arrival window');
    eq(db.prepare('SELECT COUNT(*) AS n FROM session_trace_facts WHERE trace_id = ?')
      .get(recentTrace).n, 1, 'log ingestion retains recent transient facts');
  } finally {
    store.close();
    removeDb(dbPath);
  }
}

/** Summary retention is independent, and explicit clear removes every layer. */
async function retentionAndClear() {
  const dbPath = tmpDb('lifecycle');
  const oldTrace = '17'.repeat(16);
  const recentTrace = '28'.repeat(16);
  const day = 24 * 60 * 60 * 1000;
  const oldRows = [
    stamped(providerSpan(oldTrace, 'vscode-agent-host', 600, ANCHOR_SPAN, null,
      [strAttr(CONV_ATTR, 'sess-old')], 600), -181 * day),
    stamped(providerSpan(oldTrace, 'github-copilot', 601, 'chat gpt-5', 600, [
      strAttr('gen_ai.request.model', 'gpt-5'),
      num('gen_ai.usage.input_tokens', 10),
    ], 601), -181 * day),
  ];
  const recentRows = [
    stamped(providerSpan(recentTrace, 'vscode-agent-host', 700, ANCHOR_SPAN, null,
      [strAttr(CONV_ATTR, 'sess-recent')], 700), 0),
    stamped(providerSpan(recentTrace, 'github-copilot', 701, 'chat gpt-5', 700, [
      strAttr('gen_ai.request.model', 'gpt-5'),
      num('gen_ai.usage.input_tokens', 5),
    ], 701), 1),
    titleSpan(901, 'sess-recent', 'Clear me'),
  ];

  const store = new TelemetryStore(dbPath);
  await store.initialize();
  store.enablePersistence();
  store.insertSpans([...oldRows, ...recentRows]);
  check(!engine.getSessions(store.getDb()).some(s => s.sessionId === 'sess-old'),
    'the first retention sweep removes a session outside the summary window');
  store.flush();
  store.close();

  const reopened = new TelemetryStore(dbPath);
  await reopened.initialize();
  reopened.enablePersistence();
  try {
    const db = reopened.getDb();
    check(!engine.getSessions(db).some(s => s.sessionId === 'sess-old'),
      'an expired summary stays removed after restart');
    check(engine.getSessions(db).some(s => s.sessionId === 'sess-recent'),
      'a recent session survives summary retention');
    eq(db.prepare('SELECT COUNT(*) AS n FROM session_trace_models WHERE trace_id = ?')
      .get(oldTrace).n, 0, 'retention removes model names with the session');

    reopened.clear();
    for (const table of [
      'raw_spans', 'raw_logs', 'raw_metrics',
      'session_titles', 'codex_trace_sessions',
      'token_facts', 'token_facts_meta',
      'session_trace_facts', 'session_trace_models', 'session_facts_meta',
    ]) {
      eq(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0,
        `clear removes ${table}`);
    }
    eq(engine.getSessions(db).length, 0, 'clear removes the session list');
    eq(engine.getSessionSummary(db, 'sess-recent'), null,
      'clear removes the session detail summary');

    reopened.insertSpans(recentRows.slice(0, 2));
    eq(engine.getSessionSummary(db, 'sess-recent')?.totalTokens, 5,
      'new telemetry is projected from zero after clear');
  } finally {
    reopened.close();
    removeDb(dbPath);
  }
}

module.exports = { sessionPersistenceChecks };
