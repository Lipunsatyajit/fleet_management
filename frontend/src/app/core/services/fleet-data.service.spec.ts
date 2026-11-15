import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { FleetDataService } from './fleet-data.service';
import { environment } from '../../../environments/environment';

describe('FleetDataService', () => {
  let service: FleetDataService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(FleetDataService);
    httpMock = TestBed.inject(HttpTestingController);
  });
  afterEach(() => httpMock.verify());

  it('loads backend services and maps their current metrics', () => {
    let received: ReturnType<typeof service.services> = [];
    service.getServices().subscribe((services) => received = services);

    const servicesRequest = httpMock.expectOne(`${environment.apiBaseUrl}/services`);
    const snapshotRequest = httpMock.expectOne(`${environment.apiBaseUrl}/metrics/snapshot`);
    servicesRequest.flush([{ id: 'svc-0001', name: 'payment-api', team: 'Payments', status: 'degraded' }]);
    snapshotRequest.flush({ offset: 9, ts: 1000, metrics: [{ serviceId: 'svc-0001', ts: 1000, p95: 120, errRate: 0.2, rps: 200, status: 'degraded' }] });

    expect(received.length).toBe(1);
    expect(received[0].status).toBe('Warning');
    expect(received[0].latency).toBe(120);
    expect(service.services()[0].requestsPerSecond).toBe(200);
  });
});
