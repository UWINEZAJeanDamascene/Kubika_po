const Redis = require('ioredis');
const { UpstashRedis } = (() => {
  try {
    // lazy require to avoid hard dependency if not installed
    return { UpstashRedis: require('@upstash/redis').Redis };
  } catch (e) {
    return {};
  }
})();

// Import centralized configuration
const env = require('../src/config/environment');
const config = env.getConfig();
const cacheConfig = config.cache;

// Redis configuration with connection pooling for high performance.
// Supports: Local Redis, Redis Cloud, Render Redis, Upstash, AWS ElastiCache, etc.
// Uses REDIS_URL if available, or UPSTASH_REDIS_REST_URL for Upstash serverless Redis.

// Redis is infrastructure for caching, sessions, and fleet-wide Phase 0
// metrics. The no-op client remains only as an explicit compatibility fallback
// for tests or PERFORMANCE_REQUIRE_REDIS=false; readiness rejects it otherwise.
const isRedisConfigured = () => cacheConfig.isConfigured;
const isRedisRequired = () => {
  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv === 'test') return false;
  const override = String(process.env.PERFORMANCE_REQUIRE_REDIS || '').trim().toLowerCase();
  return !['false', '0', 'no'].includes(override);
};

// Create a no-op client for when Redis is not available
const createNoOpClient = () => {
  const noOpClient = {
    // Methods that return promises
    get: async () => null,
    set: async () => 'OK',
    setex: async () => 'OK',
    del: async () => 0,
    keys: async () => [],
    scan: async () => ['0', []],
    exists: async () => 0,
    incr: async () => 1,
    decr: async () => 0,
    expire: async () => 0,
    ttl: async () => -1,
    incrby: async () => 1,
    getdel: async () => null,
    info: async () => '',
    rpush: async () => 1,
    lpush: async () => 1,
    lpop: async () => null,
    rpop: async () => null,
    llen: async () => 0,
    lrem: async () => 0,
    lrange: async () => [],
    
    // Event emitter methods (no-ops)
    on: () => {},
    off: () => {},
    emit: () => {},
    
    // Connection methods (no-ops)
    connect: async () => {},
    disconnect: async () => {},
    quit: async () => {},
    close: async () => {},
    
    // Properties
    status: 'disconnected',
    isReady: false,
    isConnecting: false,
  };
  
  return noOpClient;
};

const createRedisClient = () => {
  const redisConfig = {
    // Connection settings optimized for high throughput
    maxRetriesPerRequest: 5,
    retryStrategy: (times) => {
      if (times > 5) {
        console.error('Redis connection failed after 5 retries - giving up');
        return null; // Stop retrying
      }
      const delay = Math.min(times * 500, 5000);
      console.log(`Redis retry attempt ${times}/5, waiting ${delay}ms`);
      return delay;
    },
    enableReadyCheck: true,
    lazyConnect: false,
    // Performance optimizations
    family: 4, // IPv4
    keepAlive: true,
    connectTimeout: 10000,
    commandTimeout: 5000,
    // Reconnection settings
    reconnectOnError: (err) => {
      const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
      if (targetErrors.some(e => err.message.includes(e))) {
        return true; // Reconnect on these errors
      }
      return false;
    },
  };

  // Check if Redis is configured
  if (!isRedisConfigured()) {
    const message = 'Redis is not configured. Set REDIS_URL, UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or REDIS_HOST.';
    if (isRedisRequired()) {
      console.error(`[Phase 0] ${message} Boot readiness will fail.`);
    } else {
      console.warn(`[Phase 0] ${message} Using explicit process-local fallback.`);
    }
    return createNoOpClient();
  }

  // Check for Upstash Redis (serverless Redis with REST API)
  if (cacheConfig.upstashUrl && cacheConfig.upstashToken) {
    // Prefer the Upstash HTTP client for serverless Upstash endpoints
    if (UpstashRedis) {
      console.log('Using @upstash/redis (REST) client for Upstash');
      return new UpstashRedis({
        url: cacheConfig.upstashUrl,
        token: cacheConfig.upstashToken,
      });
    }

    // Fallback: if @upstash/redis not available, attempt ioredis with a compatible URL
    console.log('Using ioredis with UPSTASH_REDIS_REST_URL (ensure URL is Redis-compatible)');
    return new Redis(cacheConfig.upstashUrl, {
      ...redisConfig,
      password: cacheConfig.upstashToken,
    });
  }

  // Check for REDIS_URL (Render, Redis Cloud, Upstash legacy, etc.)
  if (cacheConfig.redisUrl) {
    console.log('Using REDIS_URL for connection (production mode)');
    return new Redis(cacheConfig.redisUrl, redisConfig);
  }

  // Check if running in cluster mode
  if (cacheConfig.clusterNodes) {
    const clusterNodes = cacheConfig.clusterNodes.map(node => {
      const [host, port] = node.split(':');
      return { host, port: parseInt(port) };
    });

    return new Redis.Cluster(clusterNodes, {
      ...redisConfig,
      redisOptions: {
        password: cacheConfig.redisPassword,
      },
    });
  }

  // Single Redis instance configuration (local/development)
  return new Redis({
    host: cacheConfig.redisHost,
    port: cacheConfig.redisPort,
    password: cacheConfig.redisPassword,
    db: cacheConfig.redisDb,
    ...redisConfig,
  });
};

