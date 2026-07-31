const { redisClient } = require('../config/redis');
const jwt = require('jsonwebtoken');

// Import centralized configuration
const env = require('../src/config/environment');
const config = env.getConfig();
const JWT_SECRET = config.jwt.secret;

// Helper to scan keys (avoid KEYS in production)
async function scanKeys(pattern) {
  try {
    if (typeof redisClient.scan === 'function') {
      let cursor = '0';
      const results = [];
      do {
        const reply = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        if (Array.isArray(reply)) {
          cursor = reply[0];
          results.push(...(reply[1] || []));
        } else if (reply && reply.cursor !== undefined) {
          cursor = reply.cursor;
          results.push(...(reply.keys || []));
        } else {
          break;
        }
      } while (cursor !== '0');
      return results;
    }

    if (typeof redisClient.scanIterator === 'function') {
      const keys = [];
      for await (const k of redisClient.scanIterator({ MATCH: pattern })) {
        keys.push(k);
      }
      return keys;
    }

    return await redisClient.keys(pattern);
  } catch (error) {
    console.error('scanKeys error:', error);
    try {
      return await redisClient.keys(pattern);
    } catch (e) {
      return [];
    }
  }
}

/**
 * Redis-based rate limiter middleware factory
 * Provides distributed rate limiting across multiple server instances
 * 
 * @param {Object} options - Rate limiter options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.max - Maximum requests per window
 * @param {string} options.keyPrefix - Prefix for Redis keys
 * @param {Function} options.keyGenerator - Custom key generator function
 * @param {Object} options.handler - Custom handler for rate limit exceeded
 * @param {boolean} options.skipSuccessfulRequests - Skip counting successful requests
 * @param {boolean} options.skipFailedRequests - Skip counting failed requests
 * @param {Function} options.skip - Skip the limiter for matching requests
 * @param {string} options.limitBy - Field to limit by (ip, user, company, or custom)
 */
const createRateLimiter = (options = {}) => {
  const {
    windowMs = 60000, // 1 minute default
    max = 100,
    keyPrefix = 'ratelimit',
    keyGenerator = null,
    handler = null,
    skipSuccessfulRequests = false,
    skipFailedRequests = false,
    skip = null,
    limitBy = 'ip',
    // Legacy options for backward compatibility
    windowMs: _windowMs,
    maxRequests: _max,
    ...legacy
  } = options;

  // Handle legacy options
  const effectiveWindowMs = _windowMs || windowMs;
  const effectiveMax = _max || max;

  // Convert windowMs to seconds for Redis TTL
  const windowSeconds = Math.ceil(effectiveWindowMs / 1000);

  return async (req, res, next) => {
    try {
      // Browser CORS preflight requests do not represent API usage.
      if (req.method === 'OPTIONS') return next();
      if (typeof skip === 'function' && skip(req)) return next();

      // Generate key based on limitBy option
      let key;

      if (keyGenerator) {
        key = keyGenerator(req);
      } else {
        switch (limitBy) {
          case 'user': {
            // Limit by user ID if authenticated; otherwise attempt to decode token
            if (req.user && req.user._id) {
              key = req.user._id.toString();
            } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
              try {
                const token = req.headers.authorization.split(' ')[1];
                const payload = jwt.verify(token, JWT_SECRET);
                key = (payload.id || payload._id) ? (payload.id || payload._id).toString() : req.ip;
              } catch (e) {
                key = req.ip;
              }
            } else {
              key = req.ip;
            }
            break;
          }
          case 'company': {
            if (req.company && req.company._id) {
              key = req.company._id.toString();
            } else if (req.user && req.user.company) {
              key = req.user.company.toString();
            } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
              try {
                const token = req.headers.authorization.split(' ')[1];
                const payload = jwt.verify(token, JWT_SECRET);
                key = payload.companyId ? payload.companyId.toString() : req.ip;
              } catch (e) {
                key = req.ip;
              }
            } else {
              key = req.ip;
            }
            break;
          }
          case 'apiKey':
            key = req.headers['x-api-key'] || req.ip;
            break;
          case 'ip':
          default:
            key = req.ip || req.connection?.remoteAddress || 'unknown';
            break;
        }
      }

      const redisKey = `${keyPrefix}:${key}`;

      // Use Redis INCR for atomic counter
      const current = await redisClient.incr(redisKey);

      // Set expiry on first request
      if (current === 1) {
        await redisClient.expire(redisKey, windowSeconds);
      }

      // Get remaining TTL for headers
      const ttl = await redisClient.ttl(redisKey);

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', effectiveMax);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, effectiveMax - current));
      res.setHeader('X-RateLimit-Reset', Math.ceil(Date.now() / 1000 + ttl));

      // Check if rate limit exceeded
      if (current > effectiveMax) {
        const meta = {
          retryAfter: ttl,
          limit: effectiveMax,
          reset: Math.ceil(Date.now() / 1000 + ttl),
        };
        if (handler) {
          return handler(req, res, meta);
        }

        return res.status(429).json({
          success: false,
          message: 'Too many requests, please try again later',
          code: 'RATE_LIMIT_EXCEEDED',
          retry_after: ttl,
          rateLimit: {
            limit: effectiveMax,
            remaining: 0,
            reset: meta.reset,
          },
        });
      }

      // Handle successful/failed request tracking
      if (skipSuccessfulRequests || skipFailedRequests) {
        const originalSend = res.send;
        
        res.send = function (body) {
          const isSuccess = res.statusCode >= 200 && res.statusCode < 400;
          
          if ((skipSuccessfulRequests && isSuccess) || 
              (skipFailedRequests && !isSuccess)) {
            // Decrement counter
            redisClient.decr(redisKey);
          }
          
          return originalSend.call(this, body);
        };
      }

      next();
    } catch (error) {
      // If Redis fails, allow request (fail-open) but log error
      console.error('Rate limiter error:', error);
      next();
    }
  };
};

