const cacheService = require('./cacheService');
const { isRedisConfigured } = require('../config/redis');

// Use the shared cache namespace so cache metrics classify dashboard reads as
// `dashboard` and tenant invalidation can clear them consistently.
const CACHE_PREFIX = 'cache:dashboard:';
const configuredTtl = Number(process.env.DASHBOARD_CACHE_TTL_SECONDS || 300);
const DEFAULT_TTL_SECONDS = Number.isFinite(configuredTtl) ? Math.max(1, configuredTtl) : 300;

/**
 * Shared dashboard cache.
 *
 * Dashboard payloads are deliberately Redis-only. An in-process fallback would
 * make each API replica report a different dashboard and would hide cache
 * invalidation bugs during a rolling deploy. When Redis is unavailable the
 * normal cacheService degraded path returns a miss and the dashboard service
 * recomputes from PostgreSQL; readiness exposes that degraded state.
 */
class DashboardCacheService {
  _key(companyId, dashboardName, params = '') {
    return `${CACHE_PREFIX}${String(companyId)}:${String(dashboardName)}:${String(params)}`;
  }

  async get(companyId, dashboardName, params = '') {
    return cacheService.get(this._key(companyId, dashboardName, params));
  }

  async set(companyId, dashboardName, data, params = '', ttlMs = null) {
    const requestedTtl = Number(ttlMs);
    const ttlSeconds = ttlMs === null || ttlMs === undefined
      ? DEFAULT_TTL_SECONDS
      : Number.isFinite(requestedTtl) ? Math.max(1, Math.round(requestedTtl / 1000)) : DEFAULT_TTL_SECONDS;
    await cacheService.set(this._key(companyId, dashboardName, params), data, ttlSeconds);
    return data;
  }

  async invalidate(companyId) {
    return cacheService.deletePattern(`${CACHE_PREFIX}${String(companyId)}:*`);
  }

  async invalidateDashboard(companyId, dashboardName) {
    return cacheService.deletePattern(`${CACHE_PREFIX}${String(companyId)}:${String(dashboardName)}:*`);
  }

  async clearAll() {
    return cacheService.deletePattern(`${CACHE_PREFIX}*`);
  }

  async getStats() {
    const keys = await cacheService.scanKeys(`${CACHE_PREFIX}*`);
    return {
      size: keys.length,
      keys,
      persistent: isRedisConfigured(),
      metrics: await cacheService.getAggregatedMetrics(),
    };
  }
}

module.exports = new DashboardCacheService();
