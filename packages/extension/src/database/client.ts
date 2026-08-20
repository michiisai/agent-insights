import * as path from 'path';
import { Worker } from 'worker_threads';
import type { LogRow, MetricRow, SpanRow } from '@agent-insights/receiver';
import type {
  DatabaseArgs,
  DatabaseOperation,
  DatabaseRequest,
  DatabaseResponse,
  DatabaseResult,
  SerializedDatabaseError,
} from './protocol';
import type { TelemetryDatabase } from './service';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class DatabaseClient implements TelemetryDatabase {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 0;
  private closed = false;
  private writable = false;

  private constructor(dbPath: string) {
    this.worker = new Worker(path.join(__dirname, 'database-worker.js'), {
      workerData: { dbPath },
    });
    this.worker.on('message', (response: DatabaseResponse) => this.handleResponse(response));
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => {
      if (!this.closed) {
        this.fail(new Error(`Database worker exited unexpectedly with code ${code}`));
      }
    });
  }

  static async create(dbPath: string): Promise<DatabaseClient> {
    const client = new DatabaseClient(dbPath);
    try {
      await client.request('initialize', undefined);
      return client;
    } catch (error) {
      await client.worker.terminate();
      throw error;
    }
  }

  get isWritable(): boolean {
    return this.writable;
  }

  request<K extends DatabaseOperation>(
    operation: K,
    args: DatabaseArgs<K>,
  ): Promise<DatabaseResult<K>> {
    if (this.closed) {
      return Promise.reject(new Error('Database worker is closed'));
    }

    const id = ++this.nextRequestId;
    const request: DatabaseRequest = {
      id,
      operation,
      args,
      queuedAtMs: Date.now(),
    } as DatabaseRequest;
    return new Promise<DatabaseResult<K>>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as DatabaseResult<K>),
        reject,
      });
      try {
        this.worker.postMessage(request);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  insertSpans(rows: SpanRow[]): Promise<void> {
    return this.request('insertSpans', rows);
  }

  insertMetrics(rows: MetricRow[]): Promise<void> {
    return this.request('insertMetrics', rows);
  }

  insertLogs(rows: LogRow[]): Promise<void> {
    return this.request('insertLogs', rows);
  }

  async reloadFromDisk(): Promise<void> {
    await this.request('reloadFromDisk', undefined);
  }

  async enablePersistence(): Promise<void> {
    await this.request('enablePersistence', undefined);
    this.writable = true;
  }

  async relinquishPersistence(): Promise<void> {
    try {
      await this.request('relinquishPersistence', undefined);
    } finally {
      this.writable = false;
    }
  }

  clear(): Promise<void> {
    return this.request('clear', undefined);
  }

  async close(): Promise<void> {
    if (this.closed) { return; }
    try {
      await this.request('close', undefined);
    } finally {
      this.closed = true;
      this.writable = false;
      await this.worker.terminate();
      this.fail(new Error('Database worker closed'));
    }
  }

  private handleResponse(response: DatabaseResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) { return; }
    this.pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.value);
    } else {
      pending.reject(this.deserializeError(response.error));
    }
  }

  private deserializeError(serialized: SerializedDatabaseError): Error {
    const error = new Error(serialized.message);
    error.name = serialized.name;
    if (serialized.stack) { error.stack = serialized.stack; }
    return error;
  }

  private fail(error: Error): void {
    this.closed = true;
    this.writable = false;
    for (const pending of this.pending.values()) { pending.reject(error); }
    this.pending.clear();
  }
}
