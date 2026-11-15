const { sendApiError } = require('../utils/apiError');

function notFound(_request, response, _next) {
  return sendApiError(response, 404, 'not_found', 'Route not found');
}

function errorHandler(error, _request, response, _next) {
  console.error('Request error:', error.message);
  const status = error.status || 500;
  const code = error.code || (status === 400 ? 'invalid_request' : 'internal_error');
  const message = status < 500
    ? (error.message || 'Request could not be completed')
    : 'An unexpected server error occurred';
  return sendApiError(response, status, code, message, error.details || []);
}

module.exports = { notFound, errorHandler };
