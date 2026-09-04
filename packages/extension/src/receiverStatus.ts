import type { ReceiverStatus, ReceiverStatusState } from '@agent-insights/types';
import type { CollectorStatusSink } from './collectorCoordinator';

export class ReceiverStatusController implements CollectorStatusSink {
  constructor(
    private readonly delegate: CollectorStatusSink,
    private readonly onChange: (status: ReceiverStatus) => void,
  ) {}

  setStarting(port: number): void {
    this.update('starting', port);
  }

  setListening(port: number): void {
    this.delegate.setListening(port);
    this.update('listening', port);
  }

  setFollowing(port: number): void {
    this.delegate.setFollowing(port);
    this.update('following', port);
  }

  setReconnecting(port: number): void {
    this.delegate.setReconnecting(port);
    this.update('reconnecting', port);
  }

  setUnknownCollector(port: number): void {
    this.delegate.setUnknownCollector(port);
    this.update('unknown', port);
  }

  setReceiverError(port: number, error: unknown): void {
    this.delegate.setReceiverError(port, error);
    this.update('error', port);
  }

  private update(state: ReceiverStatusState, port: number): void {
    this.onChange({ state, port });
  }
}
