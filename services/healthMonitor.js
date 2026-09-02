/**
 * Health Monitoring Service
 * Provides health status checks and integrates with monitoring services
 */

const { prisma } = require('../lib/prisma');
const { redisClient, isRedisConfigured } = require('../config/redis');

// Health status cache
let healthCache = null;
let lastCheck = null;
const CACHE_TTL = 30000; // 30 seconds

/**
 * Get system health status
 */
async function getSystemHealth() {
  const now = Date.now();
  
  // Return cached result if recent
  if (healthCache && lastCheck && (now - lastCheck) < CACHE_TTL) {
    return healthCache;
  }

  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {},
  };

  // PostgreSQL is the system of record and therefore the readiness authority.
  try {
    await prisma.$queryRaw`SELECT 1`;
    const { getPostgresPoolMetrics } = require('./systemMetricsService');
    const pool = await getPostgresPoolMetrics();
    health.services.postgresql = {
      status: pool.status === 'unavailable' ? 'unhealthy' : pool.status === 'pressured' ? 'degraded' : 'healthy',
      pool,
    };
    if (pool.status === 'pressured') health.status = 'degraded';
    if (pool.status === 'saturated' || pool.status === 'unavailable') health.status = 'unhealthy';
  } catch (err) {
    health.services.postgresql = {
      status: 'unhealthy',
      error: err.message,
    };
    health.status = 'unhealthy';
  }

  // Check Redis (if configured)
  try {
    if (isRedisConfigured()) {
      await redisClient.ping();
      health.services.redis = { status: 'healthy' };
    } else {
      health.services.redis = { status: 'not_configured', info: 'Redis not configured - running in non-cached mode' };
    }
  } catch (err) {
    health.services.redis = {
      status: 'unhealthy',
      error: err.message,
    };
    health.status = 'degraded';
  }

  // Check memory usage
  const memUsage = process.memoryUsage();
  const heapUsedPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
  
  health.services.memory = {
    status: heapUsedPercent > 90 ? 'unhealthy' : 'healthy',
    heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
    heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
    heapPercent: Math.round(heapUsedPercent) + '%',
  };
  
  if (heapUsedPercent > 90) {
    health.status = 'degraded';
  }

  // Overall status determination
  const serviceStatuses = Object.values(health.services).map(s => s.status);
  if (serviceStatuses.includes('unhealthy')) {
    health.status = 'unhealthy';
  } else if (serviceStatuses.includes('degraded')) {
    health.status = 'degraded';
  }

  // Cache result
  healthCache = health;
  lastCheck = now;

  return health;
}

/**
 * Get detailed health check for monitoring services
 * Includes more detailed info than standard health endpoint
 */
async function getDetailedHealth() {
  const basicHealth = await getSystemHealth();
  
  return {
    ...basicHealth,
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
    platform: process.platform,
    // Include specific component health
    components: {
      database: await checkDatabaseHealth(),
      cache: await checkCacheHealth(),
      external: await checkExternalServices(),
    },
  };
}

/**
 * Check database health in detail
 */
async function checkDatabaseHealth() {
  try {
    const startedAt = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    return {
      status: 'healthy',
      engine: 'postgresql',
      ping: 'success',
      latency: `${Date.now() - startedAt}ms`,
    };
  } catch (err) {
    return {
      status: 'unhealthy',
      error: err.message,
    };
  }
}

/**
 * Check cache/Redis health
 */
async function checkCacheHealth() {
  try {
    if (!isRedisConfigured()) {
      return { status: 'not_configured' };
    }
    
    const start = Date.now();
    await redisClient.ping();
    const latency = Date.now() - start;
    
    return {
      status: 'healthy',
      latency: `${latency}ms`,
    };
  } catch (err) {
    return {
      status: 'unhealthy',
      error: err.message,
    };
  }
}

/**
 * Check external services (placeholder for future checks)
 */
async function checkExternalServices() {
  const services = {
    email: { status: 'unknown' },
    storage: { status: 'unknown' },
    sms: { status: 'unknown' },
  };
  
  // Add checks as needed for external services
  // For now, just return unknown
  
  return services;
}

/**
 * Readiness check - for Kubernetes/Docker health checks
 * Returns 200 if ready to serve traffic, 503 if not
 */
async function getReadiness() {
  const health = await getSystemHealth();
  
  // PostgreSQL is the readiness authority; MongoDB may be absent after its
  // remaining legacy domains are migrated.
  if (health.services.postgresql?.status !== 'healthy') {
    return { ready: false, reason: 'PostgreSQL not ready' };
  }
  
  return { ready: true };
}

/**
 * Liveness check - for Kubernetes/Docker liveness probes
 */
function getLiveness() {
  return { 
    alive: true, 
    uptime: process.uptime(),
    pid: process.pid,
  };
}

module.exports = {
  getSystemHealth,
  getDetailedHealth,
  getReadiness,
  getLiveness,
  checkDatabaseHealth,
  checkCacheHealth,
};