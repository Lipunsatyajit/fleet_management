import { Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { FleetDataService } from '../../../../core/services/fleet-data.service';
import { MetricHistoryPoint } from '../../../../models/service.model';

export interface ServiceMetricPoint {
  timestamp: Date;
  latencyP95: number;
  errorRate: number;
  requestsPerSecond: number;
}

@Injectable({ providedIn: 'root' })
export class ServiceMetricsService {
  private readonly maxPoints = 300;

  constructor(private readonly fleetData: FleetDataService) {}

  getServiceMetrics(serviceId: string): Observable<ServiceMetricPoint[]> {
    return this.fleetData.getMetricHistory(serviceId, 15).pipe(
      map((records) => this.toServicePoints(records)),
    );
  }

  private toServicePoints(records: MetricHistoryPoint[]): ServiceMetricPoint[] {
    const reducedRecords = this.reducePoints(records);
    return reducedRecords
      .map((record) => ({
        timestamp: new Date(record.ts),
        latencyP95: record.p95,
        errorRate: record.errRate,
        requestsPerSecond: record.rps,
      }));
  }

  private reducePoints(records: MetricHistoryPoint[]): MetricHistoryPoint[] {
    if (records.length <= this.maxPoints) return records;

    // Pick evenly spaced points, keeping both the oldest and newest values.
    const step = (records.length - 1) / (this.maxPoints - 1);
    return Array.from({ length: this.maxPoints }, (_value, index) =>
      records[Math.round(index * step)],
    );
  }
}
