import {
  OtlpReceiver,
  probeCollector,
  type CollectorIdentity,
} from '@agent-insights/receiver';
import type { TelemetryDatabase } from './database/service';

const HEARTBEAT_INTERVAL_MS = 2_000;
const HEARTBEAT_FAILURE_THRESHOLD = 2;
const TAKEOVER_JITTER_MS = 750;
const COLLISION_PROBE_ATTEMPTS = 3;
const COLLISION_PROBE_DELAY_MS = 100;

export interface CollectorStatusSink {
  setListening(port: number): void;
  setFollowing(port: number): void;
  setReconnecting(port: number): void;
  setUnknownCollector(port: number): void;
  setReceiverError(port: number, error: unknown): void;
}

export interface CollectorCoordinatorCallbacks {
  onPortChange(port: number): void;
  onOwner(port: number): void;
  onUnknownCollector(port: number): void;
  onStartFailure(port: number, error: unknown): void;
  onLifecycleError(error: unknown): void;
}

function isPortInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'
    || String(error).includes('EADDRINUSE');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class CollectorCoordinator {
  private receiver?: OtlpReceiver;
  private monitorTimer?: ReturnType<typeof setInterval>;
  private takeoverTimer?: ReturnType<typeof setTimeout>;
  private operation: Promise<void> = Promise.resolve();
  private probeInFlight = false;
  private readonly probeIdleWaiters = new Set<() => void>();
  private heartbeatFailures = 0;
  private followedInstanceId?: string;
  private unknownWarningPort?: number;
  private currentPort?: number;
  private desiredPort?: number;
  private monitorGeneration = 0;
  private shuttingDown = false;

  constructor(
    private readonly store: TelemetryDatabase,
    private readonly status: CollectorStatusSink,
    private readonly callbacks: CollectorCoordinatorCallbacks,
  ) {}

  start(port: number): Promise<void> {
    this.desiredPort = port;
    return this.enqueue(() => this.tryOwn(port, false));
  }

  restart(port: number): Promise<void> {
    this.desiredPort = port;
    return this.enqueue(async () => {
      const wasOwner = this.receiver !== undefined;
      this.stopMonitoring();
      await this.relinquishReceiver();
      await this.tryOwn(port, !wasOwner);
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopMonitoring();
    if (this.probeInFlight) {
      await new Promise<void>(resolve => this.probeIdleWaiters.add(resolve));
    }
    await this.operation;

    if (this.receiver) {
      this.receiver.beginDrain();
      await this.receiver.waitForIdle();
      try {
        await this.store.relinquishPersistence();
      } catch (error) {
        this.callbacks.onLifecycleError(error);
      }
      await this.store.close().catch(error => this.callbacks.onLifecycleError(error));
      await this.receiver.stop().catch(error => this.callbacks.onLifecycleError(error));
      this.receiver = undefined;
      return;
    }

    await this.store.close().catch(error => this.callbacks.onLifecycleError(error));
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.operation.then(task, task);
    this.operation = next.catch(error => this.callbacks.onLifecycleError(error));
    return next;
  }

  private async tryOwn(port: number, reloadFromDisk: boolean): Promise<void> {
    if (this.shuttingDown || this.desiredPort !== port) { return; }
    this.currentPort = port;
    this.callbacks.onPortChange(port);

    if (reloadFromDisk) {
      try {
        await this.store.reloadFromDisk();
      } catch (error) {
        if (this.shuttingDown || this.desiredPort !== port) { return; }
        this.status.setReceiverError(port, error);
        this.callbacks.onStartFailure(port, error);
        return;
      }
      if (this.shuttingDown || this.desiredPort !== port) { return; }
    }

    const candidate = new OtlpReceiver(this.store, port);
    try {
      await candidate.start();
      if (this.shuttingDown || this.desiredPort !== port) {
        await candidate.stop();
        return;
      }
      this.followedInstanceId = undefined;
      this.heartbeatFailures = 0;
      this.unknownWarningPort = undefined;
      await this.store.enablePersistence();
      this.receiver = candidate;
      this.status.setListening(port);
      this.callbacks.onOwner(port);
    } catch (error) {
      await candidate.stop().catch(() => undefined);
      if (this.shuttingDown || this.desiredPort !== port) { return; }
      if (isPortInUse(error)) {
        const identity = await this.probeAfterCollision(port);
        if (this.shuttingDown || this.desiredPort !== port) { return; }
        if (identity) {
          this.follow(port, identity);
        } else {
          this.reportUnknownCollector(port);
        }
        return;
      }

      this.status.setReceiverError(port, error);
      this.callbacks.onStartFailure(port, error);
    }
  }

  private follow(port: number, identity: CollectorIdentity): void {
    if (this.shuttingDown || this.desiredPort !== port) { return; }
    this.currentPort = port;
    this.callbacks.onPortChange(port);
    this.receiver = undefined;
    this.followedInstanceId = identity.instanceId;
    this.heartbeatFailures = 0;
    this.unknownWarningPort = undefined;
    this.status.setFollowing(port);
    this.stopMonitoring();
    const generation = this.monitorGeneration;
    this.monitorTimer = setInterval(() => { void this.checkOwner(generation); }, HEARTBEAT_INTERVAL_MS);
  }

  private async checkOwner(generation: number): Promise<void> {
    const port = this.currentPort;
    if (
      this.shuttingDown
      || generation !== this.monitorGeneration
      || port === undefined
      || this.probeInFlight
    ) { return; }

    this.probeInFlight = true;
    try {
      const identity = await probeCollector(port);
      if (generation !== this.monitorGeneration || this.desiredPort !== port) { return; }
      if (identity) {
        this.heartbeatFailures = 0;
        if (identity.instanceId !== this.followedInstanceId) {
          this.followedInstanceId = identity.instanceId;
          this.status.setFollowing(port);
        }
        return;
      }

      this.heartbeatFailures++;
      if (this.heartbeatFailures < HEARTBEAT_FAILURE_THRESHOLD) { return; }

      this.stopMonitoring();
      this.status.setReconnecting(port);
      const jitter = Math.floor(Math.random() * TAKEOVER_JITTER_MS);
      this.takeoverTimer = setTimeout(() => {
        this.takeoverTimer = undefined;
        void this.enqueue(() => this.attemptTakeover(port));
      }, jitter);
    } finally {
      this.probeInFlight = false;
      for (const waiter of this.probeIdleWaiters) { waiter(); }
      this.probeIdleWaiters.clear();
    }
  }

  private async attemptTakeover(port: number): Promise<void> {
    if (this.shuttingDown || this.desiredPort !== port) { return; }

    const replacement = await probeCollector(port);
    if (replacement) {
      this.follow(port, replacement);
      return;
    }
    await this.tryOwn(port, true);
  }

  private async relinquishReceiver(): Promise<void> {
    const active = this.receiver;
    if (!active) { return; }

    active.beginDrain();
    await active.waitForIdle();
    try {
      await this.store.relinquishPersistence();
    } catch (error) {
      this.callbacks.onLifecycleError(error);
    }
    await active.stop().catch(error => this.callbacks.onLifecycleError(error));
    this.receiver = undefined;
  }

  private async probeAfterCollision(port: number): Promise<CollectorIdentity | undefined> {
    for (let attempt = 0; attempt < COLLISION_PROBE_ATTEMPTS; attempt++) {
      const identity = await probeCollector(port);
      if (identity) { return identity; }
      if (attempt + 1 < COLLISION_PROBE_ATTEMPTS) {
        await delay(COLLISION_PROBE_DELAY_MS);
      }
    }
    return undefined;
  }

  private reportUnknownCollector(port: number): void {
    this.stopMonitoring();
    this.status.setUnknownCollector(port);
    if (this.unknownWarningPort === port) { return; }
    this.unknownWarningPort = port;
    this.callbacks.onUnknownCollector(port);
  }

  private stopMonitoring(): void {
    this.monitorGeneration++;
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = undefined;
    }
    if (this.takeoverTimer) {
      clearTimeout(this.takeoverTimer);
      this.takeoverTimer = undefined;
    }
    this.heartbeatFailures = 0;
  }
}
