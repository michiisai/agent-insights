'use strict';

const { ns, sid } = require('./otlp');

const PAD = 4096;

/** A span of roughly PAD bytes, attributed to `service`. */
function padSpan(i, service, opts = {}) {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scope: { name: 'retention.test' },
      span: {
        traceId: opts.traceId || String(i).padStart(32, '0'),
        spanId:  sid(i),
        ...(opts.parentSpanId ? { parentSpanId: opts.parentSpanId } : {}),
        name:    `span-${i}`,
        kind:    1,
        startTimeUnixNano: ns(i),
        endTimeUnixNano:   ns(i + 1),
        status:  { code: 0 },
        attributes: [{ key: 'pad', value: { stringValue: 'x'.repeat(PAD) } }],
      },
    }),
  };
}

const spanIds  = (db) => db.prepare('SELECT span_id AS id FROM raw_spans').all().map(r => r.id);

const CONV_ATTR  = 'gen_ai.conversation.id';
const TITLE_SPAN = 'vscode.agent_host.session.title_changed';
const URI_ATTR   = 'vscode.agent_host.session.uri';

/** A ~PAD-byte title span for `session`, so retention treats it like any other.
 *  `uri` is the agent host's session URI — its scheme is the only signal that
 *  separates Claude from Codex from Copilot CLI. Omit it for a host build that
 *  doesn't send one. */
function titleSpan(i, session, title, uri) {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'copilot' } }] },
      scope: { name: 'title.test' },
      span: {
        traceId: String(i).padStart(32, '0'),
        spanId:  sid(i),
        name:    TITLE_SPAN,
        kind:    1,
        startTimeUnixNano: ns(i),
        endTimeUnixNano:   ns(i),
        status:  { code: 0 },
        attributes: [
          { key: CONV_ATTR, value: { stringValue: session } },
          { key: 'vscode.agent_host.session.title', value: { stringValue: title } },
          ...(uri === undefined ? [] : [{ key: URI_ATTR, value: { stringValue: uri } }]),
          { key: 'pad', value: { stringValue: 'x'.repeat(PAD) } },
        ],
      },
    }),
  };
}

/** An LLM span for `session` carrying a captured user prompt. */
function promptSpan(i, session, prompt, service = 'copilot') {
  return chatSpan(i, session, [{ role: 'user', parts: [{ type: 'text', content: prompt }] }], null, service);
}

/** An LLM span with an arbitrary `gen_ai.input.messages` array, and optionally
 *  the captured reply that makes it a transcript turn. */
function chatSpan(i, session, messages, output = null, service = 'copilot', extraAttributes = []) {
  const attributes = [
    { key: CONV_ATTR, value: { stringValue: session } },
    { key: 'gen_ai.request.model', value: { stringValue: 'gpt-5' } },
    { key: 'gen_ai.input.messages', value: { stringValue: JSON.stringify(messages) } },
    ...extraAttributes,
  ];
  if (output) {
    attributes.push({ key: 'gen_ai.output.messages', value: { stringValue: JSON.stringify(output) } });
  }
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scope: { name: 'title.test' },
      span: {
        traceId: String(i).padStart(32, '0'),
        spanId:  sid(i),
        name:    'chat gpt-5',
        kind:    1,
        startTimeUnixNano: ns(i),
        endTimeUnixNano:   ns(i + 1),
        status:  { code: 0 },
        attributes,
      },
    }),
  };
}

const ANCHOR_SPAN = 'vscode.agent_host.session';
const NATIVE_TRACE = '9'.repeat(32);

/** One span in the native-session trace, from `service`. */
function nativeSpan(service, spanId, name, parentSpanId, attributes, at, duration = 10) {
  return providerSpan(NATIVE_TRACE, service, spanId, name, parentSpanId, attributes, at, duration);
}

/** One span in an agent-host trace, from `service`. */
function providerSpan(traceId, service, spanId, name, parentSpanId, attributes, at, duration = 10) {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scope: { name: 'agent-host.test' },
      span: {
        traceId,
        spanId:  sid(spanId),
        ...(parentSpanId ? { parentSpanId: sid(parentSpanId) } : {}),
        name,
        kind: 1,
        startTimeUnixNano: ns(at),
        endTimeUnixNano:   ns(at + duration),
        status: { code: 0 },
        attributes,
      },
    }),
  };
}

/** One Claude content log record, stamped with the interaction span it belongs to. */
function claudeLog(at, spanId, attributes, severityNumber = 9, traceId = NATIVE_TRACE) {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
      scope: { name: 'com.anthropic.claude_code.events' },
      logRecord: {
        timeUnixNano: ns(at),
        severityNumber,
        severityText: severityNumber >= 17 ? 'ERROR' : 'INFO',
        body: { stringValue: '' },
        traceId,
        spanId: sid(spanId),
        attributes,
      },
    }),
  };
}

const strAttr = (key, v) => ({ key, value: { stringValue: v } });

/** One log record, in whatever shape the caller wants to exercise. */
function logRow(service, logRecord) {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scope: { name: 'codex_otel.log_only' },
      logRecord,
    }),
  };
}

const CODEX_TRACE = 'c0'.repeat(16);

/** One span on the Codex session trace, from `service`. */
function codexSpan(service, spanId, name, parentSpanId, attributes, at) {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scope: { name: 'agent-host.test' },
      span: {
        traceId: CODEX_TRACE,
        spanId:  sid(spanId),
        ...(parentSpanId ? { parentSpanId: sid(parentSpanId) } : {}),
        name,
        kind: 1,
        startTimeUnixNano: ns(at),
        endTimeUnixNano:   ns(at + 10),
        status: { code: 0 },
        attributes,
      },
    }),
  };
}

/** One Codex content log — zeroed clock and null body, as Codex really sends. */
function codexLog(at, attributes, traceId = CODEX_TRACE, spanId = 701) {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'codex-app-server' } }] },
      scope: { name: 'codex_otel.log_only' },
      logRecord: {
        timeUnixNano: '0', observedTimeUnixNano: ns(at),
        severityNumber: 9, severityText: 'INFO', body: null,
        traceId,
        spanId: sid(spanId),
        attributes,
      },
    }),
  };
}

function tokenFactSpan({
  spanId,
  name,
  timestamp,
  service = 'github-copilot',
  traceId = '9'.repeat(32),
  parentSpanId,
  attributes,
}) {
  return {
    raw: JSON.stringify({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scope: { name: 'token-fact.test' },
      span: {
        traceId,
        spanId,
        ...(parentSpanId ? { parentSpanId } : {}),
        name,
        kind: 1,
        startTimeUnixNano: timestamp,
        endTimeUnixNano: timestamp,
        status: { code: 1 },
        attributes,
      },
    }),
  };
}

const COUNT_TRACE = 'ce'.repeat(16);

module.exports = {
  PAD, padSpan, spanIds,
  CONV_ATTR, TITLE_SPAN, URI_ATTR,
  titleSpan, promptSpan, chatSpan,
  ANCHOR_SPAN, NATIVE_TRACE, nativeSpan, providerSpan,
  claudeLog, strAttr, logRow,
  CODEX_TRACE, codexSpan, codexLog,
  tokenFactSpan, COUNT_TRACE,
};
