function sendApiError(response, status, code, message, details = []) {
  const requiredCodes = {
    400: 'bad_request',
    403: 'forbidden',
    404: 'not_found',
    409: 'name_taken',
    410: 'replay_too_old',
    422: 'validation',
    429: 'rate_limited',
    500: 'server_error',
    503: 'unavailable',
  };
  const responseCode = status === 401
    ? (['invalid_credentials', 'token_expired', 'token_invalid', 'refresh_invalid'].includes(code) ? code : 'token_invalid')
    : requiredCodes[status] || code;
  const responseDetails = details.map((detail) => typeof detail === 'string'
    ? { field: 'body', message: detail }
    : detail);
  if (status === 422 && responseDetails.length === 0) {
    responseDetails.push({ field: 'body', message });
  }

  return response.status(status).json({
    error: { code: responseCode, message, details: responseDetails },
  });
}

module.exports = { sendApiError };
