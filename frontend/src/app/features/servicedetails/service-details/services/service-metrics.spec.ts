import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { FleetDataService } from '../../../../core/services/fleet-data.service';
import { MetricHistoryPoint } from '../../../../models/service.model';
import { ServiceMetricsService } from './service-metrics';

describe('ServiceMetricsService', () => {
  it('maps backend history points to chart points and keeps the latest 300', () => {
    const records: MetricHistoryPoint[] = [
      { serviceId: 'svc-1', ts: 1000, p95: 120, errRate: 0.2, rps: 10 },
      { serviceId: 'svc-1', ts: 2000, p95: 130, errRate: 0.3, rps: 20 },
    ];
    const fleetData = { getMetricHistory: () => of(records) };
    TestBed.configureTestingModule({
      providers: [ServiceMetricsService, { provide: FleetDataService, useValue: fleetData }],
    });
    const service = TestBed.inject(ServiceMetricsService);
    let values: number[] = [];

    service.getServiceMetrics('svc-1').subscribe((points) => values = points.map((point) => point.latencyP95));

    expect(values).toEqual([120, 130]);
  });

  it('reduces long history evenly to 300 points', () => {
    const records: MetricHistoryPoint[] = Array.from({ length: 900 }, (_value, index) => ({
      serviceId: 'svc-1', ts: index * 1000, p95: index, errRate: 1, rps: 10,
    }));
    TestBed.configureTestingModule({
      providers: [ServiceMetricsService, { provide: FleetDataService, useValue: { getMetricHistory: () => of(records) } }],
    });

    let pointCount = 0;
    let firstLatency = -1;
    let lastLatency = -1;
    TestBed.inject(ServiceMetricsService).getServiceMetrics('svc-1').subscribe((points) => {
      pointCount = points.length;
      firstLatency = points[0].latencyP95;
      lastLatency = points.at(-1)?.latencyP95 ?? -1;
    });

    expect(pointCount).toBe(300);
    expect(firstLatency).toBe(0);
    expect(lastLatency).toBe(899);
  });
});
