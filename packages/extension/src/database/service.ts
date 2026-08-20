import type { LogRow, MetricRow, SpanRow } from '@agent-insights/receiver';
import type {
  DatabaseArgs,
  DatabaseOperation,
  DatabaseResult,
} from './protocol';

export interface TelemetryDatabase {
  readonly isWritable: boolean;

  request<K extends DatabaseOperation>(
    operation: K,
    args: DatabaseArgs<K>,
  ): Promise<DatabaseResult<K>>;

  insertSpans(rows: SpanRow[]): Promise<void>;
  insertMetrics(rows: MetricRow[]): Promise<void>;
  insertLogs(rows: LogRow[]): Promise<void>;

  reloadFromDisk(): Promise<void>;
  enablePersistence(): Promise<void>;
  relinquishPersistence(): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}
