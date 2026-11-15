import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

import { ServiceRecord, SimulatedMetricEvent } from '../../models/service.model';

interface CurrentMetricValues {
  latencyP95: number;
  errorRate: number;
  requestsPerSecond: number;
}

@Injectable({ providedIn: 'root' })
export class MetricSimulationService {
  private readonly batchSubject = new Subject<SimulatedMetricEvent[]>();
  readonly batches$ = this.batchSubject.asObservable();

  private readonly currentValues = new Map<string, CurrentMetricValues>();
  private readonly pendingEvents: SimulatedMetricEvent[] = [];
  private readonly knownServiceIds = new Set<string>();
  private sequence = 0;
  private lastAcceptedSequence = 0;
  private generationTimer: ReturnType<typeof setInterval> | undefined;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private eventRate = 500;
  private paused = false;

  duplicateEventCount = 0;
  outdatedEventCount = 0;
  missingSequenceCount = 0;
  malformedEventCount = 0;

  get isRunning(): boolean {
    return this.generationTimer !== undefined;
  }

  get eventsPerSecond(): number {
    return this.eventRate;
  }

  ngOnDestroy(): void {
    this.stop();
    this.batchSubject.complete();
  }

  start(services: ServiceRecord[]): void {
    if (this.isRunning || services.length === 0) {
      return;
    }

    for (const service of services) {
      this.knownServiceIds.add(service.id);
      this.currentValues.set(service.id, {
        latencyP95: service.latency,
        errorRate: service.errorRate,
        requestsPerSecond: service.requestsPerSecond,
      });
    }

    // Generate the configured number of events each second.
    this.generationTimer = setInterval(() => this.generateEvents(), 1000);

    // Publish small batches every 100 ms instead of changing the UI per event.
    this.flushTimer = setInterval(() => this.publishBatch(), 100);
  }

  setEventsPerSecond(rate: number): void {
    if (rate === 500 || rate === 2000) {
      this.eventRate = rate;
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  stop(): void {
    if (this.generationTimer !== undefined) {
      clearInterval(this.generationTimer);
      this.generationTimer = undefined;
    }
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.publishBatch();
  }

  // This validation also gives future real transports one safe entry point.
  acceptEvent(rawEvent: unknown): void {
    if (!this.isValidEvent(rawEvent)) {
      this.malformedEventCount += 1;
      return;
    }

    if (rawEvent.sequence === this.lastAcceptedSequence) {
      this.duplicateEventCount += 1;
      return;
    }
    if (rawEvent.sequence < this.lastAcceptedSequence) {
      this.outdatedEventCount += 1;
      return;
    }
    if (rawEvent.sequence > this.lastAcceptedSequence + 1) {
      this.missingSequenceCount += rawEvent.sequence - this.lastAcceptedSequence - 1;
    }

    this.lastAcceptedSequence = rawEvent.sequence;
    this.sequence = Math.max(this.sequence, rawEvent.sequence);
    this.currentValues.set(rawEvent.serviceId, {
      latencyP95: rawEvent.latencyP95,
      errorRate: rawEvent.errorRate,
      requestsPerSecond: rawEvent.requestsPerSecond,
    });
    this.pendingEvents.push(rawEvent);
  }

  private generateEvents(): void {
    if (this.paused) {
      return;
    }

    const serviceIds = Array.from(this.knownServiceIds);

    for (let index = 0; index < this.eventRate; index += 1) {
      const serviceId = serviceIds[Math.floor(Math.random() * serviceIds.length)];
      const previous = this.currentValues.get(serviceId);
      if (!previous) {
        continue;
      }

      const event: SimulatedMetricEvent = {
        sequence: this.sequence + 1,
        serviceId,
        timestamp: new Date().toISOString(),
        latencyP95: Math.max(1, Math.round(previous.latencyP95 + this.randomBetween(-15, 15))),
        errorRate: Number(Math.max(0, Math.min(100, previous.errorRate + this.randomBetween(-0.3, 0.3))).toFixed(2)),
        requestsPerSecond: Math.max(0, Math.round(previous.requestsPerSecond + this.randomBetween(-25, 25))),
      };

      this.sequence += 1;
      this.acceptEvent(event);
    }
  }

  private publishBatch(): void {
    if (this.pendingEvents.length === 0) {
      return;
    }

    const batch = this.pendingEvents.splice(0, this.pendingEvents.length);
    this.batchSubject.next(batch);
  }

  private isValidEvent(event: unknown): event is SimulatedMetricEvent {
    if (typeof event !== 'object' || event === null) {
      return false;
    }

    const candidate = event as Record<string, unknown>;
    return Number.isInteger(candidate['sequence'])
      && Number(candidate['sequence']) > 0
      && typeof candidate['serviceId'] === 'string'
      && this.knownServiceIds.has(candidate['serviceId'])
      && typeof candidate['timestamp'] === 'string'
      && !Number.isNaN(Date.parse(candidate['timestamp']))
      && this.isValidMetric(candidate['latencyP95'], 100000)
      && this.isValidMetric(candidate['errorRate'], 100)
      && this.isValidMetric(candidate['requestsPerSecond'], 10000000);
  }

  private isValidMetric(value: unknown, maximum: number): boolean {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
  }

  private randomBetween(minimum: number, maximum: number): number {
    return Math.random() * (maximum - minimum) + minimum;
  }
}
