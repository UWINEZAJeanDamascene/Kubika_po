const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { prisma } = require('../lib/prisma');
const SessionService = require('./sessionService');

// Import centralized configuration
const env = require('../src/config/environment');
const config = env.getConfig();

// Validate required config
if (!config.jwt.secret) {
  throw new Error('FATAL: JWT_SECRET environment variable is required.');
}

const JWT_SECRET = config.jwt.secret;
const ACCESS_EXPIRE = config.jwt.expiresIn;
const REFRESH_EXPIRE = config.jwt.refreshExpiresIn;

/**
 * Refresh-token rotation (RFC 6819 style):
 * - Each successful POST /api/auth/refresh issues a NEW refresh_token and invalidates the previous
 *   one by replacing the stored refresh token hash (see refreshWithRotation).
 * - Reusing an old refresh token fails validation and revokes all sessions for that user.
 */

function sha256(plain) {
  return crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
}

function membershipsForUser(user) {
  return [
    {
      companyId: user.companyId ? String(user.companyId) : undefined,
      role: user.role,
    },
  ];
}

function signTokenPair(userId, memberships) {
  const access_token = jwt.sign(
    { id: userId, userId, memberships },
    JWT_SECRET,
    { expiresIn: ACCESS_EXPIRE },
  );
  const refresh_token = jwt.sign(
    { userId, type: 'refresh', jti: crypto.randomBytes(16).toString('hex') },
    JWT_SECRET,
    { expiresIn: REFRESH_EXPIRE },
  );
  return { access_token, refresh_token };
}

class TokenService {
  /**
   * Build access + refresh JWTs and persist the refresh token hash on the user
   * row (never store the raw refresh token).
   */
  static async issueTokensForUser(userId, memberships) {
    const pair = signTokenPair(String(userId), memberships);
    await prisma.user.update({
      where: { id: String(userId) },
      data: { refreshTokenHash: sha256(pair.refresh_token), refreshToken: null },
    });
    return pair;
  }

  /**
   * Persist hash and return pair (e.g. for impersonation or token re-issue
   * without a full login).
   */
  static async generateTokenPair(userId, memberships) {
    const user = await prisma.user.findUnique({ where: { id: String(userId) } });
    if (!user) {
      const err = new Error('User not found');
      err.code = 'USER_NOT_FOUND';
      throw err;
    }
    return this.issueTokensForUser(user.id, memberships);
  }

  static _storedRefreshMatches(user, refreshPlain) {
    const presented = sha256(refreshPlain);
    if (user.refreshTokenHash) {
      return presented === user.refreshTokenHash;
    }
    if (user.refreshToken) {
      return user.refreshToken === refreshPlain;
    }
    return false;
  }

  static async refreshWithRotation(refreshPlain) {
    let decoded;
    try {
      decoded = jwt.verify(refreshPlain, JWT_SECRET);
    } catch (e) {
      if (e.name === 'TokenExpiredError') {
        const err = new Error('Refresh token expired');
        err.code = 'REFRESH_TOKEN_EXPIRED';
        throw err;
      }
      const err = new Error('Invalid refresh token');
      err.code = 'INVALID_REFRESH_TOKEN';
      throw err;
    }

    if (!decoded || decoded.type !== 'refresh' || !decoded.userId) {
      const err = new Error('Invalid refresh token');
      err.code = 'INVALID_REFRESH_TOKEN';
      throw err;
    }

    const user = await prisma.user.findUnique({ where: { id: String(decoded.userId) } });
    if (!user) {
      const err = new Error('Invalid refresh token');
      err.code = 'INVALID_REFRESH_TOKEN';
      throw err;
    }

    const matches = this._storedRefreshMatches(user, refreshPlain);
    if (!matches) {
      await this.revokeAllForUser(decoded.userId);
      const err = new Error('Invalid refresh token');
      err.code = 'INVALID_REFRESH_TOKEN';
      throw err;
    }

    const memberships = membershipsForUser(user);
    const { access_token, refresh_token } = await this.issueTokensForUser(user.id, memberships);

    try {
      await SessionService.registerAccessToken(user.id, access_token);
    } catch (e) {
      console.error('Registering refreshed access token failed:', e);
    }

    return { access_token, refresh_token };
  }

  static async revokeAllForUser(userId) {
    await prisma.user.updateMany({
      where: { id: String(userId) },
      data: { refreshToken: null, refreshTokenHash: null },
    });
    await SessionService.deleteAllSessions(String(userId));
  }
}

TokenService.sha256Refresh = sha256;

module.exports = TokenService;
