const redisCache = require('../utils/redisCache');
const { isRedisConfigured } = require('../config/redis');

const CACHE_PREFIX = 'dashboard:';
const DEFAULT_TTL_SECONDS = 60;

class DashboardCacheService {
  constructor() {
    this.store = new Map();
    this.defaultTTL = DEFAULT_TTL_SECONDS * 1000;
    this._cleanupTimer = setInterval(() => this._cleanup(true), 5 * 60 * 1000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  _key(companyId, dashboardName, params = '') {
    return `${CACHE_PREFIX}${companyId}:${dashboardName}:${params}`;
  }

  _cleanup(forceMax = false) {
    const now = Date.now();
    for (const [key, item] of this.store) {
      if (item.expiresAt < now) this.store.delete(key);
    }
  }

  async get(companyId, dashboardName, params = '') {
    if (!isRedisConfigured()) {
      const key = this._key(companyId, dashboardName, params);
      const item = this.store.get(key);
      if (!item || item.expiresAt < Date.now()) return null;
      return item.value;
    }

    const key = this._key(companyId, dashboardName, params);
    const data = await redisCache.get(key);
    return data;
  }

  async set(companyId, dashboardName, data, params = '', ttlMs = null) {
    const key = this._key(companyId, dashboardName, params);
    const ttlSeconds = ttlMs ? Math.max(1, Math.round(ttlMs / 1000)) : DEFAULT_TTL_SECONDS;

    if (!isRedisConfigured()) {
      this.store.set(key, { value: data, expiresAt: Date.now() + ttlSeconds * 1000 });
      return data;
    }

    await redisCache.set(key, data, ttlSeconds);
    return data;
  }

  async invalidate(companyId) {
    const pattern = `${CACHE_PREFIX}${companyId}:*`;
    if (!isRedisConfigured()) {
      for (const key of this.store.keys()) {
        if (key.startsWith(`${CACHE_PREFIX}${companyId}:`)) this.store.delete(key);
      }
      return;
    }
    await redisCache.clear(pattern);
  }

  async invalidateDashboard(companyId, dashboardName) {
    const pattern = `${CACHE_PREFIX}${companyId}:${dashboardName}:*`;
    if (!isRedisConfigured()) {
      for (const key of this.store.keys()) {
        if (key.startsWith(`${CACHE_PREFIX}${companyId}:${dashboardName}:`)) this.store.delete(key);
      }
      return;
    }
    await redisCache.clear(pattern);
  }

  async clearAll() {
    if (!isRedisConfigured()) {
      this.store.clear();
      return;
    }
    await redisCache.clear(`${CACHE_PREFIX}*`);
  }

  async getStats() {
    if (!isRedisConfigured()) {
      return { size: this.store.size, keys: Array.from(this.store.keys()) };
    }
    const keys = await redisCache.keys(`${CACHE_PREFIX}*`);
    return {
      size: keys.length,
      keys
    };
  }
}

const dashboardCache = new DashboardCacheService();
module.exports = dashboardCache;
