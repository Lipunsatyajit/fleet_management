const jwt = require('jsonwebtoken');
const { WebSocketServer, WebSocket } = require('ws');

const { JWT_SECRET } = require('../config/config');
const { chaosService } = require('./chaosService');
const { metricsRuntimeService } = require('./metricsRuntimeService');

const HEARTBEAT_MS = 5000;
const SHUFFLE_INTERVAL_MS = 100;
const MAX_BUFFERED_BYTES = 1024 * 1024;

function createStreamingService(metricsService, chaos = chaosService) {
  const connections = new Map();
  let webSocketServer;
  let heartbeatTimer;
  let shuffleTimer;
  let killTimer;
  let removeMetricListener;

  function attach(server) {
    webSocketServer = new WebSocketServer({ noServer: true });

    server.on('upgrade', handleUpgrade);
    webSocketServer.on('connection', (client, options) => {
      client.on('error', () => client.terminate());
      connections.set(client, {
        transport: 'websocket',
        client,
        overrides: options.overrides,
        settings: options.settings,
        queuedEvents: [],
      });
    });

    removeMetricListener = metricsService.addListener(broadcastMetric);
    heartbeatTimer = setInterval(broadcastHeartbeat, HEARTBEAT_MS);
    shuffleTimer = setInterval(flushShuffledEvents, SHUFFLE_INTERVAL_MS);
    heartbeatTimer.unref?.();
    shuffleTimer.unref?.();

    server.once('close', close);
  }

  function handleUpgrade(request, socket, head) {
    const requestUrl = new URL(request.url, 'http://localhost');
    if (requestUrl.pathname !== '/stream') {
      socket.destroy();
      return;
    }

    const accessToken = requestUrl.searchParams.get('access_token');
    let authenticated = false;
    try {
      if (accessToken) {
        jwt.verify(accessToken, JWT_SECRET);
        authenticated = true;
      }
    } catch (_error) {
      authenticated = false;
    }

    let overrides;
    try {
      overrides = getOverrides(requestUrl.searchParams);
    } catch (_error) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const settings = resolveSettings('websocket', overrides);
    if (settings.down) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      if (!authenticated) {
        client.close(4401, 'Access token is missing or invalid');
        return;
      }
      webSocketServer.emit('connection', client, { overrides, settings });
    });
  }

  function getOverrides(query) {
    const overrides = {};
    for (const key of ['ws', 'sse', 'chaos']) {
      const value = query instanceof URLSearchParams ? query.get(key) : query?.[key];
      if (value !== null && value !== undefined) {
        overrides[key] = value;
      }
    }
    return chaos.validateOverrides(overrides);
  }

  function resolveSettings(transport, overrides = {}) {
    const globalConfig = chaos.getConfig();
    const wsMode = overrides.ws ?? globalConfig.ws;
    const sseMode = overrides.sse ?? globalConfig.sse;
    const chaosMode = overrides.chaos ?? globalConfig.chaos;
    const dropMode = overrides.ws !== undefined ? overrides.ws : globalConfig.ws;
    const dropMatch = dropMode.match(/^drop:(\d+)$/);
    const chaosModes = chaosMode === 'off' ? [] : chaosMode.split(',');
    const garbageMode = chaosModes.find((mode) => mode.startsWith('garbage:'));

    return {
      down: transport === 'websocket' ? wsMode === 'down' : sseMode === 'down',
      silent: transport === 'websocket' && wsMode === 'silent',
      dropPercent: dropMatch ? Number(dropMatch[1]) : 0,
      shuffle: chaosModes.includes('shuffle'),
      duplicate: chaosModes.includes('dupe'),
      garbagePercent: garbageMode ? Number(garbageMode.slice('garbage:'.length)) : 0,
    };
  }

  function getSseConnectionSettings(query) {
    const overrides = getOverrides(query);
    return { overrides, settings: resolveSettings('sse', overrides) };
  }

  function addSseClient(response, overrides = {}) {
    const settings = resolveSettings('sse', overrides);
    const connection = {
      transport: 'sse',
      response,
      overrides,
      settings,
      queuedEvents: [],
    };
    connections.set(response, connection);
    response.on('close', () => connections.delete(response));
    return () => connections.delete(response);
  }

  function broadcastMetric(event) {
    for (const connection of connections.values()) {
      if (connection.settings.down || connection.settings.silent) {
        continue;
      }
      if (Math.random() * 100 < connection.settings.dropPercent) {
        continue;
      }
      if (connection.settings.shuffle) {
        connection.queuedEvents.push(event);
      } else {
        deliverMetric(connection, event);
      }
    }
  }

  function deliverMetric(connection, event) {
    const data = makeDeliveredData(event, connection.settings);
    sendMetricData(connection, event.offset, data);

    if (connection.settings.duplicate && Math.random() < 0.1) {
      sendMetricData(connection, event.offset, data);
    }
  }

  function makeDeliveredData(event, settings) {
    if (settings.garbagePercent > 0 && Math.random() * 100 < settings.garbagePercent) {
      garbageEventCount += 1;
      if (garbageEventCount % 2 === 1) {
        return '{"type":"metric",';
      }
      return JSON.stringify({ type: 'metric', offset: event.offset });
    }
    return JSON.stringify(event);
  }

  function sendMetricData(connection, offset, data) {
    if (connection.transport === 'websocket') {
      const client = connection.client;
      if (client.readyState !== WebSocket.OPEN) {
        return;
      }
      if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
        client.close(1013, 'Client is behind; reconnect and replay missed events');
        return;
      }
      client.send(data);
      return;
    }

    const response = connection.response;
    if (response.destroyed) {
      connections.delete(response);
      return;
    }
    response.write(`id: ${offset}\nevent: metric\ndata: ${data}\n\n`);
    if (response.writableLength > MAX_BUFFERED_BYTES) {
      response.end();
      connections.delete(response);
    }
  }

  function flushShuffledEvents() {
    for (const connection of connections.values()) {
      const pending = connection.queuedEvents;
      if (pending.length === 0) {
        continue;
      }

      connection.queuedEvents = [];
      if (connection.settings.down || connection.settings.silent) {
        continue;
      }
      if (!connection.settings.shuffle) {
        for (const event of pending) {
          deliverMetric(connection, event);
        }
        continue;
      }

      shuffle(pending);
      for (const event of pending) {
        deliverMetric(connection, event);
      }
    }
  }

  function broadcastHeartbeat() {
    const ping = JSON.stringify({ type: 'ping', ts: Date.now() });
    for (const connection of connections.values()) {
      if (connection.settings.silent || connection.settings.down) {
        continue;
      }
      if (connection.transport === 'websocket') {
        if (connection.client.readyState === WebSocket.OPEN) {
          connection.client.send(ping);
        }
      } else if (!connection.response.destroyed) {
        connection.response.write(`event: ping\ndata: ${ping}\n\n`);
        if (connection.response.writableLength > MAX_BUFFERED_BYTES) {
          connection.response.end();
          connections.delete(connection.response);
        }
      }
    }
  }

  function applyChaosConfig(config) {
    for (const [key, connection] of connections) {
      const forcedDown = connection.transport === 'websocket'
        ? config.ws === 'down'
        : config.sse === 'down';
      if (forcedDown) {
        closeConnection(connection, 'Stream disabled by chaos settings');
        connections.delete(key);
        continue;
      }

      connection.settings = resolveSettings(connection.transport, connection.overrides);
      if (connection.settings.down || connection.settings.silent) {
        connection.queuedEvents = [];
        continue;
      }
      if (!connection.settings.shuffle && connection.queuedEvents.length > 0) {
        const pending = connection.queuedEvents;
        connection.queuedEvents = [];
        for (const event of pending) {
          deliverMetric(connection, event);
        }
      }
    }
    setKillTimer(config.kill);
  }

  function setKillTimer(seconds) {
    if (killTimer) {
      clearInterval(killTimer);
      killTimer = undefined;
    }
    if (seconds > 0) {
      killTimer = setInterval(() => closeAll('Connection closed by chaos kill switch'), seconds * 1000);
      killTimer.unref?.();
    }
  }

  function closeConnection(connection, reason) {
    if (connection.transport === 'websocket') {
      if (connection.client.readyState === WebSocket.OPEN) {
        connection.client.close(4000, reason);
      }
    } else if (!connection.response.destroyed) {
      connection.response.end();
    }
  }

  function closeAll(reason) {
    for (const [key, connection] of connections) {
      closeConnection(connection, reason);
      connections.delete(key);
    }
  }

  function close() {
    clearInterval(heartbeatTimer);
    clearInterval(shuffleTimer);
    clearInterval(killTimer);
    removeMetricListener?.();
    if (webSocketServer) {
      webSocketServer.close();
    }
    closeAll('Server stopped');
  }

  let garbageEventCount = 0;

  chaos.subscribe(applyChaosConfig);

  return {
    attach,
    close,
    addSseClient,
    getSseConnectionSettings,
    getConnectionCount: () => connections.size,
  };
}

function shuffle(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[randomIndex]] = [items[randomIndex], items[index]];
  }
}

const streamingService = createStreamingService(metricsRuntimeService);

module.exports = { createStreamingService, streamingService };
