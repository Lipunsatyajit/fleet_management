const { jsonFileService } = require('./jsonFileService');

const supportedMetrics = ['p95', 'errRate', 'rps'];
const supportedOperators = ['>', '>=', '<', '<='];

let writeQueue = Promise.resolve();

function runOneRuleUpdateAtATime(operation) {
  const nextOperation = writeQueue.catch(() => undefined).then(operation);
  writeQueue = nextOperation.catch(() => undefined);
  return nextOperation;
}

function createRuleError(status, code, message, details = []) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

function validateRule(input) {
  const errors = [];
  const addError = (field, message) => errors.push({ field, message });
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    addError('body', 'A rule object is required.');
    return { isValid: false, errors };
  }

  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    addError('name', 'Rule name is required.');
  }
  if (!Array.isArray(input.conditions) || input.conditions.length === 0) {
    addError('conditions', 'At least one condition is required.');
  } else {
    input.conditions.forEach((condition, index) => {
      const location = `conditions[${index}]`;
      if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
        addError(location, 'Condition must be an object.');
        return;
      }
      if (!supportedMetrics.includes(condition.metric)) {
        addError(`${location}.metric`, 'Metric must be p95, errRate, or rps.');
      }
      if (!supportedOperators.includes(condition.operator)) {
        addError(`${location}.operator`, 'Operator must be >, >=, <, or <=.');
      }
      if (typeof condition.threshold !== 'number' || !Number.isFinite(condition.threshold)) {
        addError(`${location}.threshold`, 'Threshold must be a finite number.');
      } else if (condition.threshold < 0) {
        addError(`${location}.threshold`, 'Threshold cannot be negative.');
      } else if (condition.metric === 'errRate' && condition.threshold > 100) {
        addError(`${location}.threshold`, 'Error-rate threshold cannot exceed 100 percent.');
      }
      if (!Number.isInteger(condition.durationSec) || condition.durationSec < 1) {
        addError(`${location}.durationSec`, 'Duration must be a positive whole number.');
      }
    });
  }
  if (input.severity !== undefined && !['info', 'warning', 'critical'].includes(input.severity)) {
    addError('severity', 'Severity must be info, warning, or critical.');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    addError('enabled', 'Enabled must be true or false.');
  }

  return { isValid: errors.length === 0, errors };
}

function normalizeRule(input) {
  const rule = {
    ...input,
    name: input.name.trim(),
    conditions: input.conditions.map((condition) => ({ ...condition })),
  };
  // IDs and timestamps belong to the backend; keep all other caller fields.
  delete rule.id;
  delete rule.createdAt;
  delete rule.updatedAt;
  if (input.severity !== undefined) rule.severity = input.severity;
  if (input.enabled !== undefined) rule.enabled = input.enabled;
  return rule;
}

function createRulesService(storage = jsonFileService) {
  async function getRules() {
    return storage.readJson('rules.json', []);
  }

  async function getRule(id) {
    const rules = await getRules();
    return rules.find((rule) => rule.id === id) || null;
  }

  async function checkName(name, excludeId = '') {
    const rules = await getRules();
    const normalizedName = name.trim().toLowerCase();
    const exists = rules.some((rule) =>
      rule.id !== excludeId && rule.name.trim().toLowerCase() === normalizedName,
    );
    return { name: name.trim(), available: !exists };
  }

  async function createRule(input, idempotencyKey) {
    return runOneRuleUpdateAtATime(async () => {
      if (idempotencyKey) {
        const savedResponses = await storage.readJson('idempotency.json', []);
        const previousResponse = savedResponses.find((entry) => entry.key === idempotencyKey);
        if (previousResponse) {
          return previousResponse.response;
        }
      }

      const validation = validateRule(input);
      if (!validation.isValid) {
        throw createRuleError(422, 'validation_error', 'Rule data is invalid', validation.errors);
      }

      const rules = await getRules();
      const normalizedRule = normalizeRule(input);
      const duplicate = rules.some((rule) =>
        rule.name.trim().toLowerCase() === normalizedRule.name.toLowerCase(),
      );
      if (duplicate) {
        throw createRuleError(409, 'name_taken', 'Rule name already exists');
      }

      const nextNumber = rules.reduce((highest, rule) => {
        const match = /^rule-(\d+)$/i.exec(rule.id || '');
        return match ? Math.max(highest, Number(match[1])) : highest;
      }, 0) + 1;
      const timestamp = new Date().toISOString();
      const rule = {
        id: `rule-${String(nextNumber).padStart(4, '0')}`,
        ...normalizedRule,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await storage.updateJson('rules.json', (currentRules) => {
        if (!Array.isArray(currentRules)) {
          throw new Error('rules.json must contain a JSON array.');
        }
        return [...currentRules, rule];
      }, []);

      const response = { status: 201, body: rule };
      if (idempotencyKey) {
        await storage.updateJson('idempotency.json', (entries) => {
          if (!Array.isArray(entries)) {
            throw new Error('idempotency.json must contain a JSON array.');
          }
          return [...entries, { key: idempotencyKey, response }];
        }, []);
      }

      return response;
    });
  }

  async function updateRule(id, input) {
    return runOneRuleUpdateAtATime(async () => {
      const rules = await getRules();
      const currentRule = rules.find((rule) => rule.id === id);
      if (!currentRule) {
        throw createRuleError(404, 'rule_not_found', 'Rule not found');
      }

      const mergedInput = { ...currentRule, ...input };
      const validation = validateRule(mergedInput);
      if (!validation.isValid) {
        throw createRuleError(422, 'validation_error', 'Rule data is invalid', validation.errors);
      }

      const normalizedRule = normalizeRule(mergedInput);
      const duplicate = rules.some((rule) =>
        rule.id !== id && rule.name.trim().toLowerCase() === normalizedRule.name.toLowerCase(),
      );
      if (duplicate) {
        throw createRuleError(409, 'name_taken', 'Rule name already exists');
      }

      const updatedRule = {
        ...currentRule,
        ...normalizedRule,
        updatedAt: new Date().toISOString(),
      };

      await storage.updateJson('rules.json', (currentRules) =>
        currentRules.map((rule) => rule.id === id ? updatedRule : rule), []);
      return updatedRule;
    });
  }

  async function deleteRule(id) {
    return runOneRuleUpdateAtATime(async () => {
      let wasFound = false;
      await storage.updateJson('rules.json', (rules) => {
        if (!Array.isArray(rules)) {
          throw new Error('rules.json must contain a JSON array.');
        }
        const remainingRules = rules.filter((rule) => {
          const matches = rule.id === id;
          wasFound = wasFound || matches;
          return !matches;
        });
        return remainingRules;
      }, []);

      if (!wasFound) {
        throw createRuleError(404, 'rule_not_found', 'Rule not found');
      }
    });
  }

  return { getRules, getRule, checkName, createRule, updateRule, deleteRule };
}

const rulesService = createRulesService();

module.exports = { createRulesService, rulesService, validateRule };
