const jwt = require('jsonwebtoken');

const { JWT_SECRET } = require('../config/config');
const { streamingService } = require('../services/streamingService');
const { sendApiError } = require('../utils/apiError');

function openSseStream(request, response) {
  const accessToken = request.query.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    return sendApiError(response, 401, 'token_missing', 'Access token is required');
  }

  try {
    jwt.verify(accessToken, JWT_SECRET);
  } catch (error) {
    const code = error.name === 'TokenExpiredError' ? 'token_expired' : 'token_invalid';
    const message = code === 'token_expired' ? 'Access token expired' : 'Access token is invalid';
    return sendApiError(response, 401, code, message);
  }

  let connection;
  try {
    connection = streamingService.getSseConnectionSettings(request.query);
  } catch (error) {
    return sendApiError(response, 422, error.code || 'invalid_chaos_config', error.message);
  }
  if (connection.settings.down) {
    return sendApiError(response, 503, 'sse_unavailable', 'SSE streaming is disabled by chaos settings');
  }

  response.status(200);
  response.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders();
  streamingService.addSseClient(response, connection.overrides);
}

module.exports = { openSseStream };
