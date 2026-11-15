require('dotenv').config();

const app = require('./app');
const bcrypt = require('bcryptjs');
const { PORT, JWT_SECRET, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL_SECONDS, DATA_FILES } = require('./config/config');
const { createInitialData } = require('./utils/initialData');
const { jsonFileService } = require('./services/jsonFileService');
const { metricsRuntimeService } = require('./services/metricsRuntimeService');
const { streamingService } = require('./services/streamingService');
const { chaosService } = require('./services/chaosService');

async function prepareJsonFiles() {
  if (!JWT_SECRET) {
    throw new Error('Set JWT_SECRET in backend/.env before starting the server.');
  }

  const demoPasswordHash = await bcrypt.hash('pulse123', 12);
  const initialData = createInitialData(demoPasswordHash);

  for (const fileName of Object.values(DATA_FILES)) {
    await jsonFileService.readJson(fileName, initialData[fileName]);
  }

  // Secure Phase 1 accounts: hash legacy passwords and remove the plain-text field.
  await jsonFileService.updateJson('users.json', async (users) => {
    if (!Array.isArray(users)) {
      throw new Error('users.json must contain a JSON array.');
    }

    const secureUsers = [];
    for (let index = 0; index < users.length; index += 1) {
      const user = { ...users[index] };
      if (!user.id) {
        user.id = user.email === 'operator@pulse.dev' ? 'u-1'
          : user.email === 'viewer@pulse.dev' ? 'u-2'
            : `u-${index + 1}`;
      }
      if (!user.passwordHash && typeof user.password === 'string') {
        user.passwordHash = await bcrypt.hash(user.password, 12);
      }
      delete user.password;
      secureUsers.push(user);
    }

    return secureUsers;
  }, initialData['users.json']);

  if (!Number.isInteger(ACCESS_TOKEN_TTL) || ACCESS_TOKEN_TTL < 1) {
    throw new Error('ACCESS_TOKEN_TTL must be a positive number of seconds.');
  }
  if (!Number.isInteger(REFRESH_TOKEN_TTL_SECONDS) || REFRESH_TOKEN_TTL_SECONDS < 1) {
    throw new Error('REFRESH_TOKEN_TTL_SECONDS must be a positive number of seconds.');
  }

  const services = await jsonFileService.readJson('services.json', []);
  const metrics = await jsonFileService.readJson('metrics.json', []);
  const chaos = await jsonFileService.readJson('chaos.json', {});
  const activeChaosConfig = await chaosService.initialize(chaos);
  metricsRuntimeService.initialize(services, metrics, activeChaosConfig.rate);
}

async function startServer() {
  await prepareJsonFiles();

  const server = app.listen(PORT, () => {
    console.log(`Fleet Pulse backend is running at http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Allowed Angular origin: ${process.env.FRONTEND_ORIGIN || 'http://localhost:4200'}`);
  });
  streamingService.attach(server);

  server.on('error', (error) => {
    console.error('Could not start the backend:', error.message);
    process.exitCode = 1;
  });
}

startServer().catch((error) => {
  console.error('Backend startup failed:', error.message);
  process.exitCode = 1;
});
