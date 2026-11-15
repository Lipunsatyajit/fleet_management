const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const WebSocket = require('ws');

const dataDirectory = path.join(os.tmpdir(), `fleet-pulse-test-${process.pid}-${Date.now()}`);
process.env.DATA_DIRECTORY = dataDirectory;
process.env.JWT_SECRET = 'fleet-pulse-test-secret';
process.env.ACCESS_TOKEN_TTL = '60';
process.env.FRONTEND_ORIGIN = 'http://localhost:4200';

const app = require('../src/app');
const { jsonFileService } = require('../src/services/jsonFileService');
const { createInitialData } = require('../src/utils/initialData');
const { metricsRuntimeService } = require('../src/services/metricsRuntimeService');
const { streamingService } = require('../src/services/streamingService');
const { chaosService } = require('../src/services/chaosService');

let server;
let baseUrl;
let operator;
let viewer;

test.before(async () => {
  const passwordHash = await bcrypt.hash('pulse123', 4);
  const data = createInitialData(passwordHash);
  for (const [fileName, contents] of Object.entries(data)) {
    await jsonFileService.writeJson(fileName, contents);
  }
  await chaosService.initialize(data['chaos.json']);
  metricsRuntimeService.initialize(data['services.json'], data['metrics.json'], 500);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  streamingService.attach(server);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  operator = await login('operator@pulse.dev', 'pulse123');
  viewer = await login('viewer@pulse.dev', 'pulse123');
});

test.after(async () => {
  await chaosService.reset();
  streamingService.close();
  metricsRuntimeService.stop();
  if (server?.listening) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  await fs.rm(dataDirectory, { recursive: true, force: true });
});

test('login accepts operator and viewer and rejects incorrect credentials', async () => {
  assert.equal(operator.user.role, 'operator');
  assert.equal(viewer.user.role, 'viewer');
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'viewer@pulse.dev', password: 'wrong' }),
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'invalid_credentials');
});

test('refresh rotates tokens and rejects an old refresh token', async () => {
  const original = await login('viewer@pulse.dev', 'pulse123');
  const response = await fetch(`${baseUrl}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: original.refreshToken }),
  });
  assert.equal(response.status, 200);
  const rotated = await response.json();
  assert.notEqual(rotated.refreshToken, original.refreshToken);

  const reused = await fetch(`${baseUrl}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: original.refreshToken }),
  });
  assert.equal(reused.status, 401);
  assert.equal((await reused.json()).error.code, 'refresh_invalid');
});

test('services and metrics endpoints return the expected data', async () => {
  const headers = bearer(operator.accessToken);
  const servicesResponse = await fetch(`${baseUrl}/services`, { headers });
  const services = await servicesResponse.json();
  assert.equal(servicesResponse.status, 200);
  assert.equal(services.length, 2000);
  assert.equal(services[0].id, 'svc-0001');

  const snapshot = await (await fetch(`${baseUrl}/metrics/snapshot`, { headers })).json();
  assert.equal(snapshot.metrics.length, 2000);
  assert.ok(Number.isSafeInteger(snapshot.offset));

  const historyResponse = await fetch(`${baseUrl}/metrics/history?serviceId=svc-0412&minutes=15`, { headers });
  const history = await historyResponse.json();
  assert.equal(historyResponse.status, 200);
  assert.equal(history.points.length, 900);

  const badHistory = await fetch(`${baseUrl}/metrics/history?serviceId=unknown&minutes=15`, { headers });
  assert.equal(badHistory.status, 404);

  const replay = await (await fetch(`${baseUrl}/metrics/replay?since=0`, { headers })).json();
  assert.ok(replay.events.every((event) => event.offset > 0));
});

