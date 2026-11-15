import { Component, DestroyRef, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, ParamMap, RouterLink } from '@angular/router';
import { BaseChartDirective, provideCharts, withDefaultRegisterables } from 'ng2-charts';
import { ChartConfiguration } from 'chart.js';
import { catchError, distinctUntilChanged, forkJoin, map, of, switchMap, tap } from 'rxjs';

import { ConnectionHealthService } from '../../../core/services/connection-health.service';
import { FleetDataService } from '../../../core/services/fleet-data.service';
import { ServiceRecord } from '../../../models/service.model';
import { ServiceMetricPoint, ServiceMetricsService } from './services/service-metrics';

interface LoadedDetails {
  services: ServiceRecord[];
  points: ServiceMetricPoint[];
  serviceId: string;
}

@Component({
  selector: 'app-service-details',
  imports: [BaseChartDirective, RouterLink],
  providers: [provideCharts(withDefaultRegisterables())],
  templateUrl: './service-details.html',
  styleUrl: './service-details.css',
})
export class ServiceDetails implements OnInit {
  readonly service = signal<ServiceRecord | null>(null);
  readonly metricPoints = signal<ServiceMetricPoint[]>([]);
  readonly isLoading = signal(true);
  readonly errorMessage = signal('');
  readonly chartErrors = signal({ latency: '', errorRate: '', requests: '' });

  latencyChart: ChartConfiguration<'line'> = this.createChart('p95 latency', '#3b82f6');
  errorRateChart: ChartConfiguration<'line'> = this.createChart('Error rate', '#ef4444');
  requestsChart: ChartConfiguration<'line'> = this.createChart('Requests per second', '#8b5cf6');

  constructor(
    private readonly route: ActivatedRoute,
    private readonly fleetData: FleetDataService,
    private readonly metrics: ServiceMetricsService,
    private readonly connection: ConnectionHealthService,
    private readonly destroyRef: DestroyRef,
  ) {}

  ngOnInit(): void {
    this.connection.metricBatches$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((events) => this.applyMetricEvents(events));

    this.route.paramMap.pipe(
      map((params: ParamMap) => params.get('id')),
      distinctUntilChanged(),
      tap(() => this.clearSelectedService()),
      switchMap((serviceId) => {
        if (!serviceId) return of(null);
        return forkJoin({
          services: this.fleetData.getServices(),
          points: this.metrics.getServiceMetrics(serviceId),
        }).pipe(
          map((result): LoadedDetails => ({ ...result, serviceId })),
          catchError(() => of(null)),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((result) => {
      this.isLoading.set(false);
      if (!result) {
        this.errorMessage.set('Could not load this service or its metric history.');
        return;
      }

      const selectedService = result.services.find((service) => service.id === result.serviceId);
      if (!selectedService) {
        this.errorMessage.set(`Service ${result.serviceId} was not found.`);
        return;
      }

      this.service.set(selectedService);
      this.metricPoints.set(result.points.slice(-300));
      this.updateCharts();
    });
  }

  private clearSelectedService(): void {
    this.isLoading.set(true);
    this.errorMessage.set('');
    this.chartErrors.set({ latency: '', errorRate: '', requests: '' });
    this.service.set(null);
    this.metricPoints.set([]);
    this.latencyChart = this.withChartData(this.latencyChart, [], []);
    this.errorRateChart = this.withChartData(this.errorRateChart, [], []);
    this.requestsChart = this.withChartData(this.requestsChart, [], []);
  }

  private createChart(label: string, color: string): ChartConfiguration<'line'> {
    return {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label,
          data: [],
          borderColor: color,
          backgroundColor: `${color}22`,
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.25,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { maxTicksLimit: 6 } },
          y: { beginAtZero: true },
        },
      },
    };
  }

  private updateCharts(): void {
    const points = this.metricPoints();
    const labels = points.map((point) =>
      point.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
    this.updateOneChart('latency', this.latencyChart, labels, points.map((point) => point.latencyP95));
    this.updateOneChart('errorRate', this.errorRateChart, labels, points.map((point) => point.errorRate));
    this.updateOneChart('requests', this.requestsChart, labels, points.map((point) => point.requestsPerSecond));
  }

  retryChart(name: 'latency' | 'errorRate' | 'requests'): void {
    this.chartErrors.update((errors) => ({ ...errors, [name]: '' }));
    this.updateCharts();
  }

  private updateOneChart(
    name: 'latency' | 'errorRate' | 'requests',
    chart: ChartConfiguration<'line'>,
    labels: string[],
    values: number[],
  ): void {
    try {
      if (values.some((value) => !Number.isFinite(value))) throw new Error('Chart data contains an invalid number.');
      const updated = this.withChartData(chart, labels, values);
      if (name === 'latency') this.latencyChart = updated;
      else if (name === 'errorRate') this.errorRateChart = updated;
      else this.requestsChart = updated;
    } catch (_error) {
      this.chartErrors.update((errors) => ({ ...errors, [name]: 'This chart could not be displayed.' }));
    }
  }

  private withChartData(
    chart: ChartConfiguration<'line'>,
    labels: string[],
    values: number[],
  ): ChartConfiguration<'line'> {
    return {
      ...chart,
      data: {
        labels,
        datasets: [{ ...chart.data.datasets[0], data: values }],
      },
    };
  }

  private applyMetricEvents(events: Array<{ serviceId: string; ts: number; p95: number; errRate: number; rps: number; status: string }>): void {
    const currentService = this.service();
    if (!currentService) return;

    const latest = events.filter((event) => event.serviceId === currentService.id).at(-1);
    if (!latest) return;

    const status = latest.status === 'healthy' ? 'Healthy'
      : latest.status === 'degraded' ? 'Warning'
        : latest.status === 'down' ? 'Critical' : 'Offline';
    this.service.set({
      ...currentService,
      status,
      latency: latest.p95,
      errorRate: latest.errRate,
      requestsPerSecond: latest.rps,
      lastUpdated: new Date(latest.ts).toISOString(),
    });
    this.metricPoints.update((points) => [
      ...points.slice(-299),
      {
        timestamp: new Date(latest.ts),
        latencyP95: latest.p95,
        errorRate: latest.errRate,
        requestsPerSecond: latest.rps,
      },
    ]);
    this.updateCharts();
  }
}
