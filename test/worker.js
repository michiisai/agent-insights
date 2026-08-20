'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const esbuild = require('esbuild');
const { OtlpReceiver } = require('@agent-insights/receiver');

const WORKER_PATH = path.resolve(__dirname, '..', 'packages', 'extension', 'dist', 'database-worker.js');
const CLIENT_ENTRY = path.resolve(
  __dirname,
  '..',
  'packages',
  'extension',
  'src',
  'database',
  'client.ts',
);
const WASM_PATH = path.resolve(__dirname, '..', 'packages', 'extension', 'dist', 'sql-wasm.wasm');

function spanRow(index) {
  const hex = index.toString(16);
  return {
    raw: JSON.stringify({
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'worker-test' } }],
      },
      scope: { name: 'worker.test' },
      span: {
        traceId: hex.padStart(32, '0'),
        spanId: hex.padStart(16, '0'),
        name: `worker-span-${index}`,
        kind: 1,
        startTimeUnixNano: `${1_000_000_000 + index}`,
        endTimeUnixNano: `${1_001_000_000 + index}`,
        status: { code: 0 },
        attributes: [],
      },
    }),
  };
}

class WorkerClient {
  constructor(dbPath) {
    this.worker = new Worker(WORKER_PATH, { workerData: { dbPath } });
    this.nextId = 0;
    this.pending = new Map();
    this.worker.on('message', response => {
      const pending = this.pending.get(response.id);
      if (!pending) { return; }
      this.pending.delete(response.id);
      if (response.ok) {
        pending.resolve(response.value);
      } else {
        const error = new Error(response.error.message);
        error.name = response.error.name;
        error.stack = response.error.stack;
        pending.reject(error);
      }

    });
    this.worker.on('error', error => {
      for (const pending of this.pending.values()) { pending.reject(error); }
      this.pending.clear();
    });
  }

  request(operation, args) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, operation, args });
    });
  }

  async stop() {
    await this.worker.terminate();
  }
}

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

function post(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-db-worker-'));
  const dbPath = path.join(tempDir, 'telemetry.db');
  let client;
  let receiver;

  try {
    client = new WorkerClient(dbPath);
    await client.request('initialize');
    await client.request('enablePersistence');

    // Requests execute in arrival order, so a query posted immediately after an
    // insert must observe that insert without host-side locking.
    const insert = client.request('insertSpans', [spanRow(1)]);
    const query = client.request('getTraces', { limit: 10 });
    const [, traces] = await Promise.all([insert, query]);
    assert.strictEqual(traces.length, 1, 'queued query observes the preceding insert');
    assert.strictEqual(traces[0].rootSpanName, 'worker-span-1');

    // A failed operation must preserve its error and must not poison the serial
    // queue for requests that follow it.
    await assert.rejects(
      client.request('insertSpans', [{ raw: 'not-json' }]),
      error => error instanceof Error && /malformed JSON/i.test(error.message),
    );
    assert.deepStrictEqual(await client.request('getServices'), ['worker-test']);

    // A substantial synchronous sql.js transaction runs in the worker while the
    // host event loop continues to make progress.
    const rows = Array.from({ length: 5_000 }, (_, index) => spanRow(index + 2));
    let hostTicks = 0;
    const timer = setInterval(() => { hostTicks++; }, 1);
    await client.request('insertSpans', rows);
    clearInterval(timer);
    assert(hostTicks > 0, 'host event loop remains responsive during worker insertion');

    await client.request('close');
    await client.stop();
    client = undefined;
    assert(fs.existsSync(dbPath), 'worker close persists the database');

    const reopened = new WorkerClient(dbPath);
    client = reopened;
    await reopened.request('initialize');
    const persisted = await reopened.request('getTraces', { limit: 10 });
    assert.strictEqual(persisted.length, 10, 'a new worker reads the persisted database');
    await reopened.request('close');
    await reopened.stop();
    client = undefined;

    // Exercise the production DatabaseClient's worker-exit path. Every pending
    // request must reject, and future requests must fail immediately.
    const clientBundle = path.join(tempDir, 'client.js');
    esbuild.buildSync({
      entryPoints: [CLIENT_ENTRY],
      outfile: clientBundle,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
    });
    fs.copyFileSync(WORKER_PATH, path.join(tempDir, 'database-worker.js'));
    fs.copyFileSync(WASM_PATH, path.join(tempDir, 'sql-wasm.wasm'));
    const { DatabaseClient } = require(clientBundle);
    const crashClient = await DatabaseClient.create(path.join(tempDir, 'crash.db'));
    const pending = crashClient.insertSpans(
      Array.from({ length: 5_000 }, (_, index) => spanRow(index + 10_000)),
    );
    const rejected = assert.rejects(pending, /Database worker exited unexpectedly/);
    await crashClient.worker.terminate();
    await rejected;
    await assert.rejects(
      crashClient.request('getServices'),
      /Database worker is closed/,
    );

    // The receiver must not acknowledge telemetry before its asynchronous sink
    // has accepted the rows.
    const reservation = http.createServer();
    const port = await listen(reservation);
    await close(reservation);
    let releaseInsert;
    let markInsertStarted;
    let failInsert = false;
    const insertStarted = new Promise(resolve => { markInsertStarted = resolve; });
    const insertReleased = new Promise(resolve => { releaseInsert = resolve; });
    const sink = {
      insertSpans: async () => {
        if (failInsert) { throw new Error('sink failed'); }
        markInsertStarted();
        await insertReleased;
      },
      insertMetrics: async () => undefined,
      insertLogs: async () => undefined,
    };
    receiver = new OtlpReceiver(sink, port);
    await receiver.start();
    let acknowledged = false;
    const response = post(port, '/v1/traces', { resourceSpans: [] }).then(status => {
      acknowledged = true;
      return status;
    });
    await insertStarted;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(acknowledged, false, 'receiver waits for the asynchronous insert');
    releaseInsert();
    assert.strictEqual(await response, 200);

    failInsert = true;
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      assert.strictEqual(
        await post(port, '/v1/traces', { resourceSpans: [] }),
        500,
        'receiver reports storage failures as server errors',
      );
    } finally {
      console.error = originalConsoleError;
    }
    await receiver.stop();
    receiver = undefined;

    console.log('Database worker checks passed.');
  } finally {
    if (receiver) { await receiver.stop().catch(() => undefined); }
    if (client) { await client.stop().catch(() => undefined); }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
