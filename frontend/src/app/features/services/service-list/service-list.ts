import { Component, DestroyRef, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { ConnectionHealthService } from '../../../core/services/connection-health.service';
import { FleetDataService } from '../../../core/services/fleet-data.service';
import { MetricEvent, ServiceRecord, ServiceStatus } from '../../../models/service.model';
import { auditTime } from 'rxjs';

@Component({
  selector: 'app-service-list',
  imports: [FormsModule, RouterLink],
  templateUrl: './service-list.html',
  styleUrl: './service-list.css',
})
export class ServiceList implements OnInit {
  get services() { return this.fleetData.services; }
  readonly visibleServices = signal<ServiceRecord[]>([]);
  readonly pageServices = signal<ServiceRecord[]>([]);
  readonly isLoading = signal(true);
  readonly errorMessage = signal('');
  readonly statusChangedIds = signal<ReadonlySet<string>>(new Set());

  searchText = '';
  selectedStatus = 'All';
  selectedSort = 'latency';
  currentPage = 1;
  pageSize = 25;
  private readonly previousStatuses = new Map<string, ServiceStatus>();
  private readonly statusFlashTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly fleetData: FleetDataService,
    private readonly connection: ConnectionHealthService,
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly destroyRef: DestroyRef,
  ) {
    this.destroyRef.onDestroy(() => {
      for (const timer of this.statusFlashTimers.values()) clearTimeout(timer);
      this.statusFlashTimers.clear();
    });
  }

  ngOnInit(): void {
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        this.searchText = params.get('search') || '';
        this.selectedStatus = params.get('status') || 'All';
        this.selectedSort = params.get('sort') || 'latency';
        this.updateVisibleServices(false, false);
      });

    this.connection.metricBatches$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((events) => this.trackStatusChanges(events));

    this.connection.metricBatches$
      .pipe(auditTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.updateVisibleServices(false, false));

    this.fleetData.getServices().subscribe({
      next: () => {
        for (const service of this.services()) {
          this.previousStatuses.set(service.id, service.status);
        }
        this.updateVisibleServices(false, false);
        this.isLoading.set(false);
      },
      error: () => {
        this.errorMessage.set('Could not load services from the backend.');
        this.isLoading.set(false);
      },
    });
  }

  updateVisibleServices(resetPage = true, updateUrl = true): void {
    const search = this.searchText.trim().toLowerCase();
    const filtered = this.services().filter((service) => {
      const matchesSearch = service.name.toLowerCase().includes(search)
        || service.id.toLowerCase().includes(search)
        || service.team.toLowerCase().includes(search)
        || service.region.toLowerCase().includes(search);
      return matchesSearch && (this.selectedStatus === 'All' || service.status === this.selectedStatus);
    });

    filtered.sort((first, second) => {
      if (this.selectedSort === 'errorRate') return second.errorRate - first.errorRate;
      if (this.selectedSort === 'requestsPerSecond') return second.requestsPerSecond - first.requestsPerSecond;
      return second.latency - first.latency;
    });

    this.visibleServices.set(filtered);
    if (resetPage) this.currentPage = 1;
    this.updatePageServices();

    if (updateUrl) {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: {
          search: this.searchText || null,
          status: this.selectedStatus === 'All' ? null : this.selectedStatus,
          sort: this.selectedSort === 'latency' ? null : this.selectedSort,
        },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    }
  }

  changePageSize(): void {
    this.currentPage = 1;
    this.updatePageServices();
  }

  goToPreviousPage(): void {
    if (this.currentPage > 1) {
      this.currentPage -= 1;
      this.updatePageServices();
    }
  }

  goToNextPage(): void {
    if (this.currentPage < this.totalPages) {
      this.currentPage += 1;
      this.updatePageServices();
    }
  }

  get totalPages(): number {
    return Math.ceil(this.visibleServices().length / this.pageSize);
  }

  get firstVisibleNumber(): number {
    return this.visibleServices().length === 0 ? 0 : (this.currentPage - 1) * this.pageSize + 1;
  }

  get lastVisibleNumber(): number {
    return Math.min(this.currentPage * this.pageSize, this.visibleServices().length);
  }

  private updatePageServices(): void {
    const start = (this.currentPage - 1) * this.pageSize;
    this.pageServices.set(this.visibleServices().slice(start, start + this.pageSize));
  }

  private trackStatusChanges(events: MetricEvent[]): void {
    for (const event of events) {
      const status = this.toServiceStatus(event.status);
      const previousStatus = this.previousStatuses.get(event.serviceId);
      this.previousStatuses.set(event.serviceId, status);
      if (previousStatus === undefined || previousStatus === status) continue;

      const changedIds = new Set(this.statusChangedIds());
      changedIds.add(event.serviceId);
      this.statusChangedIds.set(changedIds);

      const oldTimer = this.statusFlashTimers.get(event.serviceId);
      if (oldTimer) clearTimeout(oldTimer);
      const timer = setTimeout(() => {
        const currentIds = new Set(this.statusChangedIds());
        currentIds.delete(event.serviceId);
        this.statusChangedIds.set(currentIds);
        this.statusFlashTimers.delete(event.serviceId);
      }, 900);
      this.statusFlashTimers.set(event.serviceId, timer);
    }
  }

  private toServiceStatus(status: string): ServiceStatus {
    if (status === 'healthy') return 'Healthy';
    if (status === 'degraded') return 'Warning';
    if (status === 'down') return 'Critical';
    return 'Offline';
  }
}