// Create Redis client instance
const redisClient = createRedisClient();

// Event handlers for monitoring (only for clients that support EventEmitter style)
if (redisClient && typeof redisClient.on === 'function') {
  redisClient.on('connect', () => {
    console.log('Redis connected successfully');
  });

  redisClient.on('ready', () => {
    console.log('Redis client ready');
  });

  redisClient.on('error', (err) => {
    // Don't log error if Redis is not configured (we're using no-op client)
    if (isRedisConfigured()) {
      console.error('Redis error:', err && err.message ? err.message : err);
    }
  });

  redisClient.on('close', () => {
    console.log('Redis connection closed');
  });
} else {
  console.log('Redis client does not support event handlers (likely Upstash REST client or no-op).');
}

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('Closing Redis connection...');
  try {
    // Flush the Phase 0 buffer while Redis is still available. This prevents a
    // short shutdown window from losing the last request samples.
    try { await require('../services/performanceMetricsStore').flush(); } catch (e) {
      console.warn('Could not flush performance metrics during Redis shutdown:', e.message || e);
    }
    if (redisClient) {
      if (typeof redisClient.quit === 'function') {
        await redisClient.quit();
      } else if (typeof redisClient.disconnect === 'function') {
        await redisClient.disconnect();
      } else if (typeof redisClient.close === 'function') {
        await redisClient.close();
      } else if (typeof redisClient.flush === 'function') {
        // best-effort
        try { await redisClient.flush(); } catch (e) {}
      }
    }
  } catch (e) {
    console.error('Error while closing Redis client:', e);
  }

  process.exit(0);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Export the client and a function to get a new client if needed
/**
 * Dedicated connection for BullMQ.
 *
 * BullMQ refuses a client with `maxRetriesPerRequest` set — its workers use
 * blocking commands (BRPOPLPUSH) that must wait indefinitely rather than time
 * out and retry. The shared cache client sets it to 5, so passing that client
 * to a Worker throws "Your redis options maxRetriesPerRequest must be null".
 *
 * A separate connection is right regardless of that error: a blocking read on
 * the shared client would stall ordinary cache traffic behind it.
 *
 * Returns null when Redis is not configured, so callers can skip the queue.
 */
const createQueueConnection = () => {
  if (!isRedisConfigured()) return null;
  if (cacheConfig.upstashUrl && !cacheConfig.redisUrl && !process.env.REDIS_HOST && !cacheConfig.clusterNodes) {
    return null;
  }
  const options = {
    maxRetriesPerRequest: null,   // required by BullMQ
    enableReadyCheck: false,      // recommended for BullMQ connections
  };
  if (cacheConfig.redisUrl) return new Redis(cacheConfig.redisUrl, options);
  return new Redis({
    host: cacheConfig.redisHost,
    port: cacheConfig.redisPort,
    password: cacheConfig.redisPassword,
    db: cacheConfig.redisDb,
    ...options,
  });
};

module.exports = {
  redisClient,
  createRedisClient,
  createQueueConnection,
  isRedisConfigured,
  isRedisRequired,
  // Helper to get a client for specific operations (e.g., different DB)
  getClient: (db = 0) => {
    if (!isRedisConfigured()) {
      return createNoOpClient();
    }
    
    if (cacheConfig.redisUrl) {
      return new Redis(cacheConfig.redisUrl, { db });
    }
    if (cacheConfig.clusterNodes) {
      return redisClient; // Cluster mode uses same client
    }

    // If using Upstash REST and upstash client exists, return a new Upstash client
    if (cacheConfig.upstashUrl && cacheConfig.upstashToken && UpstashRedis) {
      return new UpstashRedis({ url: cacheConfig.upstashUrl, token: cacheConfig.upstashToken });
    }

    return new Redis({
      host: cacheConfig.redisHost,
      port: cacheConfig.redisPort,
      password: cacheConfig.redisPassword,
      db,
    });
  },
};
