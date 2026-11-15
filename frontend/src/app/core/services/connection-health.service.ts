import { Injectable, OnDestroy, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, Subscription } from 'rxjs';

import { environment } from '../../../environments/environment';
import { MetricEvent, MetricSnapshot } from '../../models/service.model';
import { FleetDataService } from './fleet-data.service';

export type ConnectionState = 'Live' | 'Polling' | 'Reconnecting' | 'Offline' | 'Stale';
export type ConnectionTransport = 'WebSocket' | 'SSE' | 'Polling' | 'Offline';

export interface ConnectionSnapshot {
  state: ConnectionState;
  transport: ConnectionTransport;
  lastEventAt: Date | null;
  retryInSeconds: number;
  secondsSinceLastEvent: number;
}

@Injectable({ providedIn: 'root' })
export class ConnectionHealthService implements OnDestroy {
  private readonly statusSignal = signal<ConnectionSnapshot>({
    state: 'Offline',
    transport: 'Offline',
    lastEventAt: null,
    retryInSeconds: 0,
    secondsSinceLastEvent: 0,
  });
  readonly status = this.statusSignal.asReadonly();

  private readonly metricBatchSubject = new Subject<MetricEvent[]>();
  readonly metricBatches$ = this.metricBatchSubject.asObservable();

  private readonly pendingEvents = new Map<number, MetricEvent>();
  private readonly queuedEvents: MetricEvent[] = [];
  private readonly lastSequenceByService = new Map<string, number>();

  private accessToken = '';
  readonly malformedEventCount = signal(0);
  readonly duplicateEventCount = signal(0);
  readonly sequenceGapCount = signal(0);
  private webSocketFailures = 0;
  private sseFailures = 0;
  private lastOffset = 0;
  private lastHeartbeatAt = 0;
  private hasOffset = false;
  private generation = 0;
  private replayInProgress = false;
  private pollInProgress = false;
  private webSocket: WebSocket | null = null;
  private eventSource: EventSource | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private gapTimer: ReturnType<typeof setTimeout> | undefined;
  private retryCountdown: ReturnType<typeof setInterval> | undefined;
  private pollingTimer: ReturnType<typeof setInterval> | undefined;
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  private batchTimer: ReturnType<typeof setInterval> | undefined;
  private staleTimer: ReturnType<typeof setInterval> | undefined;
  private pollSubscription: Subscription | undefined;
  private onlineListener: (() => void) | undefined;
  private offlineListener: (() => void) | undefined;

  constructor(private readonly fleetData: FleetDataService) {
    this.batchTimer = setInterval(() => this.flushMetricBatch(), 100);
    this.staleTimer = setInterval(() => {
      this.checkStaleData();
      this.checkHeartbeat();
    }, 1000);

    if (typeof window !== 'undefined') {
      this.onlineListener = () => this.handleOnline();
      this.offlineListener = () => this.handleOffline();
      window.addEventListener('online', this.onlineListener);
      window.addEventListener('offline', this.offlineListener);
    }
  }

  connect(token: string): void {
    if (!token) return;
    if (token === this.accessToken && this.statusSignal().state !== 'Offline') return;

    this.accessToken = token;
    this.generation += 1;
    this.closeTransports();

    if (!this.isBrowserOnline()) {
      this.setStatus('Offline', 'Offline');
      return;
    }

    if (this.hasOffset) {
      this.startWebSocket(this.generation);
      return;
    }

    this.setStatus('Reconnecting', 'WebSocket', 0);
    const generation = this.generation;
    this.fleetData.getSnapshot().subscribe({
      next: (snapshot) => {
        if (this.generation !== generation) return;
        this.applySnapshot(snapshot);
        this.startWebSocket(generation);
      },
      error: () => this.startWebSocket(generation),
    });
  }

  disconnect(): void {
    this.accessToken = '';
    this.generation += 1;
    this.closeTransports();
    this.pendingEvents.clear();
    this.queuedEvents.length = 0;
    this.setStatus('Offline', 'Offline');
  }

  ngOnDestroy(): void {
    this.disconnect();
    clearInterval(this.batchTimer);
    clearInterval(this.staleTimer);
    if (typeof window !== 'undefined') {
      if (this.onlineListener) window.removeEventListener('online', this.onlineListener);
      if (this.offlineListener) window.removeEventListener('offline', this.offlineListener);
    }
    this.metricBatchSubject.complete();
  }

