const { jsonFileService } = require('./jsonFileService');
const { metricsRuntimeService } = require('./metricsRuntimeService');

const DEFAULT_CHAOS_CONFIG = {
  rate: 500,
  ws: 'up',
  sse: 'up',
  chaos: 'off',
  token_ttl: null,
  http: 'off',
  kill: 0,
};

const VALID_KEYS = new Set(Object.keys(DEFAULT_CHAOS_CONFIG));

function createChaosService(storage = jsonFileService, metrics = metricsRuntimeService) {
  let currentConfig = { ...DEFAULT_CHAOS_CONFIG };
  let writeQueue = Promise.resolve();
  const listeners = new Set();

  async function initialize(savedConfig = {}) {
    const startingValues = { ...savedConfig };
    if (startingValues.rate === undefined && startingValues.eventRate !== undefined) {
      startingValues.rate = startingValues.eventRate;
    }

    currentConfig = normalizeConfig(startingValues, true);
    metrics.setEventRate(currentConfig.rate);
    notifyListeners();

    const needsMigration = Object.entries(currentConfig).some(([key, value]) =>
      JSON.stringify(savedConfig[key]) !== JSON.stringify(value),
    ) || savedConfig.eventRate !== currentConfig.rate;

    if (needsMigration) {
      await storage.updateJson('chaos.json', (storedConfig) => ({
        ...(storedConfig && typeof storedConfig === 'object' && !Array.isArray(storedConfig) ? storedConfig : {}),
        ...currentConfig,
        eventRate: currentConfig.rate,
      }), { ...DEFAULT_CHAOS_CONFIG });
    }
    return getConfig();
  }

  function getConfig() {
    return { ...currentConfig };
  }

  function update(partialConfig) {
    const operation = writeQueue.then(async () => {
      const mergedConfig = normalizeConfig({ ...currentConfig, ...validatePartial(partialConfig) });
      await storage.updateJson('chaos.json', (savedConfig) => ({
        ...(savedConfig && typeof savedConfig === 'object' && !Array.isArray(savedConfig) ? savedConfig : {}),
        ...mergedConfig,
        eventRate: mergedConfig.rate,
      }), { ...DEFAULT_CHAOS_CONFIG });

      currentConfig = mergedConfig;
      metrics.setEventRate(currentConfig.rate);
      notifyListeners();
      return getConfig();
    });

    writeQueue = operation.catch(() => undefined);
    return operation;
  }

  function reset() {
    const operation = writeQueue.then(async () => {
      await storage.writeJson('chaos.json', { ...DEFAULT_CHAOS_CONFIG });
      currentConfig = { ...DEFAULT_CHAOS_CONFIG };
      metrics.setEventRate(currentConfig.rate);
      notifyListeners();
      return getConfig();
    });

    writeQueue = operation.catch(() => undefined);
    return operation;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function notifyListeners() {
    const config = getConfig();
    for (const listener of listeners) {
      listener(config);
    }
  }

  return { initialize, getConfig, update, reset, subscribe, validateOverrides };
}

function validatePartial(partialConfig) {
  if (!partialConfig || typeof partialConfig !== 'object' || Array.isArray(partialConfig)) {
    throw makeValidationError('Chaos settings must be a JSON object.');
  }

  for (const key of Object.keys(partialConfig)) {
    if (!VALID_KEYS.has(key)) {
      throw makeValidationError(`Unknown chaos switch: ${key}`);
    }
  }

  const validated = {};
  for (const [key, value] of Object.entries(partialConfig)) {
    validated[key] = validateSwitch(key, value);
  }
  return validated;
}

function validateOverrides(overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw makeValidationError('Connection chaos settings must be an object.');
  }
  const connectionConfig = {};
  for (const key of ['ws', 'sse', 'chaos']) {
    if (overrides[key] !== undefined) {
      connectionConfig[key] = overrides[key];
    }
  }
  return validatePartial(connectionConfig);
}

function normalizeConfig(config, isStartup = false) {
  const normalized = { ...DEFAULT_CHAOS_CONFIG };
  const values = { ...config };
  if (values.rate === undefined && values.eventRate !== undefined) {
    values.rate = values.eventRate;
  }

  for (const key of VALID_KEYS) {
    if (values[key] === undefined) {
      continue;
    }
    try {
      normalized[key] = validateSwitch(key, values[key]);
    } catch (error) {
      if (!isStartup) {
        throw error;
      }
      // Ignore an unsupported old setting rather than preventing server startup.
    }
  }
  return normalized;
}

