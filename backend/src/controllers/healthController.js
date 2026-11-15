function getHealth(_request, response) {
  response.json({
    status: 'ok',
    service: 'fleet-pulse-backend',
    timestamp: new Date().toISOString(),
  });
}

module.exports = { getHealth };
