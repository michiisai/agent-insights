import { parentPort, workerData } from 'worker_threads';
import { DatabaseWorkerRuntime } from './workerRuntime';
import type {
  DatabaseRequest,
  DatabaseResponse,
  SerializedDatabaseError,
} from './protocol';

interface WorkerData {
  dbPath: string;
}

const port = parentPort;
if (!port) {
  throw new Error('Database worker must run in a worker thread');
}

const runtime = new DatabaseWorkerRuntime((workerData as WorkerData).dbPath);
let queue = Promise.resolve();

function serializeError(error: unknown): SerializedDatabaseError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}

port.on('message', (request: DatabaseRequest) => {
  queue = queue.then(async () => {
    let response: DatabaseResponse;
    try {
      const queueDurationMs = request.queuedAtMs === undefined
        ? 0
        : Math.max(0, Date.now() - request.queuedAtMs);
      const value = await runtime.execute(request.operation, request.args, queueDurationMs);
      response = { id: request.id, ok: true, value };
    } catch (error) {
      response = { id: request.id, ok: false, error: serializeError(error) };
    }
    try {
      port.postMessage(response);
    } catch (error) {
      port.postMessage({
        id: request.id,
        ok: false,
        error: serializeError(error),
      } satisfies DatabaseResponse);
    }
  });
});