test('viewers can read rules but cannot create, update, or delete them', async () => {
  const response = await fetch(`${baseUrl}/rules`, { headers: bearer(viewer.accessToken) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);

  const denied = await fetch(`${baseUrl}/rules`, {
    method: 'POST', headers: { ...bearer(viewer.accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(makeRule('Viewer rule')),
  });
  assert.equal(denied.status, 403);

  const deniedUpdate = await fetch(`${baseUrl}/rules/rule-0001`, {
    method: 'PUT', headers: { ...bearer(viewer.accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(makeRule('Blocked update')),
  });
  assert.equal(deniedUpdate.status, 403);
  const deniedDelete = await fetch(`${baseUrl}/rules/rule-0001`, {
    method: 'DELETE', headers: bearer(viewer.accessToken),
  });
  assert.equal(deniedDelete.status, 403);
});

test('operators can create, read, update, delete rules and use idempotency keys', async () => {
  const headers = { ...bearer(operator.accessToken), 'Content-Type': 'application/json', 'Idempotency-Key': 'phase7-idempotency-test' };
  const body = {
    ...makeRule('Phase 7 API rule'),
    warningThreshold: 800,
    conditions: [{ ...makeRule('temporary').conditions[0], helpText: 'kept as supplied' }],
  };
  const firstResponse = await fetch(`${baseUrl}/rules`, { method: 'POST', headers, body: JSON.stringify(body) });
  const firstRule = await firstResponse.json();
  assert.equal(firstResponse.status, 201);
  assert.equal(firstRule.warningThreshold, 800);
  assert.equal(firstRule.conditions[0].helpText, 'kept as supplied');

  const repeatResponse = await fetch(`${baseUrl}/rules`, { method: 'POST', headers, body: JSON.stringify(body) });
  const repeatedRule = await repeatResponse.json();
  assert.equal(repeatedRule.id, firstRule.id);

  const loaded = await fetch(`${baseUrl}/rules/${firstRule.id}`, { headers: bearer(operator.accessToken) });
  assert.equal((await loaded.json()).id, firstRule.id);

  const updateResponse = await fetch(`${baseUrl}/rules/${firstRule.id}`, {
    method: 'PUT', headers: { ...bearer(operator.accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, name: 'Updated Phase 7 rule' }),
  });
  assert.equal((await updateResponse.json()).name, 'Updated Phase 7 rule');

  const duplicate = await fetch(`${baseUrl}/rules`, {
    method: 'POST', headers: { ...bearer(operator.accessToken), 'Content-Type': 'application/json', 'Idempotency-Key': 'phase7-duplicate-test' },
    body: JSON.stringify(makeRule('Updated Phase 7 rule')),
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'name_taken');

  const invalidRule = await fetch(`${baseUrl}/rules`, {
    method: 'POST', headers: { ...bearer(operator.accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Invalid rule', conditions: [{ metric: 'unknown', operator: '>', threshold: 1, durationSec: 0 }] }),
  });
  const invalidBody = await invalidRule.json();
  assert.equal(invalidRule.status, 422);
  assert.equal(invalidBody.error.code, 'validation');
  assert.ok(invalidBody.error.details.every((detail) => detail.field && detail.message));

  const deleted = await fetch(`${baseUrl}/rules/${firstRule.id}`, {
    method: 'DELETE', headers: bearer(operator.accessToken),
  });
  assert.equal(deleted.status, 204);
});

test('chaos switches merge, validate, and reset', async () => {
  const settings = {
    rate: 2000,
    ws: 'drop:20',
    sse: 'down',
    chaos: 'shuffle,dupe,garbage:5',
    token_ttl: 5,
    http: '500:50,slow:50',
    kill: 10,
  };
  const update = await fetch(`${baseUrl}/chaos`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
  });
  assert.equal(update.status, 200);
  const saved = await update.json();
  for (const [key, value] of Object.entries(settings)) assert.equal(saved[key], value);

  const nextToken = await login('operator@pulse.dev', 'pulse123');
  assert.equal(nextToken.expiresIn, 5);

  await updateChaos({ http: '500:100' });
  const throttled = await fetch(`${baseUrl}/metrics/snapshot`, { headers: bearer(operator.accessToken) });
  assert.equal(throttled.status, 500);

  const reset = await fetch(`${baseUrl}/chaos`, { method: 'DELETE' });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).rate, 500);
});

test('WebSocket down and SSE down return their documented failures', async () => {
  await updateChaos({ ws: 'down', sse: 'down' });
  const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/stream?access_token=${operator.accessToken}`);
  const responseStatus = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket request did not fail')), 3000);
    socket.on('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      resolve(response.statusCode);
    });
    socket.on('error', reject);
  });
  assert.equal(responseStatus, 503);

  const sse = await fetch(`${baseUrl}/stream/sse?access_token=${operator.accessToken}`);
  assert.equal(sse.status, 503);
  await updateChaos({ ws: 'up', sse: 'up' });
});

function makeRule(name) {
  return {
    name,
    severity: 'warning',
    enabled: true,
    conditions: [{ metric: 'p95', operator: '>', threshold: 500, durationSec: 5 }],
  };
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function login(email, password) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function updateChaos(settings) {
  const response = await fetch(`${baseUrl}/chaos`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
  });
  assert.equal(response.status, 200);
  return response.json();
}
