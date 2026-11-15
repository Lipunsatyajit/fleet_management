const { jsonFileService } = require('../services/jsonFileService');
async function getServices(_request, response) {
  const services = await jsonFileService.readJson('services.json', []);
  return response.json(services);
}

async function getMetrics(_request, response) {
  const metrics = await jsonFileService.readJson('metrics.json', []);
  return response.json(metrics);
}

module.exports = { getServices, getMetrics };
