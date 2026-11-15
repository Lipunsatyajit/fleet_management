import { TestBed } from '@angular/core/testing';

import { MetricSimulationService } from './metric-simulation.service';
import { ServiceRecord, SimulatedMetricEvent } from '../../models/service.model';

describe('MetricSimulationService', () => {
  let service: MetricSimulationService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [MetricSimulationService] });
    service = TestBed.inject(MetricSimulationService);
    service.start([{
      id: 'SVC-1', name: 'payment-api', team: 'Payments', region: 'India', status: 'Healthy',
      latency: 100, errorRate: 0.2, requestsPerSecond: 20, lastUpdated: '',
    } as ServiceRecord]);
  });

  afterEach(() => service.stop());

  it('ignores duplicate and outdated event sequences and counts missing ones', () => {
    service.acceptEvent(makeEvent(1));
    service.acceptEvent(makeEvent(1));
    service.acceptEvent(makeEvent(3));
    service.acceptEvent(makeEvent(2));

    expect(service.duplicateEventCount).toBe(1);
    expect(service.outdatedEventCount).toBe(1);
    expect(service.missingSequenceCount).toBe(1);
  });

  it('rejects malformed events before they reach the event batch', () => {
    service.acceptEvent({ sequence: 1, serviceId: 'UNKNOWN', timestamp: 'bad date' });

    expect(service.malformedEventCount).toBe(1);
  });
});

function makeEvent(sequence: number): SimulatedMetricEvent {
  return {
    sequence,
    serviceId: 'SVC-1',
    timestamp: '2026-11-13T10:00:00.000Z',
    latencyP95: 120,
    errorRate: 0.3,
    requestsPerSecond: 25,
  };
}
