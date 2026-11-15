import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { FormControl, FormGroup } from '@angular/forms';

import { FleetDataService } from '../../../../core/services/fleet-data.service';
import { ConnectionHealthService } from '../../../../core/services/connection-health.service';
import { AppPreferencesService } from '../../../../core/services/app-preferences.service';
import { AlertRuleService } from './alert-rule.service';
import { MetricEvent } from '../../../../models/service.model';
import { conditionFieldsMatch, nonBlankName, uniqueRuleName, validThreshold } from '../alert-rules';

describe('AlertRuleService', () => {
  it('keeps live events received during startup rule loading and evaluates them afterward', () => {
    const events = new Subject<MetricEvent[]>();
    const rulesResponse = new Subject<{
      id: string; name: string; severity: string; enabled: boolean;
      conditions: { metric: 'p95'; operator: '>'; threshold: number; durationSec: number }[];
      createdAt: string; updatedAt: string;
    }[]>();
    const fleetData = { getRules: () => rulesResponse.asObservable() };
    TestBed.configureTestingModule({
      providers: [
        AlertRuleService,
        { provide: FleetDataService, useValue: fleetData },
        { provide: ConnectionHealthService, useValue: { metricBatches$: events.asObservable() } },
        { provide: AppPreferencesService, useValue: { current: { notificationsEnabled: false } } },
      ],
    });

    const alertRules = TestBed.inject(AlertRuleService);
    alertRules.setServiceNames([{ id: 'svc-1', name: 'payment-api', team: 'Payments', region: 'India', status: 'Healthy', latency: 10, errorRate: 0, requestsPerSecond: 1, lastUpdated: '' }]);
    alertRules.load().subscribe();

    const start = Date.parse('2026-11-13T10:00:00.000Z');
    events.next([makeEvent(1, start)]);
    events.next([makeEvent(2, start + 2000)]);
    expect(alertRules.incidents().length).toBe(0);

    rulesResponse.next([{
      id: 'rule-0001', name: 'High latency', severity: 'critical', enabled: true,
      conditions: [{ metric: 'p95', operator: '>', threshold: 500, durationSec: 1 }],
      createdAt: '', updatedAt: '',
    }]);

    expect(alertRules.incidents().length).toBe(1);
    expect(alertRules.incidents()[0].serviceName).toBe('payment-api');
  });

  it('loads backend rules and raises an incident from live metrics', () => {
    const events = new Subject<MetricEvent[]>();
    const fleetData = {
      getRules: () => of([{
        id: 'rule-0001', name: 'High latency', severity: 'critical', enabled: true,
        conditions: [
          { metric: 'p95', operator: '>', threshold: 500, durationSec: 1 },
          { metric: 'errRate', operator: '>', threshold: 2, durationSec: 1 },
        ],
        createdAt: '', updatedAt: '',
      }]),
    };
    TestBed.configureTestingModule({
      providers: [
        AlertRuleService,
        { provide: FleetDataService, useValue: fleetData },
        { provide: ConnectionHealthService, useValue: { metricBatches$: events.asObservable() } },
        { provide: AppPreferencesService, useValue: { current: { notificationsEnabled: false } } },
      ],
    });
    const alertRules = TestBed.inject(AlertRuleService);
    alertRules.setServiceNames([{ id: 'svc-1', name: 'payment-api', team: 'Payments', region: 'India', status: 'Healthy', latency: 10, errorRate: 0, requestsPerSecond: 1, lastUpdated: '' }]);
    alertRules.load().subscribe();

    const start = Date.parse('2026-11-13T10:00:00.000Z');
    events.next([makeEvent(1, start)]);
    events.next([makeEvent(2, start + 2000)]);
    expect(alertRules.incidents().length).toBe(0);
    events.next([makeEvent(3, start + 4000)]);

    expect(alertRules.incidents().length).toBe(1);
    expect(alertRules.incidents()[0].serviceName).toBe('payment-api');
    expect(alertRules.incidents()[0].status).toBe('open');
  });
});

function makeEvent(sequence: number, ts: number): MetricEvent {
  return {
    type: 'metric', offset: sequence, serviceId: 'svc-1', seq: sequence, ts,
    p95: 700, errRate: sequence === 1 ? 0.5 : 3, rps: 30, status: 'healthy',
  };
}

describe('alert rule validators', () => {
  it('rejects blank names and invalid thresholds', () => {
    expect(nonBlankName(new FormControl('   '))).toEqual({ blank: true });
    expect(validThreshold(new FormControl(-1))).toEqual({ invalidThreshold: true });
  });

  it('rejects an error-rate condition above 100 percent', () => {
    const condition = new FormGroup({
      metric: new FormControl('errorRate'),
      threshold: new FormControl(101),
    });
    expect(conditionFieldsMatch(condition)).toEqual({ errorRateTooHigh: true });
  });

  it('checks rule-name uniqueness asynchronously and marks duplicates invalid', fakeAsync(() => {
    const fleetData = { checkRuleName: jasmine.createSpy().and.returnValue(of({ available: false })) };
    const nameControl = new FormControl('Repeated name');
    nameControl.setAsyncValidators(uniqueRuleName(fleetData as unknown as FleetDataService, () => null));
    nameControl.updateValueAndValidity();

    expect(nameControl.pending).toBeTrue();
    tick(300);

    expect(fleetData.checkRuleName).toHaveBeenCalledWith('Repeated name', '');
    expect(nameControl.hasError('nameTaken')).toBeTrue();
  }));
});
