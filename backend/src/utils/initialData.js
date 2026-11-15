const teams = ['Payments', 'Identity', 'Analytics', 'Platform', 'Orders'];
const statuses = ['healthy', 'degraded', 'down'];

function createServices() {
  const services = [];

  for (let number = 1; number <= 2000; number += 1) {
    const idNumber = String(number).padStart(4, '0');
    services.push({
      id: `svc-${idNumber}`,
      name: `service-${idNumber}`,
      team: teams[(number - 1) % teams.length],
      status: statuses[(number - 1) % statuses.length],
    });
  }

  return services;
}

function createMetricSeeds() {
  const timestamp = new Date().toISOString();
  const metrics = [];

  for (let number = 1; number <= 2000; number += 1) {
    const idNumber = String(number).padStart(4, '0');
    metrics.push({
      serviceId: `svc-${idNumber}`,
      ts: timestamp,
      p95: 100 + (number % 500),
      errRate: Number(((number % 50) / 10).toFixed(1)),
      rps: 50 + (number % 950),
    });
  }

  return metrics;
}

function createInitialData(passwordHash) {
  return {
    'users.json': [
      { id: 'u-1', email: 'operator@pulse.dev', passwordHash, role: 'operator' },
      { id: 'u-2', email: 'viewer@pulse.dev', passwordHash, role: 'viewer' },
    ],
    'tokens.json': [],
    'services.json': createServices(),
    'metrics.json': createMetricSeeds(),
    'rules.json': [],
    'idempotency.json': [],
    'chaos.json': {
      rate: 500,
      ws: 'up',
      sse: 'up',
      chaos: 'off',
      token_ttl: null,
      http: 'off',
      kill: 0,
    },
  };
}

module.exports = { createInitialData };
