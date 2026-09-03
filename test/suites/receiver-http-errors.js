'use strict';

const http = require('http');
const { OtlpReceiver } = require('@agent-insights/receiver');
const { eq } = require('../lib/assert');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

function request(port, method, urlPath, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
      },
      response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function receiverHttpErrorChecks() {
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);

  const inserted = { spans: 0, metrics: 0, logs: 0 };
  const receiver = new OtlpReceiver({
    insertSpans: () => { inserted.spans++; },
    insertMetrics: () => { inserted.metrics++; },
    insertLogs: () => { inserted.logs++; },
  }, port);

  try {
    await receiver.start();

    eq(await request(port, 'POST', '/v1/traces', '{'), 400,
      'truncated JSON is rejected as a bad request');
    eq(inserted.spans, 0, 'malformed telemetry never reaches the span sink');

    eq(await request(port, 'GET', '/v1/traces'), 405,
      'OTLP ingestion routes reject unsupported methods');
    eq(await request(port, 'GET', '/v1/unknown'), 404,
      'unknown resources return not found regardless of method');
    eq(await request(port, 'POST', '/v1/unknown', '{}'), 404,
      'unknown OTLP paths are not acknowledged as accepted telemetry');
    eq(inserted.spans + inserted.metrics + inserted.logs, 0,
      'unsupported requests never reach a telemetry sink');

    eq(await request(port, 'OPTIONS', '/v1/traces'), 204,
      'CORS preflight remains available to browser-based exporters');
    eq(await request(port, 'POST', '/v1/traces', '{"resourceSpans":[]}'), 200,
      'a valid empty OTLP trace export is accepted');
    eq(inserted.spans, 1, 'valid trace exports reach the span sink once');
  } finally {
    await receiver.stop();
  }
}

module.exports = { receiverHttpErrorChecks };
