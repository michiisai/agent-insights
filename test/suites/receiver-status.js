'use strict';

const http = require('http');
const path = require('path');
const esbuild = require('esbuild');
const { OtlpReceiver } = require('@agent-insights/receiver');
const { eq } = require('../lib/assert');

function loadExport(source, name) {
  const entry = path.resolve(__dirname, `../../packages/extension/src/${source}`);
  const output = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    write: false,
  })?.outputFiles?.[0]?.text;
  if (!output) { throw new Error(`Failed to compile ${source}`); }

  const module = { exports: {} };
  new Function('module', 'exports', 'require', output)(module, module.exports, require);
  return module.exports[name];
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function receiverStatusChecks() {
  const ReceiverStatusController = loadExport('receiverStatus.ts', 'ReceiverStatusController');
  const delegated = [];
  const statuses = [];
  const delegate = {
    setListening: port => delegated.push(['listening', port]),
    setFollowing: port => delegated.push(['following', port]),
    setReconnecting: port => delegated.push(['reconnecting', port]),
    setUnknownCollector: port => delegated.push(['unknown', port]),
    setReceiverError: port => delegated.push(['error', port]),
  };
  const controller = new ReceiverStatusController(delegate, status => statuses.push(status));

  controller.setStarting(4318);
  controller.setListening(4318);
  controller.setFollowing(4319);
  controller.setReconnecting(4320);
  controller.setUnknownCollector(4321);
  controller.setReceiverError(4322, new Error('bind failed'));

  eq(statuses.map(status => status.state).join(','), 'starting,listening,following,reconnecting,unknown,error',
    'receiver lifecycle states are forwarded to the panel');
  eq(statuses.map(status => status.port).join(','), '4318,4318,4319,4320,4321,4322',
    'each receiver state retains its port');
  eq(delegated.map(([state]) => state).join(','), 'listening,following,reconnecting,unknown,error',
    'status-bar updates remain delegated for settled states');
  const ownerPort = await freePort();
  const owner = new OtlpReceiver({
    insertSpans() {},
    insertMetrics() {},
    insertLogs() {},
  }, ownerPort);
  const coordinatorStates = [];
  const startFailures = [];
  const CollectorCoordinator = loadExport('collectorCoordinator.ts', 'CollectorCoordinator');
  const coordinator = new CollectorCoordinator({
    reloadFromDisk: async () => { throw new Error('reload failed'); },
    enablePersistence: async () => {},
    relinquishPersistence: async () => {},
    close: async () => {},
  }, {
    setListening: port => coordinatorStates.push(['listening', port]),
    setFollowing: port => coordinatorStates.push(['following', port]),
    setReconnecting: port => coordinatorStates.push(['reconnecting', port]),
    setUnknownCollector: port => coordinatorStates.push(['unknown', port]),
    setReceiverError: port => coordinatorStates.push(['error', port]),
  }, {
    onPortChange() {},
    onOwner() {},
    onUnknownCollector() {},
    onStartFailure: (port, error) => startFailures.push([port, error]),
    onLifecycleError: error => { throw error; },
  });

  try {
    await owner.start();
    const replacementPort = await freePort();
    await coordinator.start(ownerPort);
    eq(coordinatorStates.at(-1)?.[0], 'following',
      'a secondary window reports that it is following the collector owner');

    await coordinator.restart(replacementPort);
    eq(coordinatorStates.at(-1)?.[0], 'error',
      'a takeover reload failure reports an error instead of remaining at starting');
    eq(startFailures.at(-1)?.[0], replacementPort,
      'a takeover reload failure uses the existing start-failure path');
  } finally {
    await coordinator.shutdown();
    await owner.stop();
  }
}

module.exports = { receiverStatusChecks };
