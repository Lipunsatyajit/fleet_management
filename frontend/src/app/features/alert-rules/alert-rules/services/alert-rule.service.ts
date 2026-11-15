import { Injectable, signal } from '@angular/core';
import { Observable, catchError, finalize, map, of, shareReplay, tap, throwError } from 'rxjs';

import { FleetDataService } from '../../../../core/services/fleet-data.service';
import { ConnectionHealthService } from '../../../../core/services/connection-health.service';
import { AppPreferencesService } from '../../../../core/services/app-preferences.service';
import { InAppNotificationService } from '../../../../core/services/in-app-notification.service';
import {
  AlertRuleCondition,
  AlertRuleRecord,
  BackendAlertRule,
  IncidentRecord,
  MetricEvent,
  ServiceRecord,
} from '../../../../models/service.model';

@Injectable({ providedIn: 'root' })
export class AlertRuleService {
  readonly rules = signal<AlertRuleRecord[]>([]);
  readonly incidents = signal<IncidentRecord[]>([]);

  private readonly conditionStartTimes = new Map<string, number>();
  private readonly serviceNames = new Map<string, string>();
  private pendingEvents: MetricEvent[] = [];
  private rulesLoaded = false;
  private loadRequest: Observable<void> | null = null;
  private nextIncidentNumber = 1;

  constructor(
    private readonly fleetData: FleetDataService,
    private readonly connection: ConnectionHealthService,
    private readonly preferences: AppPreferencesService,
    private readonly notifications: InAppNotificationService,
  ) {
    this.connection.metricBatches$.subscribe((events) => this.evaluateEvents(events));
  }

  load(): Observable<void> {
    if (this.rulesLoaded) return of(undefined);
    if (this.loadRequest) return this.loadRequest;

    this.loadRequest = this.fleetData.getRules().pipe(
      tap((rules) => {
        this.rules.set(rules.map((rule) => this.fromBackend(rule)));
        this.rulesLoaded = true;
        const eventsReceivedWhileLoading = this.pendingEvents;
        this.pendingEvents = [];
        this.evaluateEvents(eventsReceivedWhileLoading);
      }),
      map(() => undefined),
      catchError((error: unknown) => {
        this.loadRequest = null;
        return throwError(() => error);
      }),
      finalize(() => {
        if (this.rulesLoaded) this.loadRequest = null;
      }),
      shareReplay(1),
    );
    return this.loadRequest;
  }

  createRule(rule: AlertRuleRecord): Observable<AlertRuleRecord> {
    const requestBody = this.toBackend(rule);
    const key = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const oldRules = this.rules();
    this.rules.update((rules) => [...rules, rule]);

    return this.fleetData.createRule(requestBody, key).pipe(
      map((saved) => this.fromBackend(saved)),
      tap((saved) => this.rules.update((rules) => rules.map((item) => item.id === rule.id ? saved : item))),
      catchError((error: unknown) => {
        this.rules.set(oldRules);
        return throwError(() => error);
      }),
    );
  }

  updateRule(rule: AlertRuleRecord): Observable<AlertRuleRecord> {
    const oldRules = this.rules();
    this.rules.update((rules) => rules.map((item) => item.id === rule.id ? rule : item));
    return this.fleetData.updateRule(rule.id, this.toBackend(rule)).pipe(
      map((saved) => this.fromBackend(saved)),
      tap((saved) => this.rules.update((rules) => rules.map((item) => item.id === rule.id ? saved : item))),
      catchError((error: unknown) => {
        this.rules.set(oldRules);
        return throwError(() => error);
      }),
    );
  }

  deleteRule(ruleId: string): Observable<void> {
    const oldRules = this.rules();
    this.rules.update((rules) => rules.filter((rule) => rule.id !== ruleId));
    this.resolveRuleIncidents(ruleId);
    return this.fleetData.deleteRule(ruleId).pipe(
      tap({ error: () => this.rules.set(oldRules) }),
    );
  }

