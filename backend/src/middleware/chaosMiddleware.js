const { chaosService } = require('../services/chaosService');
const { sendApiError } = require('../utils/apiError');

const EXCLUDED_PATHS = [/^\/(auth|chaos|health)(\/|$)/];

function chaosMiddleware(request, response, next) {
  if (EXCLUDED_PATHS.some((pattern) => pattern.test(request.path))) {
    return next();
  }

  const httpModes = chaosService.getConfig().http.split(',');
  const applyFailureOrContinue = () => {
    if (httpModes.includes('429')) {
      response.set('Retry-After', '2');
      return sendApiError(response, 429, 'chaos_rate_limited', 'Request rate limited by chaos settings');
    }

    const failureMode = httpModes.find((mode) => mode.startsWith('500:'));
    if (failureMode) {
      const failurePercent = Number(failureMode.slice('500:'.length));
      if (Math.random() * 100 < failurePercent) {
        return sendApiError(response, 500, 'chaos_http_error', 'Request failed by chaos settings');
      }
    }

    return next();
  };

  const slowMode = httpModes.find((mode) => mode.startsWith('slow:'));
  if (slowMode) {
    return setTimeout(applyFailureOrContinue, Number(slowMode.slice('slow:'.length)));
  }

  return applyFailureOrContinue();
}

module.exports = { chaosMiddleware };
