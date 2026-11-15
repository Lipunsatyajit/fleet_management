const { createAuthService } = require('../services/authService');
const { sendApiError } = require('../utils/apiError');

const authService = createAuthService();

async function login(request, response, next) {
  try {
    const result = await authService.login(request.body?.email, request.body?.password);
    return response.json(result);
  } catch (error) {
    if (error.status) {
      return sendApiError(response, error.status, error.code, error.message);
    }
    return next(error);
  }
}

async function refresh(request, response, next) {
  try {
    const result = await authService.refresh(request.body?.refreshToken);
    return response.json(result);
  } catch (error) {
    if (error.status) {
      return sendApiError(response, error.status, error.code, error.message);
    }
    return next(error);
  }
}

module.exports = { login, refresh };
