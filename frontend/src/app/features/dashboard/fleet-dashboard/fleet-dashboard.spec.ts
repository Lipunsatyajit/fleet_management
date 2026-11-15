import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of, Subject } from 'rxjs';

import { FleetDataService } from '../../../core/services/fleet-data.service';
import { ConnectionHealthService } from '../../../core/services/connection-health.service';
import { MetricEvent, ServiceRecord } from '../../../models/service.model';
import { FleetDashboard } from './fleet-dashboard';

describe('FleetDashboard', () => {
  it('shows a summary calculated from backend services', async () => {
    const services: ServiceRecord[] = [
      { id: 'SVC-1', name: 'payment-api', team: 'Payments', region: 'India', status: 'Healthy', latency: 100, errorRate: 0.1, requestsPerSecond: 10, lastUpdated: '' },
      { id: 'SVC-2', name: 'search-api', team: 'Search', region: 'India', status: 'Warning', latency: 300, errorRate: 2, requestsPerSecond: 30, lastUpdated: '' },
      { id: 'SVC-3', name: 'billing-worker', team: 'Billing', region: 'Singapore', status: 'Critical', latency: 900, errorRate: 7, requestsPerSecond: 20, lastUpdated: '' },
    ];
    const fleetData = {
      services: signal(services),
      getServices: () => of(services), getChaos: () => of({ rate: 500 }),
      updateChaos: () => of({ rate: 500 }),
    };
    const connection = { metricBatches$: new Subject<MetricEvent[]>() };
    await TestBed.configureTestingModule({
      imports: [FleetDashboard],
      providers: [
        { provide: FleetDataService, useValue: fleetData },
        { provide: ConnectionHealthService, useValue: connection },
        provideRouter([]),
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(FleetDashboard);
    fixture.detectChanges();
    const dashboard = fixture.componentInstance;
    dashboard.calculateSummary();

    expect(dashboard.averageLatency()).toBe(433);
    expect(dashboard.totalRequestsPerSecond()).toBe(60);
    expect(dashboard.getCount('Healthy')).toBe(1);
    expect(dashboard.getCount('Warning')).toBe(1);
    expect(dashboard.getCount('Critical')).toBe(1);
    fixture.destroy();
  });
});
