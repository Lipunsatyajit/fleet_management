const jwt = require('jsonwebtoken');

const { JWT_SECRET } = require('../config/config');
const { sendApiError } = require('../utils/apiError');

function authenticate(request, response, next) {
  const authorization = request.get('authorization');
  const accessToken = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : '';

  if (!accessToken) {
    return sendApiError(response, 401, 'token_missing', 'Access token is required');
  }

  try {
    request.user = jwt.verify(accessToken, JWT_SECRET);
    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return sendApiError(response, 401, 'token_expired', 'Access token expired');
    }

    return sendApiError(response, 401, 'token_invalid', 'Access token is invalid');
  }
}

module.exports = { authenticate };
