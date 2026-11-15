const { sendApiError } = require('../utils/apiError');

function requireRole(role) {
  return function checkRole(request, response, next) {
    if (request.user?.role !== role) {
      return sendApiError(response, 403, 'forbidden', 'You do not have permission to perform this action');
    }

    return next();
  };
}

module.exports = { requireRole };