  private startWebSocket(generation: number, keepPolling = false): void {
    if (generation !== this.generation || !this.accessToken) return;
    if (!keepPolling) this.setStatus('Reconnecting', 'WebSocket', 0);

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.webSocketUrl());
    } catch (_error) {
      this.handleWebSocketFailure(generation, keepPolling);
      return;
    }
    this.webSocket = socket;
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (generation === this.generation && socket.readyState !== WebSocket.OPEN) socket.close();
    }, 5000);
    socket.onopen = () => {
      if (generation !== this.generation) return socket.close();
      clearTimeout(this.connectTimer);
      this.clearRetry();
      this.webSocketFailures = 0;
      this.lastHeartbeatAt = Date.now();
      if (keepPolling) this.stopPolling();
      this.eventSource?.close();
      this.eventSource = null;
      this.setStatus('Live', 'WebSocket', 0);
      this.requestReplay();
    };
    socket.onmessage = (message) => {
      if (generation !== this.generation) return;
      this.handleStreamMessage(message.data);
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (generation !== this.generation) return;
      this.webSocket = null;
      clearTimeout(this.connectTimer);
      this.handleWebSocketFailure(generation, keepPolling);
    };
  }

  private startSse(generation: number, keepPolling = false): void {
    if (generation !== this.generation || !this.accessToken) return;
    if (!keepPolling) this.setStatus('Reconnecting', 'SSE', 0);
    let source: EventSource;
    try {
      source = new EventSource(this.sseUrl());
    } catch (_error) {
      this.handleSseFailure(generation, keepPolling);
      return;
    }
    this.eventSource = source;
    source.onopen = () => {
      if (generation !== this.generation) return source.close();
      this.sseFailures = 0;
      this.lastHeartbeatAt = Date.now();
      if (keepPolling) this.stopPolling();
      this.setStatus('Live', 'SSE', 0);
      this.requestReplay();
      this.scheduleWebSocketProbe(generation);
    };
    source.addEventListener('metric', (rawEvent: Event) => {
      if (generation !== this.generation) return;
      this.handleStreamMessage((rawEvent as MessageEvent<string>).data);
    });
    source.addEventListener('ping', () => this.markHeartbeat());
    source.onerror = () => {
      source.close();
      if (generation === this.generation) {
        this.eventSource = null;
        this.handleSseFailure(generation, keepPolling);
      }
    };
  }

  private startPolling(generation: number): void {
    if (generation !== this.generation || !this.accessToken) return;
    this.clearRetry();
    this.stopPolling();
    this.setStatus('Polling', 'Polling', 0);
    this.pollSnapshot(generation);
    this.pollingTimer = setInterval(() => this.pollSnapshot(generation), 2000);
    this.scheduleWebSocketProbe(generation);
  }

  private pollSnapshot(generation: number): void {
    if (this.pollInProgress || generation !== this.generation) return;
    this.pollInProgress = true;
    this.pollSubscription = this.fleetData.getSnapshot().subscribe({
      next: (snapshot) => {
        if (generation === this.generation) this.applySnapshot(snapshot);
        this.pollInProgress = false;
      },
      error: () => {
        this.pollInProgress = false;
        if (generation === this.generation && !this.isBrowserOnline()) {
          this.setStatus('Offline', 'Offline');
        }
      },
    });
  }

  private applySnapshot(snapshot: MetricSnapshot): void {
    const events = this.fleetData.applySnapshot(snapshot);
    this.hasOffset = true;
    this.lastOffset = snapshot.offset;
    this.pendingEvents.clear();
    clearTimeout(this.gapTimer);
    this.gapTimer = undefined;
    this.lastSequenceByService.clear();
    for (const event of events) this.lastSequenceByService.set(event.serviceId, event.seq);
    this.publishMetricBatch(events);
    this.markFreshEvent();
  }

  private handleStreamMessage(rawData: unknown): void {
    try {
      const data = typeof rawData === 'string' ? JSON.parse(rawData) as Record<string, unknown> : null;
      if (!data) {
        this.malformedEventCount.update((count) => count + 1);
        return;
      }
      if (data['type'] === 'ping') {
        this.markHeartbeat();
        return;
      }
      if (!this.isMetricEvent(data)) {
        this.malformedEventCount.update((count) => count + 1);
        return;
      }
      this.acceptMetricEvent(data);
    } catch (_error) {
      this.malformedEventCount.update((count) => count + 1);
    }
  }

  private acceptMetricEvent(event: MetricEvent): void {
    if (!this.hasOffset) {
      this.hasOffset = true;
      this.lastOffset = 0;
    }
    if (event.offset <= this.lastOffset || this.pendingEvents.has(event.offset)) {
      this.duplicateEventCount.update((count) => count + 1);
      return;
    }

    this.pendingEvents.set(event.offset, event);
    this.flushContiguousEvents();

    if (event.offset > this.lastOffset + 1 && !this.gapTimer) {
      // Give shuffled events up to one second to arrive before requesting replay.
      this.gapTimer = setTimeout(() => {
        this.gapTimer = undefined;
        this.requestReplay();
      }, 1000);
    }
  }

  private flushContiguousEvents(): void {
    const events: MetricEvent[] = [];
    while (this.pendingEvents.has(this.lastOffset + 1)) {
      const nextOffset = this.lastOffset + 1;
      const event = this.pendingEvents.get(nextOffset);
      if (!event) break;
      this.pendingEvents.delete(nextOffset);
      this.lastOffset = nextOffset;

      const previousSequence = this.lastSequenceByService.get(event.serviceId) ?? 0;
      if (event.seq <= previousSequence) {
        this.duplicateEventCount.update((count) => count + 1);
        continue;
      }
      if (previousSequence > 0 && event.seq > previousSequence + 1) {
        this.sequenceGapCount.update((count) => count + 1);
      }
      this.lastSequenceByService.set(event.serviceId, event.seq);
      events.push(event);
    }
    if (this.pendingEvents.size === 0) {
      clearTimeout(this.gapTimer);
      this.gapTimer = undefined;
    }
    if (events.length > 0) this.publishMetricBatch(events);
  }

  private requestReplay(): void {
    if (!this.hasOffset || this.replayInProgress || !this.accessToken) return;
    this.replayInProgress = true;
    this.fleetData.getReplay(this.lastOffset).subscribe({
      next: (result) => {
        const previousOffset = this.lastOffset;
        for (const event of result.events) {
          if (event.offset <= this.lastOffset || this.pendingEvents.has(event.offset)) {
            this.duplicateEventCount.update((count) => count + 1);
          } else {
            this.pendingEvents.set(event.offset, event);
          }
        }
        this.flushContiguousEvents();
        this.replayInProgress = false;
        if (this.lastOffset === previousOffset && result.offset > this.lastOffset) {
          this.loadSnapshot();
          return;
        }
        if (this.hasOffset && this.pendingEvents.size > 0 && !this.pendingEvents.has(this.lastOffset + 1)) {
          this.gapTimer = setTimeout(() => {
            this.gapTimer = undefined;
            this.requestReplay();
          }, 1000);
        }
      },
      error: (error: unknown) => {
        this.replayInProgress = false;
        if (error instanceof HttpErrorResponse && error.error?.error?.code === 'replay_too_old') {
          this.loadSnapshot();
        }
      },
    });
  }

  private publishMetricBatch(events: MetricEvent[]): void {
    if (events.length === 0) return;
    this.queuedEvents.push(...events);
    const latestTimestamp = Math.max(...events.map((event) => event.ts));
    this.markFreshEvent(new Date(latestTimestamp));
  }

  private flushMetricBatch(): void {
    if (this.queuedEvents.length === 0) return;
    const events = this.queuedEvents.splice(0, this.queuedEvents.length);
    this.fleetData.applyMetricEvents(events);
    this.metricBatchSubject.next(events);
  }

  private isMetricEvent(data: unknown): data is MetricEvent {
    if (typeof data !== 'object' || data === null) return false;
    const candidate = data as Record<string, unknown>;
    return candidate['type'] === 'metric'
      && Number.isSafeInteger(candidate['offset'])
      && typeof candidate['serviceId'] === 'string'
      && candidate['serviceId'].length > 0
      && Number.isSafeInteger(candidate['seq'])
      && typeof candidate['ts'] === 'number' && Number.isFinite(candidate['ts'])
      && typeof candidate['p95'] === 'number' && Number.isFinite(candidate['p95'])
      && typeof candidate['errRate'] === 'number' && Number.isFinite(candidate['errRate'])
      && typeof candidate['rps'] === 'number' && Number.isFinite(candidate['rps'])
      && ['healthy', 'degraded', 'down'].includes(String(candidate['status']));
  }

  private markFreshEvent(eventAt = new Date()): void {
    const current = this.statusSignal();
    const transport = current.transport;
    if (current.state === 'Offline') return;
    this.statusSignal.set({
      state: current.state === 'Reconnecting' ? 'Reconnecting' : transport === 'Polling' ? 'Polling' : 'Live',
      transport,
      lastEventAt: eventAt,
      retryInSeconds: 0,
      secondsSinceLastEvent: 0,
    });
  }

  private markHeartbeat(): void {
    this.lastHeartbeatAt = Date.now();
  }

  private checkHeartbeat(): void {
    const current = this.statusSignal();
    if (current.state !== 'Live' || current.transport === 'Polling' || this.lastHeartbeatAt === 0) return;
    if (Date.now() - this.lastHeartbeatAt < 10_000) return;

    if (current.transport === 'WebSocket') this.webSocket?.close();
    if (current.transport === 'SSE' && this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      this.handleSseFailure(this.generation, false);
    }
  }

  private loadSnapshot(): void {
    this.fleetData.getSnapshot().subscribe({
      next: (snapshot) => this.applySnapshot(snapshot),
      error: () => this.setStatus('Offline', 'Offline'),
    });
  }

  private handleWebSocketFailure(generation: number, keepLowerTransport: boolean): void {
    if (generation !== this.generation || !this.isBrowserOnline()) return;
    this.webSocketFailures += 1;
    if (keepLowerTransport) {
      if (this.statusSignal().transport === 'Polling') this.startSse(generation, true);
      else this.scheduleWebSocketProbe(generation);
      return;
    }
    if (this.webSocketFailures >= 3) {
      this.clearRetry();
      this.startSse(generation);
      return;
    }
    this.scheduleRetry('WebSocket', () => this.startWebSocket(generation));
  }

  private handleSseFailure(generation: number, keepLowerTransport: boolean): void {
    if (generation !== this.generation || !this.isBrowserOnline()) return;
    this.sseFailures += 1;
    if (keepLowerTransport || this.sseFailures >= 3) {
      this.clearRetry();
      this.startPolling(generation);
      return;
    }
    this.scheduleRetry('SSE', () => this.startSse(generation));
  }

  private checkStaleData(): void {
    const current = this.statusSignal();
    if (current.state === 'Offline' || current.state === 'Reconnecting') return;
    if (!current.lastEventAt) return;

    const seconds = Math.floor((Date.now() - current.lastEventAt.getTime()) / 1000);
    const state = seconds > 10 ? 'Stale' : current.transport === 'Polling' ? 'Polling' : 'Live';
    this.statusSignal.set({ ...current, state, secondsSinceLastEvent: seconds });
  }

  private setStatus(state: ConnectionState, transport: ConnectionTransport, retryInSeconds = 0): void {
    this.statusSignal.set({
      ...this.statusSignal(),
      state,
      transport,
      retryInSeconds,
    });
  }

  private scheduleRetry(nextTransport: ConnectionTransport, action: () => void): void {
    this.clearRetry();
    const attempts = nextTransport === 'WebSocket' ? this.webSocketFailures : this.sseFailures;
    const delayMs = getReconnectDelay(attempts);
    let secondsLeft = Math.ceil(delayMs / 1000);
    this.setStatus('Reconnecting', nextTransport, secondsLeft);
    this.retryCountdown = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft <= 0) {
        this.clearRetry();
        if (this.isBrowserOnline()) action();
      } else {
        this.setStatus('Reconnecting', nextTransport, secondsLeft);
      }
    }, Math.min(1000, delayMs));
    this.retryTimer = setTimeout(() => {
      this.clearRetry();
      if (this.isBrowserOnline()) action();
    }, delayMs);
  }

  private scheduleWebSocketProbe(generation: number): void {
    clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => this.startWebSocket(generation, true), 30_000);
  }

  private stopPolling(): void {
    clearInterval(this.pollingTimer);
    clearTimeout(this.probeTimer);
    this.pollSubscription?.unsubscribe();
    this.pollSubscription = undefined;
    this.pollInProgress = false;
  }

  private clearRetry(): void {
    clearTimeout(this.retryTimer);
    clearInterval(this.retryCountdown);
    this.retryTimer = undefined;
    this.retryCountdown = undefined;
  }

  private closeTransports(): void {
    this.clearRetry();
    clearTimeout(this.connectTimer);
    clearTimeout(this.gapTimer);
    this.stopPolling();
    this.webSocket?.close();
    this.webSocket = null;
    this.eventSource?.close();
    this.eventSource = null;
  }

  private handleOffline(): void {
    this.generation += 1;
    this.closeTransports();
    this.setStatus('Offline', 'Offline');
  }

  private handleOnline(): void {
    if (this.accessToken) {
      this.hasOffset = false;
      this.connect(this.accessToken);
    }
  }

  private isBrowserOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine;
  }

  private webSocketUrl(): string {
    const apiUrl = environment.apiBaseUrl.replace(/^http/, 'ws');
    return `${apiUrl}/stream?access_token=${encodeURIComponent(this.accessToken)}`;
  }

  private sseUrl(): string {
    return `${environment.apiBaseUrl}/stream/sse?access_token=${encodeURIComponent(this.accessToken)}`;
  }
}

export function getReconnectDelay(failures: number, randomValue = Math.random()): number {
  const maximum = Math.min(30_000, 1000 * (2 ** Math.max(0, failures - 1)));
  return Math.max(250, Math.floor(Math.max(0, Math.min(1, randomValue)) * maximum));
}
