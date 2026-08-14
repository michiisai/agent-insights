'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const {
  COLLECTOR_PROTOCOL_VERSION,
  OtlpReceiver,
  TelemetryStore,
  probeCollector,
} = require('@agent-insights/receiver');

const HOST = '127.0.0.1';

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  if (!server.listening) { return Promise.resolve(); }
  return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
}

function post(port, urlPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: HOST, port, path: urlPath, method: 'POST' },
      response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', reject);
    request.end('{}');
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-coordination-'));
  const dbPath = path.join(tempDir, 'telemetry.db');
  const stores = [
    new TelemetryStore(dbPath),
    new TelemetryStore(dbPath),
    new TelemetryStore(dbPath),
  ];
  let owner;
  const candidates = [];
  let unknownServer;

  try {
    await Promise.all(stores.map(store => store.initialize()));

    const reservation = http.createServer();
    const port = await listen(reservation);
    await close(reservation);

    owner = new OtlpReceiver(stores[0], port);
    await owner.start();
    stores[0].enablePersistence();

    const identity = await probeCollector(port);
    assert(identity, 'Agent Insights receiver should identify itself');
    assert.strictEqual(identity.protocolVersion, COLLECTOR_PROTOCOL_VERSION);
    assert.strictEqual(identity.instanceId, owner.instanceId);
    assert.strictEqual(identity.state, 'accepting');

    const collision = new OtlpReceiver(stores[1], port);
    await assert.rejects(collision.start(), error => error.code === 'EADDRINUSE');
    await collision.stop();

    let slowRequest;
    let slowResponseStatus;
    const slowResponse = new Promise((resolve, reject) => {
      slowRequest = http.request(
        {
          host: HOST,
          port,
          path: '/v1/traces',
          method: 'POST',
          headers: { 'content-length': 2 },
        },
        response => {
          slowResponseStatus = response.statusCode;
          response.resume();
          response.on('end', resolve);
        },
      );
      slowRequest.on('error', reject);
      slowRequest.flushHeaders();
      slowRequest.write('{');
    });
    await delay(20);

    owner.beginDrain();
    assert.strictEqual((await probeCollector(port)).state, 'draining');
    assert.strictEqual(await post(port, '/v1/traces'), 503);
    let drained = false;
    const draining = owner.waitForIdle().then(() => { drained = true; });
    await delay(20);
    assert.strictEqual(drained, false, 'drain should wait for an active OTLP request');
    slowRequest.end('}');
    await slowResponse;
    assert.strictEqual(slowResponseStatus, 200);
    await draining;
    await stores[0].relinquishPersistence();
    stores[0].close();
    await owner.stop();
    owner = undefined;

    await Promise.all([stores[1].reloadFromDisk(), stores[2].reloadFromDisk()]);
    candidates.push(new OtlpReceiver(stores[1], port), new OtlpReceiver(stores[2], port));
    const election = await Promise.allSettled(candidates.map(candidate => candidate.start()));
    assert.strictEqual(
      election.filter(result => result.status === 'fulfilled').length,
      1,
      'exactly one follower should acquire the released port',
    );
    assert.strictEqual(
      election.filter(result => result.status === 'rejected' && result.reason.code === 'EADDRINUSE').length,
      1,
      'other followers should lose via the atomic port bind',
    );
    await Promise.all(candidates.map(candidate => candidate.stop()));

    unknownServer = http.createServer((_request, response) => response.writeHead(404).end());
    const unknownPort = await listen(unknownServer);
    assert.strictEqual(await probeCollector(unknownPort), undefined);
  } finally {
    if (owner) { await owner.stop().catch(() => undefined); }
    await Promise.all(candidates.map(candidate => candidate.stop().catch(() => undefined)));
    if (unknownServer) { await close(unknownServer).catch(() => undefined); }
    for (const store of stores) {
      try { store.close(); } catch { /* already closed */ }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('Collector coordination checks passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
