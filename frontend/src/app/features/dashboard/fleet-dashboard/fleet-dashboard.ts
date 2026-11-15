import { Component, DestroyRef, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { BaseChartDirective, provideCharts, withDefaultRegisterables } from 'ng2-charts';
import { ChartConfiguration } from 'chart.js';
import { AppPreferencesService } from '../../../core/services/app-preferences.service';
import { FleetDataService } from '../../../core/services/fleet-data.service';
import { ConnectionHealthService } from '../../../core/services/connection-health.service';
import { MetricEvent } from '../../../models/service.model';

@Component({
  selector: 'app-fleet-dashboard',
  imports: [
    FormsModule,
    RouterLink,
    BaseChartDirective,
  ],
  providers: [provideCharts(withDefaultRegisterables())],
  templateUrl: './fleet-dashboard.html',
  styleUrl: './fleet-dashboard.css',
})
export class FleetDashboard implements OnInit {
  get services() { return this.fleetData.services; }
  readonly isLoading = signal(true);
  readonly errorMessage = signal('');
  readonly chartErrors = signal({ health: '', latency: '' });
  readonly averageLatency = signal(0);
  readonly totalRequestsPerSecond = signal(0);
  readonly simulationRate = signal(500);
  trendRefreshSeconds = 3;
  healthChart: ChartConfiguration<'doughnut'> = this.createHealthChart();
  latencyTrendChart: ChartConfiguration<'line'> = this.createLatencyTrendChart();
  private readonly statusCounts = signal<Record<string, number>>({
    Healthy: 0,
    Warning: 0,
    Critical: 0,
    Offline: 0,
  });
  private lastTrendUpdate = 0;
  private trendEventLatencyTotal = 0;
  private trendEventCount = 0;

  constructor(
    private readonly fleetData: FleetDataService,
    private readonly connection: ConnectionHealthService,
    private readonly preferences: AppPreferencesService,
    private readonly destroyRef: DestroyRef,
  ) {}

  ngOnInit(): void {
    this.preferences.preferences$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((settings) => {
        this.simulationRate.set(settings.simulationRate);
        this.trendRefreshSeconds = settings.metricRefreshSeconds;
      });

    this.connection.metricBatches$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((events) => this.applyMetricEvents(events));

    this.fleetData.getChaos()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((settings) => {
        const rate = Number(settings['rate']);
        if (Number.isInteger(rate)) this.simulationRate.set(rate);
      });

    this.fleetData.getServices().subscribe({
      next: () => {
        this.calculateSummary();
        this.setLatencyTrendBaseline();
        this.isLoading.set(false);
      },
      error: () => {
        this.errorMessage.set('Could not load service data from the backend.');
        this.isLoading.set(false);
      },
    });
  }

  calculateSummary(): void {
    let latencyTotal = 0;
    let requestTotal = 0;
    const counts = { Healthy: 0, Warning: 0, Critical: 0, Offline: 0 };

    for (const service of this.services()) {
      counts[service.status] += 1;
      latencyTotal += service.latency;
      requestTotal += service.requestsPerSecond;
    }
    this.statusCounts.set(counts);

    if (this.services().length > 0) {
      this.averageLatency.set(Math.round(latencyTotal / this.services().length));
    }
    this.totalRequestsPerSecond.set(requestTotal);
    this.updateHealthChart();
  }

  changeSimulationRate(rate: number): void {
    if (rate !== 500 && rate !== 2000) {
      return;
    }
    this.fleetData.updateChaos({ rate }).subscribe({
      next: () => {
        this.simulationRate.set(rate);
        this.preferences.update({ ...this.preferences.current, simulationRate: rate });
      },
      error: () => this.errorMessage.set('Could not change the backend event rate.'),
    });
  }

  retryChart(name: 'health' | 'latency'): void {
    this.chartErrors.update((errors) => ({ ...errors, [name]: '' }));
    if (name === 'health') this.updateHealthChart();
    else this.setLatencyTrendBaseline();
  }

  private applyMetricEvents(events: MetricEvent[]): void {
    for (const event of events) {
      this.trendEventLatencyTotal += event.p95;
      this.trendEventCount += 1;
    }

    this.calculateSummary();

    const now = Date.now();
    if (this.trendEventCount > 0 && now - this.lastTrendUpdate >= this.trendRefreshSeconds * 1000) {
      const eventAverage = this.trendEventLatencyTotal / this.trendEventCount;
      this.addLatencyTrendPoint(eventAverage);
      this.trendEventLatencyTotal = 0;
      this.trendEventCount = 0;
      this.lastTrendUpdate = now;
    }

  }

  private createHealthChart(): ChartConfiguration<'doughnut'> {
    return {
      type: 'doughnut',
      data: {
        labels: ['Healthy', 'Warning', 'Critical', 'Offline'],
        datasets: [{
          data: [0, 0, 0, 0],
          backgroundColor: ['#16a34a', '#f59e0b', '#ef4444', '#64748b'],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // Metric events update this chart often. Disable animation so updates stay smooth.
        animation: false,
        cutout: '68%',
        plugins: { legend: { display: false } },
      },
    };
  }

  private createLatencyTrendChart(): ChartConfiguration<'line'> {
    return {
      type: 'line',
      data: {
        labels: [new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })],
        datasets: [{
          label: 'Average p95 latency (ms)',
          data: [0],
          borderColor: '#766bff',
          backgroundColor: '#766bff22',
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 4,
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
          x: { ticks: { maxTicksLimit: 6, color: '#8290ad' }, grid: { color: '#202a40' } },
          y: { beginAtZero: false, ticks: { color: '#8290ad' }, grid: { color: '#202a40' } },
        },
      },
    };
  }

  private updateHealthChart(): void {
    try {
      const values = [this.getCount('Healthy'), this.getCount('Warning'), this.getCount('Critical'), this.getCount('Offline')];
      if (values.some((value) => !Number.isFinite(value))) throw new Error('Invalid chart value');
      this.healthChart = {
        ...this.healthChart,
        data: {
          ...this.healthChart.data,
          datasets: [{ ...this.healthChart.data.datasets[0], data: values }],
        },
      };
    } catch (_error) {
      this.chartErrors.update((errors) => ({ ...errors, health: 'Fleet health chart could not be displayed.' }));
    }
  }

  private addLatencyTrendPoint(latency: number): void {
    if (!Number.isFinite(latency)) {
      this.chartErrors.update((errors) => ({ ...errors, latency: 'Latency chart received an invalid value.' }));
      return;
    }
    const labels = [...(this.latencyTrendChart.data.labels ?? []) as string[]];
    const values = [...this.latencyTrendChart.data.datasets[0].data as number[]];
    labels.push(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    values.push(Number(latency.toFixed(1)));

    this.latencyTrendChart = {
      ...this.latencyTrendChart,
      data: {
        ...this.latencyTrendChart.data,
        labels: labels.slice(-300),
        datasets: [{ ...this.latencyTrendChart.data.datasets[0], data: values.slice(-300) }],
      },
    };
  }

  private setLatencyTrendBaseline(): void {
    const label = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    this.latencyTrendChart = {
      ...this.latencyTrendChart,
      data: {
        ...this.latencyTrendChart.data,
        labels: [label],
        datasets: [{ ...this.latencyTrendChart.data.datasets[0], data: [this.averageLatency()] }],
      },
    };
    this.lastTrendUpdate = Date.now();
  }

  getCount(status: string): number {
    return this.statusCounts()[status] ?? 0;
  }

}
