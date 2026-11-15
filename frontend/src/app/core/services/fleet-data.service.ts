import { Injectable, signal } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { forkJoin, map, Observable, tap } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  BackendAlertRule,
  BackendMetricRecord,
  BackendServiceRecord,
  MetricEvent,
  MetricHistoryPoint,
  MetricSnapshot,
  ServiceRecord,
  ServiceStatus,
} from '../../models/service.model';

@Injectable({ providedIn: 'root' })
export class FleetDataService {
  private readonly baseUrl = environment.apiBaseUrl;
  readonly services = signal<ServiceRecord[]>([]);

  constructor(private readonly http: HttpClient) {}

  getServices(): Observable<ServiceRecord[]> {
    return forkJoin({
      services: this.http.get<BackendServiceRecord[]>(this.url('/services')),
      snapshot: this.getSnapshot(),
    }).pipe(
      map(({ services, snapshot }) => this.mapServices(services, snapshot.metrics)),
      tap((services) => this.services.set(services)),
    );
  }

  getSnapshot(): Observable<MetricSnapshot> {
    return this.http.get<MetricSnapshot>(this.url('/metrics/snapshot'));
  }

  getMetricHistory(serviceId: string, minutes = 15): Observable<MetricHistoryPoint[]> {
    return this.http.get<{ points: MetricHistoryPoint[] }>(this.url('/metrics/history'), {
      params: { serviceId, minutes },
    }).pipe(map((response) => response.points));
  }

  getReplay(since: number): Observable<{ offset: number; events: MetricEvent[] }> {
    return this.http.get<{ offset: number; events: MetricEvent[] }>(this.url('/metrics/replay'), {
      params: { since },
    });
  }

  applyMetricEvents(events: MetricEvent[]): void {
    if (this.services().length === 0 || events.length === 0) return;

    const updates = new Map<string, MetricEvent>();
    for (const event of events) updates.set(event.serviceId, event);

    this.services.update((services) => services.map((service) => {
      const event = updates.get(service.id);
      return event ? this.applyMetric(service, event) : service;
    }));
  }

  applySnapshot(snapshot: MetricSnapshot): MetricEvent[] {
    const events = snapshot.metrics.map((metric) => this.toMetricEvent(metric, snapshot.offset));
    this.applyMetricEvents(events);
    return events;
  }

  getRules(): Observable<BackendAlertRule[]> {
    return this.http.get<BackendAlertRule[]>(this.url('/rules'));
  }

  getRule(id: string): Observable<BackendAlertRule> {
    return this.http.get<BackendAlertRule>(this.url(`/rules/${encodeURIComponent(id)}`));
  }

  checkRuleName(name: string, excludeId = ''): Observable<{ available: boolean }> {
    return this.http.get<{ available: boolean }>(this.url('/rules/check-name'), {
      params: { name, excludeId },
    });
  }

  createRule(rule: Record<string, unknown>, idempotencyKey: string): Observable<BackendAlertRule> {
    const headers = new HttpHeaders({ 'Idempotency-Key': idempotencyKey });
    return this.http.post<BackendAlertRule>(this.url('/rules'), rule, { headers });
  }

  updateRule(id: string, rule: Record<string, unknown>): Observable<BackendAlertRule> {
    return this.http.put<BackendAlertRule>(this.url(`/rules/${encodeURIComponent(id)}`), rule);
  }

  deleteRule(id: string): Observable<void> {
    return this.http.delete<void>(this.url(`/rules/${encodeURIComponent(id)}`));
  }

  updateChaos(settings: Record<string, unknown>): Observable<Record<string, unknown>> {
    return this.http.post<Record<string, unknown>>(this.url('/chaos'), settings);
  }

  getChaos(): Observable<Record<string, unknown>> {
    return this.http.get<Record<string, unknown>>(this.url('/chaos'));
  }

  private mapServices(
    services: BackendServiceRecord[],
    metrics: BackendMetricRecord[],
  ): ServiceRecord[] {
    const metricsById = new Map(metrics.map((metric) => [metric.serviceId, metric]));
    return services.map((service) => {
      const metric = metricsById.get(service.id);
      return {
        id: service.id,
        name: service.name,
        team: service.team,
        region: service.region || 'Unknown',
        status: this.toServiceStatus(metric?.status || service.status),
        latency: metric?.p95 ?? 0,
        errorRate: metric?.errRate ?? 0,
        requestsPerSecond: metric?.rps ?? 0,
        lastUpdated: new Date(metric?.ts ?? Date.now()).toISOString(),
      };
    });
  }

  private applyMetric(service: ServiceRecord, event: MetricEvent): ServiceRecord {
    return {
      ...service,
      status: this.toServiceStatus(event.status),
      latency: event.p95,
      errorRate: event.errRate,
      requestsPerSecond: event.rps,
      lastUpdated: new Date(event.ts).toISOString(),
    };
  }

  private toMetricEvent(metric: BackendMetricRecord, defaultOffset: number): MetricEvent {
    return {
      type: 'metric',
      offset: metric.offset ?? defaultOffset,
      serviceId: metric.serviceId,
      seq: metric.seq ?? 0,
      ts: metric.ts,
      p95: metric.p95,
      errRate: metric.errRate,
      rps: metric.rps,
      status: metric.status || 'healthy',
    };
  }

  private toServiceStatus(status: string): ServiceStatus {
    if (status === 'healthy') return 'Healthy';
    if (status === 'degraded') return 'Warning';
    if (status === 'down') return 'Critical';
    return 'Offline';
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }
}