  toggleRule(ruleId: string): Observable<AlertRuleRecord> {
    const oldRules = this.rules();
    const rule = oldRules.find((item) => item.id === ruleId);
    if (!rule) return throwError(() => new Error('Rule not found'));
    const updatedRule = { ...rule, enabled: !rule.enabled };
    this.rules.update((rules) => rules.map((item) => item.id === ruleId ? updatedRule : item));
    if (!updatedRule.enabled) this.resolveRuleIncidents(ruleId);
    return this.fleetData.updateRule(ruleId, this.toBackend(updatedRule)).pipe(
      map((saved) => this.fromBackend(saved)),
      tap((saved) => this.rules.update((rules) => rules.map((item) => item.id === ruleId ? saved : item))),
      catchError((error: unknown) => {
        this.rules.set(oldRules);
        return throwError(() => error);
      }),
    );
  }

  setServiceNames(services: ServiceRecord[]): void {
    for (const service of services) this.serviceNames.set(service.id, service.name);
  }

  resolveIncident(incidentId: string): void {
    this.incidents.update((incidents) => incidents.map((incident) =>
      incident.id === incidentId ? { ...incident, status: 'resolved' } : incident,
    ));
  }

  private fromBackend(rule: BackendAlertRule): AlertRuleRecord {
    const conditions = rule.conditions.map((condition) => ({
      metric: this.toUiMetric(condition.metric),
      operator: condition.operator,
      threshold: condition.threshold,
      durationSec: condition.durationSec,
    }));
    const first = conditions[0];
    return {
      id: rule.id,
      name: rule.name,
      conditions,
      metric: first.metric,
      condition: this.toUiOperator(first.operator),
      threshold: first.threshold,
      duration: first.durationSec,
      enabled: rule.enabled ?? true,
      severity: rule.severity ?? 'warning',
    };
  }

  private toBackend(rule: AlertRuleRecord): Record<string, unknown> {
    const conditions: AlertRuleCondition[] = rule.conditions?.length
      ? rule.conditions
      : [{
        metric: rule.metric,
        operator: this.toApiOperator(rule.condition),
        threshold: rule.threshold,
        durationSec: rule.duration,
      }];
    return {
      name: rule.name,
      severity: rule.severity,
      enabled: rule.enabled,
      conditions: conditions.map((condition) => ({
        metric: this.toApiMetric(condition.metric),
        operator: condition.operator,
        threshold: condition.threshold,
        durationSec: condition.durationSec,
      })),
    };
  }

  private evaluateEvents(events: MetricEvent[]): void {
    if (!this.rulesLoaded) {
      this.pendingEvents.push(...events);
      return;
    }
    for (const event of events) {
      for (const rule of this.rules()) this.evaluateRule(rule, event);
    }
  }

  private evaluateRule(rule: AlertRuleRecord, event: MetricEvent): void {
    const baseKey = `${rule.id}:${event.serviceId}`;
    if (!rule.enabled) {
      this.clearRuleTimers(rule.id, event.serviceId);
      return;
    }
    const conditions = rule.conditions?.length ? rule.conditions : [{
      metric: rule.metric,
      operator: this.toApiOperator(rule.condition),
      threshold: rule.threshold,
      durationSec: rule.duration,
    }];

    let allConditionsMatch = true;
    let allDurationsPassed = true;
    let incidentValue = 0;
    for (let index = 0; index < conditions.length; index += 1) {
      const condition = conditions[index];
      const key = `${baseKey}:${index}`;
      const value = this.eventValue(event, condition.metric);
      if (!this.matches(value, condition.operator, condition.threshold)) {
        this.conditionStartTimes.delete(key);
        allConditionsMatch = false;
        allDurationsPassed = false;
        continue;
      }

      const startedAt = this.conditionStartTimes.get(key) ?? event.ts;
      this.conditionStartTimes.set(key, startedAt);
      if (index === 0) incidentValue = value;
      if (event.ts - startedAt < condition.durationSec * 1000) allDurationsPassed = false;
    }

    if (!allConditionsMatch) {
      this.resolveServiceRuleIncident(rule.id, event.serviceId);
      return;
    }
    if (allDurationsPassed) {
      this.createIncident(rule, event, incidentValue);
    }
  }