function validateSwitch(key, value) {
  if (key === 'rate') {
    if (!Number.isInteger(value) || value < 1 || value > 5000) {
      throw makeValidationError('rate must be a whole number from 1 to 5000.');
    }
    return value;
  }

  if (key === 'ws') {
    if (typeof value !== 'string' || !['up', 'down', 'silent'].includes(value)) {
      const match = typeof value === 'string' ? value.match(/^drop:(\d{1,3})$/) : null;
      if (!match || Number(match[1]) > 100) {
        throw makeValidationError('ws must be up, down, silent, or drop:<0-100>.');
      }
    }
    return value;
  }

  if (key === 'sse') {
    if (value !== 'up' && value !== 'down') {
      throw makeValidationError('sse must be up or down.');
    }
    return value;
  }

  if (key === 'chaos') {
    return validateChaosModes(value);
  }

  if (key === 'token_ttl') {
    if (value === null || value === 'off') {
      return null;
    }
    const ttl = Number(value);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) {
      throw makeValidationError('token_ttl must be null or a whole number from 1 to 86400 seconds.');
    }
    return ttl;
  }

  if (key === 'http') {
    return validateHttpModes(value);
  }

  if (key === 'kill') {
    if (value === 0 || value === '0' || value === 'off') {
      return 0;
    }
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
      throw makeValidationError('kill must be 0 or a whole number from 1 to 86400 seconds.');
    }
    return seconds;
  }

  throw makeValidationError(`Unsupported chaos switch: ${key}`);
}

function validateChaosModes(value) {
  if (Array.isArray(value)) {
    value = value.join(',');
  }
  if (typeof value !== 'string') {
    throw makeValidationError('chaos must be off, shuffle, dupe, or garbage:<0-100>.');
  }
  if (value === 'off' || value === '') {
    return 'off';
  }

  const modes = value.split(',').map((mode) => mode.trim()).filter(Boolean);
  const uniqueModes = new Set();
  for (const mode of modes) {
    if (mode === 'shuffle' || mode === 'dupe') {
      uniqueModes.add(mode);
      continue;
    }
    const garbage = mode.match(/^garbage:(\d{1,3})$/);
    if (garbage && Number(garbage[1]) <= 100 && ![...uniqueModes].some((item) => item.startsWith('garbage:'))) {
      uniqueModes.add(mode);
      continue;
    }
    throw makeValidationError('chaos accepts shuffle, dupe, and garbage:<0-100> modes.');
  }
  return [...uniqueModes].join(',') || 'off';
}

function validateHttpModes(value) {
  if (Array.isArray(value)) {
    value = value.join(',');
  }
  if (typeof value !== 'string') {
    throw makeValidationError('http must be off, 429, 500:<0-100>, or slow:<milliseconds>.');
  }
  if (value === 'off' || value === '') {
    return 'off';
  }

  const modes = value.split(',').map((mode) => mode.trim()).filter(Boolean);
  const uniqueModes = new Set();
  for (const mode of modes) {
    if (mode === '429') {
      uniqueModes.add(mode);
      continue;
    }
    const failure = mode.match(/^500:(\d{1,3})$/);
    if (failure && Number(failure[1]) <= 100 && ![...uniqueModes].some((item) => item.startsWith('500:'))) {
      uniqueModes.add(mode);
      continue;
    }
    const slow = mode.match(/^slow:(\d{1,6})$/);
    if (slow && Number(slow[1]) <= 60000 && ![...uniqueModes].some((item) => item.startsWith('slow:'))) {
      uniqueModes.add(mode);
      continue;
    }
    throw makeValidationError('http accepts 429, 500:<0-100>, and slow:<0-60000> modes.');
  }
  return [...uniqueModes].join(',') || 'off';
}

function makeValidationError(message) {
  const error = new Error(message);
  error.status = 422;
  error.code = 'invalid_chaos_config';
  error.details = [];
  return error;
}

const chaosService = createChaosService();

module.exports = { DEFAULT_CHAOS_CONFIG, createChaosService, chaosService, validatePartial, validateOverrides };
