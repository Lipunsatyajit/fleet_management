const { chaosService } = require('../services/chaosService');

function getChaos(_request, response) {
  return response.json(chaosService.getConfig());
}

async function updateChaos(request, response, next) {
  try {
    const config = await chaosService.update(request.body);
    return response.json(config);
  } catch (error) {
    return next(error);
  }
}

async function resetChaos(_request, response, next) {
  try {
    const config = await chaosService.reset();
    return response.json(config);
  } catch (error) {
    return next(error);
  }
}

module.exports = { getChaos, updateChaos, resetChaos };
