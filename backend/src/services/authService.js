const { createHash, randomBytes } = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const {
  JWT_SECRET,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL_SECONDS,
} = require('../config/config');
const { jsonFileService } = require('./jsonFileService');
const { chaosService } = require('./chaosService');

function makeError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function hashRefreshToken(refreshToken) {
  return createHash('sha256').update(refreshToken).digest('hex');
}

function createAuthService(storage = jsonFileService) {
  function makeRefreshTokenRecord(refreshTokenHash, user) {
    const now = Date.now();
    return {
      tokenHash: refreshTokenHash,
      userId: user.id,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
      revokedAt: null,
    };
  }

  function getAccessTokenTtl() {
    return chaosService.getConfig().token_ttl || ACCESS_TOKEN_TTL;
  }

  function makeAccessToken(user, expiresIn) {
    return jwt.sign(
      { email: user.email, role: user.role },
      JWT_SECRET,
      { subject: user.id, expiresIn },
    );
  }

  function makeResponse(user, refreshToken) {
    const expiresIn = getAccessTokenTtl();
    return {
      accessToken: makeAccessToken(user, expiresIn),
      refreshToken,
      expiresIn,
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  async function addRefreshToken(record) {
    await storage.updateJson('tokens.json', (records) => {
      if (!Array.isArray(records)) {
        throw new Error('tokens.json must contain a JSON array.');
      }
      return [...records, record];
    }, []);
  }

  async function login(email, password) {
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      throw makeError(400, 'invalid_request', 'Email and password are required');
    }

    const users = await storage.readJson('users.json', []);
    const user = users.find((item) => item.email.toLowerCase() === email.trim().toLowerCase());
    const passwordMatches = user?.passwordHash
      ? await bcrypt.compare(password, user.passwordHash)
      : false;

    if (!passwordMatches) {
      throw makeError(401, 'invalid_credentials', 'Email or password is incorrect');
    }

    const refreshToken = randomBytes(48).toString('base64url');
    const refreshTokenHash = hashRefreshToken(refreshToken);
    await addRefreshToken(makeRefreshTokenRecord(refreshTokenHash, user));
    return makeResponse(user, refreshToken);
  }

  async function refresh(refreshToken) {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw makeError(401, 'refresh_invalid', 'Refresh token is invalid');
    }

    const oldTokenHash = hashRefreshToken(refreshToken);
    const records = await storage.readJson('tokens.json', []);
    const oldRecord = records.find((record) => record.tokenHash === oldTokenHash);
    const isActive = oldRecord
      && !oldRecord.revokedAt
      && Date.parse(oldRecord.expiresAt) > Date.now();

    if (!isActive) {
      throw makeError(401, 'refresh_invalid', 'Refresh token is invalid');
    }

    const users = await storage.readJson('users.json', []);
    const user = users.find((item) => item.id === oldRecord.userId);
    if (!user) {
      throw makeError(401, 'refresh_invalid', 'Refresh token is invalid');
    }

    const newRefreshToken = randomBytes(48).toString('base64url');
    const newRefreshHash = hashRefreshToken(newRefreshToken);
    const newRecord = makeRefreshTokenRecord(newRefreshHash, user);
    let didRotate = false;

    // Check and replace the old token in one queued file update to prevent double use.
    await storage.updateJson('tokens.json', (currentRecords) => {
      if (!Array.isArray(currentRecords)) {
        throw new Error('tokens.json must contain a JSON array.');
      }

      const currentIndex = currentRecords.findIndex((record) =>
        record.tokenHash === oldTokenHash
        && !record.revokedAt
        && Date.parse(record.expiresAt) > Date.now(),
      );

      if (currentIndex === -1) {
        return currentRecords;
      }

      const updatedRecords = [...currentRecords];
      updatedRecords[currentIndex] = {
        ...updatedRecords[currentIndex],
        revokedAt: new Date().toISOString(),
      };
      updatedRecords.push(newRecord);
      didRotate = true;
      return updatedRecords;
    }, []);

    if (!didRotate) {
      throw makeError(401, 'refresh_invalid', 'Refresh token is invalid');
    }

    return makeResponse(user, newRefreshToken);
  }

  return { login, refresh };
}

module.exports = { createAuthService };
