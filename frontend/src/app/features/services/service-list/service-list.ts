import { Component, DestroyRef, ElementRef, OnInit, ViewChild, signal } from '@angular/core';
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
  private static readonly rowHeight = 68;
  private static readonly overscanRows = 10;
  private static readonly maxRenderedRows = 50;

  @ViewChild('tableScroll') private tableViewport?: ElementRef<HTMLDivElement>;

  get services() { return this.fleetData.services; }
  readonly visibleServices = signal<ServiceRecord[]>([]);
  readonly windowedServices = signal<ServiceRecord[]>([]);
  readonly isLoading = signal(true);
  readonly errorMessage = signal('');
  readonly statusChangedIds = signal<ReadonlySet<string>>(new Set());
  readonly virtualStartIndex = signal(0);
  readonly virtualEndIndex = signal(0);
  readonly topSpacerHeight = signal(0);
  readonly bottomSpacerHeight = signal(0);

  searchText = '';
  selectedStatus = 'All';
  selectedSort = 'latency';
  private viewportHeight = 640;
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

  updateVisibleServices(resetScroll = true, updateUrl = true): void {
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
    if (resetScroll) {
      this.resetScrollPosition();
    } else {
      this.updateVirtualWindow(this.tableViewport?.nativeElement.scrollTop ?? 0, true);
    }

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

  onTableScroll(event: Event): void {
    const viewport = event.currentTarget as HTMLElement;
    this.viewportHeight = viewport.clientHeight;
    this.updateVirtualWindow(viewport.scrollTop);
  }

  get firstVisibleNumber(): number {
    return this.visibleServices().length === 0 ? 0 : this.virtualStartIndex() + 1;
  }

  get lastVisibleNumber(): number {
    return this.virtualEndIndex();
  }

  private resetScrollPosition(): void {
    if (this.tableViewport) this.tableViewport.nativeElement.scrollTop = 0;
    this.updateVirtualWindow(0, true);
  }

  private updateVirtualWindow(scrollTop: number, force = false): void {
    const services = this.visibleServices();
    if (services.length === 0) {
      this.virtualStartIndex.set(0);
      this.virtualEndIndex.set(0);
      this.windowedServices.set([]);
      this.topSpacerHeight.set(0);
      this.bottomSpacerHeight.set(0);
      return;
    }

    const viewportRows = Math.ceil(this.viewportHeight / ServiceList.rowHeight);
    const renderCount = Math.min(
      ServiceList.maxRenderedRows,
      viewportRows + ServiceList.overscanRows * 2,
    );
    const maximumStart = Math.max(0, services.length - renderCount);
    const start = Math.min(
      maximumStart,
      Math.max(0, Math.floor(Math.max(0, scrollTop - ServiceList.rowHeight) / ServiceList.rowHeight) - ServiceList.overscanRows),
    );
    const end = Math.min(services.length, start + renderCount);

    if (!force && start === this.virtualStartIndex() && end === this.virtualEndIndex()) return;

    this.virtualStartIndex.set(start);
    this.virtualEndIndex.set(end);
    this.windowedServices.set(services.slice(start, end));
    this.topSpacerHeight.set(start * ServiceList.rowHeight);
    this.bottomSpacerHeight.set((services.length - end) * ServiceList.rowHeight);
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
