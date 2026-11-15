const { rulesService } = require('../services/rulesService');
const { sendApiError } = require('../utils/apiError');

async function getRules(_request, response) {
  return response.json(await rulesService.getRules());
}

async function getRule(request, response) {
  const rule = await rulesService.getRule(request.params.id);
  if (!rule) {
    return sendApiError(response, 404, 'rule_not_found', 'Rule not found');
  }
  return response.json(rule);
}

async function checkName(request, response) {
  const name = request.query.name;
  const excludeId = typeof request.query.excludeId === 'string' ? request.query.excludeId : '';

  if (typeof name !== 'string' || !name.trim()) {
    return sendApiError(response, 422, 'validation_error', 'A rule name is required');
  }

  return response.json(await rulesService.checkName(name, excludeId));
}

async function createRule(request, response) {
  const idempotencyKey = request.get('Idempotency-Key')?.trim();
  const result = await rulesService.createRule(request.body, idempotencyKey);
  return response.status(result.status).json(result.body);
}

async function updateRule(request, response) {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    return sendApiError(response, 422, 'validation_error', 'A rule object is required');
  }

  const id = request.params.id || request.body?.id;
  if (typeof id !== 'string' || !id) {
    return sendApiError(response, 422, 'validation_error', 'A rule id is required');
  }

  const rule = await rulesService.updateRule(id, request.body);
  return response.json(rule);
}

async function deleteRule(request, response) {
  const id = request.params.id || request.body?.id;
  if (typeof id !== 'string' || !id) {
    return sendApiError(response, 422, 'validation_error', 'A rule id is required');
  }

  await rulesService.deleteRule(id);
  return response.status(204).send();
}

module.exports = { getRules, getRule, checkName, createRule, updateRule, deleteRule };
