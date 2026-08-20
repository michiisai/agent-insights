import * as http from 'http';
import { randomUUID } from 'crypto';
import type { LogRow, MetricRow, SpanRow } from './store';
import { parseOtlpTraces, parseOtlpMetrics, parseOtlpLogs } from './parser';

export const COLLECTOR_IDENTITY_PATH = '/.well-known/agent-insights';
export const COLLECTOR_PROTOCOL_VERSION = 1;

export interface CollectorIdentity {
  service: 'agent-insights';
  protocolVersion: number;
  instanceId: string;
  state: 'accepting' | 'draining';
}

export interface TelemetrySink {
  insertSpans(rows: SpanRow[]): void | Promise<void>;
  insertMetrics(rows: MetricRow[]): void | Promise<void>;
  insertLogs(rows: LogRow[]): void | Promise<void>;
}

export async function probeCollector(
  port: number,
  timeoutMs = 1_000,
): Promise<CollectorIdentity | undefined> {
  return new Promise(resolve => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: COLLECTOR_IDENTITY_PATH,
      method: 'GET',
      timeout: timeoutMs,
    }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;

      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8_192) {
          request.destroy();
          resolve(undefined);
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          resolve(undefined);
          return;
        }
        try {
          const identity = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<CollectorIdentity>;
          resolve(
            identity.service === 'agent-insights'
              && typeof identity.protocolVersion === 'number'
              && typeof identity.instanceId === 'string'
              && (identity.state === 'accepting' || identity.state === 'draining')
              ? identity as CollectorIdentity
              : undefined,
          );
        } catch {
          resolve(undefined);
        }
      });
      response.on('error', () => {
        request.destroy();
        resolve(undefined);
      });
    });

    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(undefined));
    request.end();
  });
}

export class OtlpReceiver {
  private server: http.Server;
  private accepting = true;
  private activeRequests = 0;
  private readonly idleWaiters = new Set<() => void>();
  readonly instanceId = randomUUID();

  constructor(
    private readonly store: TelemetrySink,
    public readonly port: number = 4318,
  ) {
    this.server = this.buildServer();
  }

  private buildServer(): http.Server {
    return http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'GET' && req.url === COLLECTOR_IDENTITY_PATH) {
        const identity: CollectorIdentity = {
          service: 'agent-insights',
          protocolVersion: COLLECTOR_PROTOCOL_VERSION,
          instanceId: this.instanceId,
          state: this.accepting ? 'accepting' : 'draining',
        };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(identity));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      if (!this.accepting) {
        res.writeHead(503, { 'retry-after': '1' }).end();
        return;
      }

      this.activeRequests++;
      let finished = false;
      const finish = (): void => {
        if (finished) { return; }
        finished = true;
        this.activeRequests--;
        if (this.activeRequests === 0) {
          for (const waiter of this.idleWaiters) { waiter(); }
          this.idleWaiters.clear();
        }
      };
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        try {
          let insert: () => void | Promise<void>;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (req.url === '/v1/traces') {
              const rows = parseOtlpTraces(body);
              insert = () => this.store.insertSpans(rows);
            } else if (req.url === '/v1/metrics') {
              const rows = parseOtlpMetrics(body);
              insert = () => this.store.insertMetrics(rows);
            } else if (req.url === '/v1/logs') {
              const rows = parseOtlpLogs(body);
              insert = () => this.store.insertLogs(rows);
            } else {
              insert = () => undefined;
            }
          } catch {
            res.writeHead(400).end();
            return;
          }

          try {
            await insert();
            res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
          } catch (error) {
            console.error('Agent Insights: failed to store OTLP telemetry', error);
            res.writeHead(500).end();
          }
        } finally {
          finish();
        }
      });
      req.on('close', () => {
        if (!req.complete) { finish(); }
      });
      req.on('error', finish);
    });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.accepting = true;
      const onError = (error: Error): void => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, '127.0.0.1');
    });
  }

  beginDrain(): void {
    this.accepting = false;
  }

  waitForIdle(): Promise<void> {
    if (this.activeRequests === 0) { return Promise.resolve(); }
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }

  stop(): Promise<void> {
    this.beginDrain();
    if (!this.server.listening) { return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      this.server.close(err => (err ? reject(err) : resolve()));
    });
  }
}
