const path = require('node:path');

const DATA_DIRECTORY = process.env.DATA_DIRECTORY || path.join(__dirname, '..', 'data');

// Only these backend-owned JSON files can be accessed by the file service.
const DATA_FILES = {
  users: 'users.json',
  tokens: 'tokens.json',
  services: 'services.json',
  metrics: 'metrics.json',
  rules: 'rules.json',
  idempotency: 'idempotency.json',
  chaos: 'chaos.json',
};

module.exports = {
  PORT: Number(process.env.PORT) || 4000,
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || 'http://localhost:4200',
  JWT_SECRET: process.env.JWT_SECRET || '',
  ACCESS_TOKEN_TTL: Number(process.env.ACCESS_TOKEN_TTL) || 60,
  REFRESH_TOKEN_TTL_SECONDS: Number(process.env.REFRESH_TOKEN_TTL_SECONDS) || 604800,
  DATA_DIRECTORY,
  DATA_FILES,
};