  private createIncident(rule: AlertRuleRecord, event: MetricEvent, value: number): void {
    if (this.incidents().some((incident) => incident.ruleId === rule.id && incident.serviceId === event.serviceId && incident.status === 'open')) return;
    const incident: IncidentRecord = {
      id: `INC-${String(this.nextIncidentNumber++).padStart(5, '0')}`,
      ruleId: rule.id,
      ruleName: rule.name,
      serviceId: event.serviceId,
      serviceName: this.serviceNames.get(event.serviceId) ?? event.serviceId,
      severity: rule.severity,
      triggeredAt: new Date(event.ts).toISOString(),
      currentValue: value,
      status: 'open',
    };
    this.incidents.update((incidents) => [incident, ...incidents].slice(0, 1000));
    if (this.preferences.current.notificationsEnabled) this.notifications.showIncident(incident);
  }

  private resolveRuleIncidents(ruleId: string): void {
    for (const key of this.conditionStartTimes.keys()) {
      if (key.startsWith(`${ruleId}:`)) this.conditionStartTimes.delete(key);
    }
    this.incidents.update((incidents) => incidents.map((incident) =>
      incident.ruleId === ruleId && incident.status === 'open' ? { ...incident, status: 'resolved' } : incident,
    ));
  }

  private resolveServiceRuleIncident(ruleId: string, serviceId: string): void {
    this.incidents.update((incidents) => incidents.map((incident) =>
      incident.ruleId === ruleId && incident.serviceId === serviceId && incident.status === 'open'
        ? { ...incident, status: 'resolved' }
        : incident,
    ));
  }

  private clearRuleTimers(ruleId: string, serviceId: string): void {
    for (const key of this.conditionStartTimes.keys()) {
      if (key.startsWith(`${ruleId}:${serviceId}:`)) this.conditionStartTimes.delete(key);
    }
    this.resolveServiceRuleIncident(ruleId, serviceId);
  }

  private eventValue(event: MetricEvent, metric: AlertRuleCondition['metric']): number {
    if (metric === 'latencyP95') return event.p95;
    if (metric === 'errorRate') return event.errRate;
    return event.rps;
  }

  private matches(value: number, operator: AlertRuleCondition['operator'], threshold: number): boolean {
    if (operator === '>') return value > threshold;
    if (operator === '>=') return value >= threshold;
    if (operator === '<') return value < threshold;
    return value <= threshold;
  }

  private toUiMetric(metric: 'p95' | 'errRate' | 'rps'): AlertRuleCondition['metric'] {
    if (metric === 'p95') return 'latencyP95';
    if (metric === 'errRate') return 'errorRate';
    return 'requestsPerSecond';
  }

  private toApiMetric(metric: AlertRuleCondition['metric']): 'p95' | 'errRate' | 'rps' {
    if (metric === 'latencyP95') return 'p95';
    if (metric === 'errorRate') return 'errRate';
    return 'rps';
  }

  private toUiOperator(operator: AlertRuleCondition['operator']): AlertRuleRecord['condition'] {
    if (operator === '>') return 'greaterThan';
    if (operator === '>=') return 'greaterThanOrEqual';
    if (operator === '<') return 'lessThan';
    return 'lessThanOrEqual';
  }

  private toApiOperator(operator: AlertRuleRecord['condition']): AlertRuleCondition['operator'] {
    if (operator === 'greaterThan') return '>';
    if (operator === 'greaterThanOrEqual') return '>=';
    if (operator === 'lessThan') return '<';
    return '<=';
  }
}
