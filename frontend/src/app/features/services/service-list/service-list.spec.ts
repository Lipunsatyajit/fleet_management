import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of, Subject } from 'rxjs';

import { ConnectionHealthService } from '../../../core/services/connection-health.service';
import { FleetDataService } from '../../../core/services/fleet-data.service';
import { MetricEvent, ServiceRecord } from '../../../models/service.model';
import { ServiceList } from './service-list';

describe('ServiceList', () => {
  it('briefly flashes a service status cell when a live event changes its status', async () => {
    const service: ServiceRecord = {
      id: 'svc-0001', name: 'payment-api', team: 'Platform', region: 'India',
      status: 'Healthy', latency: 100, errorRate: 0.1, requestsPerSecond: 10, lastUpdated: '',
    };
    const events = new Subject<MetricEvent[]>();
    const services = signal([service]);
    const fleetData = { services, getServices: () => of([service]) };
    await TestBed.configureTestingModule({
      imports: [ServiceList],
      providers: [
        provideRouter([]),
        { provide: FleetDataService, useValue: fleetData },
        { provide: ConnectionHealthService, useValue: { metricBatches$: events.asObservable() } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(ServiceList);
    fixture.detectChanges();
    services.set([{ ...service, status: 'Critical' }]);
    fixture.componentInstance.updateVisibleServices(false, false);
    events.next([{
      type: 'metric', offset: 1, serviceId: service.id, seq: 1, ts: Date.now(),
      p95: 850, errRate: 6, rps: 10, status: 'down',
    }]);
    fixture.detectChanges();

    const statusCell = fixture.nativeElement.querySelector('.status-cell') as HTMLElement;
    expect(statusCell.classList.contains('status-changed')).toBeTrue();
    expect(statusCell.textContent).toContain('Critical');
    fixture.destroy();
  });

  it('keeps the service table under 60 rendered rows for 2,000 services', async () => {
    const services: ServiceRecord[] = Array.from({ length: 2000 }, (_value, index) => ({
      id: `svc-${String(index + 1).padStart(4, '0')}`,
      name: `service-${index + 1}`,
      team: 'Platform',
      region: 'India',
      status: 'Healthy',
      latency: index,
      errorRate: 0.1,
      requestsPerSecond: 10,
      lastUpdated: '',
    }));
    const fleetData = { services: signal(services), getServices: () => of(services) };
    const connection = { metricBatches$: new Subject<MetricEvent[]>() };

    await TestBed.configureTestingModule({
      imports: [ServiceList],
      providers: [
        provideRouter([]),
        { provide: FleetDataService, useValue: fleetData },
        { provide: ConnectionHealthService, useValue: connection },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(ServiceList);
    fixture.detectChanges();
    fixture.detectChanges();

    expect(fixture.componentInstance.visibleServices().length).toBe(2000);
    expect(fixture.nativeElement.querySelectorAll('tbody tr').length).toBe(25);

    fixture.componentInstance.pageSize = 50;
    fixture.componentInstance.changePageSize();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('tbody tr').length).toBe(50);
    fixture.destroy();
  });
});
