import { of } from 'rxjs';
import { ConnectionHealthService, getReconnectDelay } from './connection-health.service';
import { FleetDataService } from './fleet-data.service';
import { MetricEvent } from '../../models/service.model';

describe('ConnectionHealthService', () => {
  let service: ConnectionHealthService;
  let internals: {
    hasOffset: boolean;
    lastOffset: number;
    accessToken: string;
    generation: number;
    acceptMetricEvent: (event: MetricEvent) => void;
    requestReplay: () => void;
    flushMetricBatch: () => void;
    handleStreamMessage: (data: string) => void;
    handleWebSocketFailure: (generation: number, keepLower: boolean) => void;
    handleSseFailure: (generation: number, keepLower: boolean) => void;
    startSse: (generation: number, keepLower?: boolean) => void;
    startWebSocket: (generation: number, keepLower?: boolean) => void;
    checkHeartbeat: () => void;
    lastHeartbeatAt: number;
  };
  let received: MetricEvent[];
  let getReplay: jasmine.Spy;
  let originalEventSource: PropertyDescriptor | undefined;
  let originalWebSocket: PropertyDescriptor | undefined;
  let clockInstalled = false;

  beforeEach(() => {
    received = [];
    getReplay = jasmine.createSpy('getReplay').and.returnValue(of({ offset: 2, events: [event(1, 1), event(2, 2)] }));
    const fleetData = {
      getSnapshot: () => of({ offset: 0, ts: Date.now(), metrics: [] }),
      applySnapshot: () => [],
      applyMetricEvents: () => undefined,
      getReplay,
    };
    service = new ConnectionHealthService(fleetData as unknown as FleetDataService);
    service.metricBatches$.subscribe((events) => received.push(...events));
    internals = service as unknown as typeof internals;
    internals.hasOffset = true;
    internals.lastOffset = 0;
    internals.accessToken = 'test-token';
    originalEventSource = Object.getOwnPropertyDescriptor(window, 'EventSource');
    originalWebSocket = Object.getOwnPropertyDescriptor(window, 'WebSocket');
  });

  afterEach(() => {
    service.ngOnDestroy();
    if (originalEventSource) Object.defineProperty(window, 'EventSource', originalEventSource);
    else Reflect.deleteProperty(window, 'EventSource');
    if (originalWebSocket) Object.defineProperty(window, 'WebSocket', originalWebSocket);
    else Reflect.deleteProperty(window, 'WebSocket');
    if (clockInstalled) jasmine.clock().uninstall();
    clockInstalled = false;
  });

  it('holds an out-of-order event until the missing offset arrives and ignores duplicates', () => {
    internals.acceptMetricEvent(event(2, 2));
    expect(internals.lastOffset).toBe(0);

    internals.acceptMetricEvent(event(1, 1));
    internals.acceptMetricEvent(event(1, 1));
    internals.flushMetricBatch();

    expect(internals.lastOffset).toBe(2);
    expect(received.map((item) => item.offset)).toEqual([1, 2]);
    expect(service.duplicateEventCount()).toBe(1);
  });

  it('requests replay when a global offset is missing', () => {
    internals.acceptMetricEvent(event(2, 2));
    internals.requestReplay();
    internals.flushMetricBatch();

    expect(getReplay).toHaveBeenCalledWith(0);
    expect(internals.lastOffset).toBe(2);
    expect(received.map((item) => item.offset)).toEqual([1, 2]);
  });

  it('counts malformed JSON and events with missing fields', () => {
    internals.handleStreamMessage('{bad json');
    internals.handleStreamMessage(JSON.stringify({ type: 'metric', offset: 1 }));

    expect(service.malformedEventCount()).toBe(2);
  });

  it('counts a per-service sequence gap', () => {
    internals.acceptMetricEvent(event(1, 1));
    internals.acceptMetricEvent({ ...event(2, 3), offset: 2 });

    expect(service.sequenceGapCount()).toBe(1);
  });

  it('falls back to SSE after three WebSocket failures and polling after three SSE failures', () => {
    class FakeEventSource {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      addEventListener(): void {}
      close(): void {}
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: FakeEventSource });
    internals.accessToken = 'test-token';
    internals.generation = 1;

    internals.handleWebSocketFailure(1, false);
    internals.handleWebSocketFailure(1, false);
    internals.handleWebSocketFailure(1, false);
    expect(service.status().state).toBe('Reconnecting');
    expect(service.status().transport).toBe('SSE');

    internals.handleSseFailure(1, false);
    internals.handleSseFailure(1, false);
    internals.handleSseFailure(1, false);
    expect(service.status().state).toBe('Polling');
  });

  it('uses increasing jittered reconnect caps up to 30 seconds', () => {
    expect(getReconnectDelay(1, 0.5)).toBe(500);
    expect(getReconnectDelay(2, 0.5)).toBe(1000);
    expect(getReconnectDelay(20, 1)).toBe(30000);
  });

  it('times out a WebSocket connection after five seconds and retries with backoff', () => {
    jasmine.clock().install();
    clockInstalled = true;
    spyOn(Math, 'random').and.returnValue(0.5);
    class FakeWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      static instances: FakeWebSocket[] = [];
      readyState = 0;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() { FakeWebSocket.instances.push(this); }
      close(): void { this.readyState = 3; this.onclose?.(); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: FakeWebSocket });
    internals.accessToken = 'test-token';
    service.connect('test-token');

    jasmine.clock().tick(5000);
    expect(FakeWebSocket.instances.length).toBe(1);
    jasmine.clock().tick(499);
    expect(FakeWebSocket.instances.length).toBe(1);
    jasmine.clock().tick(1);
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  it('probes WebSocket again after 30 seconds when SSE is live', () => {
    jasmine.clock().install();
    clockInstalled = true;
    class FakeEventSource {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      addEventListener(): void {}
      close(): void {}
    }
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      static instances: FakeWebSocket[] = [];
      constructor() { FakeWebSocket.instances.push(this); }
      close(): void { this.readyState = 3; this.onclose?.(); }
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: FakeEventSource });
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: FakeWebSocket });
    internals.accessToken = 'test-token';
    internals.generation = 1;
    internals.startSse(1);
    const eventSource = (service as unknown as { eventSource: FakeEventSource }).eventSource;
    eventSource.onopen?.();

    jasmine.clock().tick(29_999);
    expect(FakeWebSocket.instances.length).toBe(0);
    jasmine.clock().tick(1);
    expect(FakeWebSocket.instances.length).toBe(1);
  });
});

function event(offset: number, sequence: number): MetricEvent {
  return {
    type: 'metric', offset, serviceId: 'svc-1', seq: sequence, ts: Date.now(),
    p95: 100, errRate: 0.1, rps: 10, status: 'healthy',
  };
}