/**
 * Create multiple rate limiters for different routes
 */
const createRateLimiters = () => {
  return {
    // Strict limiter for authentication routes (IP + login email so shared IPs are not over-throttled)
    auth: createRateLimiter({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 10, // 10 attempts
      keyPrefix: 'ratelimit:auth',
      skip: (req) => req.method === 'GET',
      keyGenerator: (req) => {
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        const raw =
          req.body && typeof req.body.email === 'string' ? req.body.email : '';
        const email = raw.toLowerCase().trim();
        return `${ip}:${email}`;
      },
      handler: (req, res, meta = {}) => {
        res.status(429).json({
          success: false,
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many authentication attempts, please try again later',
          retry_after: meta.retryAfter ?? 0,
        });
      },
    }),

    // General API limiter
    api: createRateLimiter({
      windowMs: 60 * 1000, // 1 minute
      max: 100, // 100 requests per minute
      keyPrefix: 'ratelimit:api',
      limitBy: 'user',
      skip: (req) => req.path.startsWith('/auth') || req.path.startsWith('/v1/auth'),
    }),

    // Stricter limiter for write operations
    write: createRateLimiter({
      windowMs: 60 * 1000, // 1 minute
      max: 30, // 30 writes per minute
      keyPrefix: 'ratelimit:write',
      limitBy: 'user',
    }),

    // Limiter for search/expensive queries
    search: createRateLimiter({
      windowMs: 60 * 1000, // 1 minute
      max: 20, // 20 searches per minute
      keyPrefix: 'ratelimit:search',
      limitBy: 'user',
    }),

    // File upload limiter
    upload: createRateLimiter({
      windowMs: 60 * 1000, // 1 minute
      max: 10, // 10 uploads per minute
      keyPrefix: 'ratelimit:upload',
      limitBy: 'user',
    }),

    // Per-company limiter (for multi-tenant systems)
    company: createRateLimiter({
      windowMs: 60 * 1000, // 1 minute
      max: 200, // 200 requests per minute per company
      keyPrefix: 'ratelimit:company',
      limitBy: 'company',
    }),

    // IP-based strict limiter (prevents DDoS)
    strict: createRateLimiter({
      windowMs: 60 * 1000, // 1 minute
      max: 50, // 50 requests per minute per IP
      keyPrefix: 'ratelimit:strict',
      limitBy: 'ip',
    }),

    // Import rate limiter: 5 import jobs per hour per company
    import: createRateLimiter({
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 5,
      keyPrefix: 'ratelimit:import',
      limitBy: 'company',
      handler: (req, res, meta = {}) => {
        res.status(429).json({
          success: false,
          code: 'IMPORT_RATE_LIMIT_EXCEEDED',
          message: 'Maximum 5 import jobs per hour. Please try again later.',
          retry_after: meta.retryAfter ?? 0,
        });
      },
    }),

    // Export rate limiter: 20 exports per 15 minutes per company
    export: createRateLimiter({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 20,
      keyPrefix: 'ratelimit:export',
      limitBy: 'company',
      handler: (req, res, meta = {}) => {
        res.status(429).json({
          success: false,
          code: 'EXPORT_RATE_LIMIT_EXCEEDED',
          message: 'Maximum 20 exports per 15 minutes. Please try again later.',
          retry_after: meta.retryAfter ?? 0,
        });
      },
    }),
  };
};

/**
 * Get current rate limit status for a key
 * @param {string} key - The key to check
 * @param {string} prefix - Key prefix
 */
const getRateLimitStatus = async (key, prefix = 'ratelimit') => {
  try {
    const redisKey = `${prefix}:${key}`;
    const current = await redisClient.get(redisKey);
    const ttl = await redisClient.ttl(redisKey);
    
    return {
      current: parseInt(current) || 0,
      ttl: ttl,
      resetTime: Date.now() + (ttl * 1000),
    };
  } catch (error) {
    console.error('Error getting rate limit status:', error);
    return null;
  }
};

/**
 * Reset rate limit for a key (admin function)
 * @param {string} key - The key to reset
 * @param {string} prefix - Key prefix
 */
const resetRateLimit = async (key, prefix = 'ratelimit') => {
  try {
    const redisKey = `${prefix}:${key}`;
    await redisClient.del(redisKey);
    return true;
  } catch (error) {
    console.error('Error resetting rate limit:', error);
    return false;
  }
};

/**
 * Get rate limiter statistics
 */
const getRateLimitStats = async () => {
  try {
    const keys = await scanKeys('ratelimit:*');
    const stats = {
      totalRules: keys.length,
      keys: [],
    };

    // Sample first 10 keys
    const sampleKeys = keys.slice(0, 10);
    for (const key of sampleKeys) {
      const current = await redisClient.get(key);
      const ttl = await redisClient.ttl(key);
      stats.keys.push({
        key: key.replace(/ratelimit:/, ''),
        current: parseInt(current) || 0,
        ttl,
      });
    }

    return stats;
  } catch (error) {
    console.error('Error getting rate limit stats:', error);
    return null;
  }
};

module.exports = {
  createRateLimiter,
  createRateLimiters,
  getRateLimitStatus,
  resetRateLimit,
  getRateLimitStats,
};
