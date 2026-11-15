const { jsonFileService } = require('../services/jsonFileService');
const { metricsRuntimeService } = require('../services/metricsRuntimeService');
const { sendApiError } = require('../utils/apiError');

async function getSnapshot(_request, response) {
  return response.json(metricsRuntimeService.getSnapshot());
}

async function getHistory(request, response) {
  const serviceId = request.query.serviceId;
  const minutes = Number(request.query.minutes);

  if (typeof serviceId !== 'string' || !serviceId) {
    return sendApiError(response, 422, 'invalid_service_id', 'A serviceId query value is required');
  }

  const knownServices = await jsonFileService.readJson('services.json', []);
  if (!knownServices.some((service) => service.id === serviceId)) {
    return sendApiError(response, 404, 'service_not_found', 'Service not found');
  }

  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    return sendApiError(response, 422, 'invalid_minutes', 'minutes must be a whole number from 1 to 60');
  }

  return response.json({
    serviceId,
    minutes,
    points: metricsRuntimeService.getHistory(serviceId, minutes),
  });
}

function getReplay(request, response) {
  const since = Number(request.query.since);
  if (!Number.isSafeInteger(since) || since < 0) {
    return sendApiError(response, 422, 'invalid_offset', 'since must be a non-negative integer');
  }

  const replay = metricsRuntimeService.getReplay(since);
  if (replay.tooOld) {
    return sendApiError(response, 410, 'replay_too_old', 'The requested replay offset is no longer available', [
      { oldestOffset: replay.oldestOffset },
    ]);
  }

  return response.json({
    since,
    offset: metricsRuntimeService.getSnapshot().offset,
    events: replay.events,
  });
}

module.exports = { getSnapshot, getHistory, getReplay };
