const MAX_EVENTS_PER_SECOND = 5000;
const REPLAY_WINDOW_SECONDS = 5 * 60;
const REPLAY_BUFFER_SIZE = MAX_EVENTS_PER_SECOND * REPLAY_WINDOW_SECONDS;

function createMetricsRuntimeService(bufferSize = REPLAY_BUFFER_SIZE) {
  const replayBuffer = new Array(bufferSize);
  const serviceIds = [];
  const latestMetrics = new Map();
  const serviceSequences = new Map();
  const historyBySecond = new Map();
  const listeners = new Set();

  let bufferStart = 0;
  let bufferCount = 0;
  let currentOffset = 0;
  let eventRate = 500;
  let generationTimer;

  function initialize(services, initialMetrics, configuredEventRate = 500) {
    if (generationTimer) {
      return;
    }

    const serviceStatus = new Map();
    for (const service of services) {
      serviceIds.push(service.id);
      serviceStatus.set(service.id, service.status || 'healthy');
      serviceSequences.set(service.id, 0);
    }

    for (const metric of initialMetrics) {
      const timestamp = typeof metric.ts === 'number' ? metric.ts : Date.parse(metric.ts);
      latestMetrics.set(metric.serviceId, {
        serviceId: metric.serviceId,
        ts: Number.isFinite(timestamp) ? timestamp : Date.now(),
        p95: metric.p95,
        errRate: metric.errRate,
        rps: metric.rps,
        status: serviceStatus.get(metric.serviceId) || 'healthy',
        seq: 0,
      });
    }

    for (const serviceId of serviceIds) {
      if (!latestMetrics.has(serviceId)) {
        latestMetrics.set(serviceId, {
          serviceId,
          ts: Date.now(),
          p95: 100,
          errRate: 0,
          rps: 50,
          status: serviceStatus.get(serviceId) || 'healthy',
          seq: 0,
        });
      }
    }

    setEventRate(configuredEventRate);
    generateBatch();
    generationTimer = setInterval(generateBatch, 1000);
    generationTimer.unref?.();
  }

  function setEventRate(rate) {
    if (Number.isInteger(rate) && rate >= 1 && rate <= MAX_EVENTS_PER_SECOND) {
      eventRate = rate;
    }
  }

  function generateBatch() {
    if (serviceIds.length === 0) {
      return;
    }

    const timestamp = Date.now();
    const secondTimestamp = Math.floor(timestamp / 1000) * 1000;

    for (let index = 0; index < eventRate; index += 1) {
      const serviceId = serviceIds[Math.floor(Math.random() * serviceIds.length)];
      const previous = latestMetrics.get(serviceId);
      const nextSequence = serviceSequences.get(serviceId) + 1;
      const p95 = Math.max(1, Math.round(previous.p95 + randomBetween(-12, 12)));
      const errRate = Number(Math.max(0, Math.min(100, previous.errRate + randomBetween(-0.2, 0.2))).toFixed(2));
      const rps = Math.max(0, Math.round(previous.rps + randomBetween(-20, 20)));
      const event = {
        type: 'metric',
        offset: currentOffset + 1,
        serviceId,
        seq: nextSequence,
        ts: timestamp,
        p95,
        errRate,
        rps,
        status: getStatus(p95, errRate),
      };

      currentOffset += 1;
      serviceSequences.set(serviceId, nextSequence);
      latestMetrics.set(serviceId, event);
      saveEvent(event, secondTimestamp);

      // Keep event generation independent from each transport implementation.
      for (const listener of listeners) {
        listener(event);
      }
    }

    removeOldHistory(secondTimestamp - REPLAY_WINDOW_SECONDS * 1000);
  }

  function saveEvent(event, secondTimestamp) {
    if (bufferCount < bufferSize) {
      const nextIndex = (bufferStart + bufferCount) % bufferSize;
      replayBuffer[nextIndex] = event;
      bufferCount += 1;
    } else {
      replayBuffer[bufferStart] = event;
      bufferStart = (bufferStart + 1) % bufferSize;
    }

    let secondHistory = historyBySecond.get(secondTimestamp);
    if (!secondHistory) {
      secondHistory = new Map();
      historyBySecond.set(secondTimestamp, secondHistory);
    }
    secondHistory.set(event.serviceId, event);
  }

  function removeOldHistory(oldestAllowedTimestamp) {
    for (const timestamp of historyBySecond.keys()) {
      if (timestamp >= oldestAllowedTimestamp) {
        break;
      }
      historyBySecond.delete(timestamp);
    }
  }

  function getSnapshot() {
    return {
      offset: currentOffset,
      ts: Date.now(),
      metrics: Array.from(latestMetrics.values()),
    };
  }

  function getHistory(serviceId, minutes) {
    const pointCount = minutes * 60;
    const newestTimestamp = Math.floor(Date.now() / 1000) * 1000;
    const firstTimestamp = newestTimestamp - (pointCount - 1) * 1000;
    const seed = latestMetrics.get(serviceId);
    const points = [];

    for (let index = 0; index < pointCount; index += 1) {
      const timestamp = firstTimestamp + index * 1000;
      const recordedPoint = historyBySecond.get(timestamp)?.get(serviceId);
      points.push(recordedPoint
        ? {
          serviceId,
          ts: timestamp,
          p95: recordedPoint.p95,
          errRate: recordedPoint.errRate,
          rps: recordedPoint.rps,
        }
        : makeHistoricalPoint(seed, timestamp));
    }

    return points;
  }

  function getReplay(since) {
    const oldestEvent = bufferCount > 0 ? replayBuffer[bufferStart] : undefined;
    const oldestOffset = oldestEvent ? oldestEvent.offset : currentOffset + 1;

    if (since < oldestOffset - 1) {
      return { tooOld: true, oldestOffset, events: [] };
    }

    const events = [];
    const firstIndex = Math.max(0, Math.min(bufferCount, since - oldestOffset + 1));
    for (let index = firstIndex; index < bufferCount; index += 1) {
      const eventIndex = (bufferStart + index) % bufferSize;
      const event = replayBuffer[eventIndex];
      if (event.offset > since) {
        events.push(event);
      }
    }

    return { tooOld: false, oldestOffset, events };
  }

  function addListener(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getServiceIds() {
    return serviceIds;
  }

  function stop() {
    if (generationTimer) {
      clearInterval(generationTimer);
      generationTimer = undefined;
    }
    listeners.clear();
  }

  return { initialize, setEventRate, getSnapshot, getHistory, getReplay, getServiceIds, addListener, stop };
}

function getStatus(p95, errRate) {
  if (p95 >= 800 || errRate >= 5) {
    return 'down';
  }
  if (p95 >= 500 || errRate >= 2) {
    return 'degraded';
  }
  return 'healthy';
}

function makeHistoricalPoint(seed, timestamp) {
  const seconds = Math.floor(timestamp / 1000);
  const phase = seconds / 17 + seed.serviceId.length;
  return {
    serviceId: seed.serviceId,
    ts: timestamp,
    p95: Math.max(1, Math.round(seed.p95 + 12 * Math.sin(phase))),
    errRate: Number(Math.max(0, seed.errRate + 0.2 * Math.sin(phase / 3)).toFixed(2)),
    rps: Math.max(0, Math.round(seed.rps + 20 * Math.sin(phase / 2))),
  };
}

function randomBetween(minimum, maximum) {
  return Math.random() * (maximum - minimum) + minimum;
}

const metricsRuntimeService = createMetricsRuntimeService();

module.exports = { createMetricsRuntimeService, metricsRuntimeService };
