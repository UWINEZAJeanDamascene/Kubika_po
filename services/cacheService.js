const { redisClient } = require('../config/redis');

// Cache configuration
const DEFAULT_TTL = 300; // 5 minutes default
const CACHE_PREFIX = 'cache:';

// Cache configuration per model type
const CACHE_CONFIGS = {
  // Product caching - 2 minutes (frequently updated)
  product: { ttl: 120, prefix: 'product' },
  // Category caching - 10 minutes (rarely changes)
  category: { ttl: 600, prefix: 'category' },
  // Company caching - 5 minutes
  company: { ttl: 300, prefix: 'company' },
  // User caching - 5 minutes
  user: { ttl: 300, prefix: 'user' },
  // Dashboard stats - 1 minute (very dynamic)
  dashboard: { ttl: 60, prefix: 'dashboard' },
  // Stock levels - 1 minute
  stock: { ttl: 60, prefix: 'stock' },
  // Reports - 15 minutes (expensive queries); override with FINANCIAL_REPORT_CACHE_TTL_SECONDS
  report: { ttl: 900, prefix: 'report' },
  // Financial ratios API — 5 minutes (dashboard widget uses in-memory cache separately)
  financial_ratios: { ttl: 300, prefix: 'financial_ratios' },
  general_ledger: { ttl: 60, prefix: 'general_ledger' },
  general_ledger_summary: { ttl: 60, prefix: 'general_ledger_summary' },
  // Default
  default: { ttl: DEFAULT_TTL, prefix: 'default' },
};

const CACHE_GET_TIMEOUT_MS = Number(process.env.REDIS_CACHE_GET_TIMEOUT_MS || 500);

function withCacheTimeout(promise, fallback = null) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), CACHE_GET_TIMEOUT_MS)),
  ]);
}

class CacheService {
  // Helper to scan keys using SCAN to avoid expensive KEYS calls
  async scanKeys(pattern) {
    try {
      if (typeof redisClient.scan === 'function') {
        let cursor = '0';
        const results = [];
        do {
          const reply = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
          // reply can be [cursor, keys] or object depending on client
          if (Array.isArray(reply)) {
            cursor = reply[0];
            const keys = reply[1] || [];
            results.push(...keys);
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

      // Fallback to KEYS if SCAN isn't available
      return await redisClient.keys(pattern);
    } catch (error) {
      console.error('scanKeys error:', error);
      // fallback to keys
      try {
        return await redisClient.keys(pattern);
      } catch (e) {
        return [];
      }
    }
  }
  /**
   * Generate cache key from params
   * @param {string} prefix - Cache key prefix
   * @param {Object} params - Query parameters
   */
  /**
   * Keys include company id so invalidateByCompany can delete `prefix:companyId:*` without scanning hashes.
   */
  generateKey(prefix, params = {}) {
    const paramString = JSON.stringify(params);
    const hash = this.hashString(paramString);
    const cid =
      params.companyId != null
        ? String(params.companyId)
        : params.company != null
          ? String(params.company)
          : null;
    if (cid && cid !== 'undefined') {
      return `${CACHE_PREFIX}${prefix}:${cid}:${hash}`;
    }
    return `${CACHE_PREFIX}${prefix}:${hash}`;
  }

  /**
   * Simple hash function for cache keys
   * @param {string} str - String to hash
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Get cache configuration for a model type
   * @param {string} type - Model type
   */
  getCacheConfig(type) {
    const base = CACHE_CONFIGS[type] || CACHE_CONFIGS.default;
    if (type === 'report') {
      const ttl = parseInt(
        process.env.FINANCIAL_REPORT_CACHE_TTL_SECONDS || String(CACHE_CONFIGS.report.ttl),
        10
      );
      return { ...base, ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : CACHE_CONFIGS.report.ttl };
    }
    if (type === 'financial_ratios') {
      const ttl = parseInt(
        process.env.FINANCIAL_RATIOS_CACHE_TTL_SECONDS || String(CACHE_CONFIGS.financial_ratios.ttl),
        10
      );
      return {
        ...base,
        ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : CACHE_CONFIGS.financial_ratios.ttl,
      };
    }
    return base;
  }

  /**
   * Get cached data
   * @param {string} key - Cache key
   */
  async get(key) {
    try {
      const data = await withCacheTimeout(redisClient.get(key));
      if (!data) {
        return null;
      }
      return JSON.parse(data);
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  /**
   * Set cached data with TTL
   * @param {string} key - Cache key
   * @param {any} data - Data to cache
   * @param {number} ttl - Time to live in seconds
   */
  async set(key, data, ttl = DEFAULT_TTL) {
    try {
      await redisClient.setex(key, ttl, JSON.stringify(data));
      return true;
    } catch (error) {
      console.error('Cache set error:', error);
      return false;
    }
  }

  /**
   * Delete cached data
   * @param {string} key - Cache key
   */
  async delete(key) {
    try {
      await redisClient.del(key);
      return true;
    } catch (error) {
      console.error('Cache delete error:', error);
      return false;
    }
  }

  /**
   * Delete all keys matching a pattern
   * @param {string} pattern - Key pattern (e.g., 'cache:product:*')
   */
  async deletePattern(pattern) {
    try {
      const keys = await this.scanKeys(pattern);
      if (keys.length === 0) return 0;

      // Delete in chunks to avoid exceeding argument limits
      const chunkSize = 1000;
      let deleted = 0;
      for (let i = 0; i < keys.length; i += chunkSize) {
        const chunk = keys.slice(i, i + chunkSize);
        try {
          if (typeof redisClient.unlink === 'function') {
            await redisClient.unlink(...chunk);
          } else {
            await redisClient.del(...chunk);
          }
          deleted += chunk.length;
        } catch (e) {
          console.error('Error deleting chunk:', e);
        }
      }

      return deleted;
    } catch (error) {
      console.error('Cache delete pattern error:', error);
      return 0;
    }
  }

  /**
   * Cache a database query result
   * @param {string} type - Cache type (product, category, etc.)
   * @param {Object} params - Query parameters
   * @param {any} data - Data to cache
   * @param {number} customTTL - Custom TTL override
   */
  async cacheQuery(type, params, data, customTTL = null) {
    const config = this.getCacheConfig(type);
    const key = this.generateKey(config.prefix, params);
    const ttl = customTTL || config.ttl;

    await this.set(key, data, ttl);
    return key;
  }

  /**
   * Get cached query result
   * @param {string} type - Cache type
   * @param {Object} params - Query parameters
   */
  async getCachedQuery(type, params) {
    const config = this.getCacheConfig(type);
    const key = this.generateKey(config.prefix, params);
    return await this.get(key);
  }

  /**
   * Invalidate cache for a specific type and ID
   * @param {string} type - Cache type
   * @param {string} id - Entity ID
   */
  async invalidate(type, id) {
    const config = this.getCacheConfig(type);
    const pattern = `${CACHE_PREFIX}${config.prefix}:*${id}*`;
    return await this.deletePattern(pattern);
  }

  /**
   * Invalidate all cache for a type
   * @param {string} type - Cache type
   */
  async invalidateType(type) {
    const config = this.getCacheConfig(type);
    const pattern = `${CACHE_PREFIX}${config.prefix}:*`;
    return await this.deletePattern(pattern);
  }

  /**
   * Invalidate cache when data changes (by company)
   * @param {string} companyId - Company ID
   * @param {string} type - Cache type
   */
  async invalidateByCompany(companyId, type = null) {
    const cid = String(companyId);
    if (type) {
      const config = this.getCacheConfig(type);
      return await this.deletePattern(`${CACHE_PREFIX}${config.prefix}:${cid}:*`);
    }

    const seen = new Set();
    let totalDeleted = 0;
    for (const c of Object.values(CACHE_CONFIGS)) {
      if (!c || !c.prefix || seen.has(c.prefix)) continue;
      seen.add(c.prefix);
      totalDeleted += await this.deletePattern(`${CACHE_PREFIX}${c.prefix}:${cid}:*`);
    }
    return totalDeleted;
  }

  /** Trial balance, P&L, GL, ratios, etc. — Redis keys invalidated after journal post */
  async invalidateFinancialReportCaches(companyId) {
    let total = 0;
    for (const t of ['report', 'financial_ratios', 'general_ledger', 'general_ledger_summary']) {
      total += await this.invalidateByCompany(companyId, t);
    }
    return total;
  }

  /**
   * Redis financial/report keys + in-memory dashboard cache (executive, sales, inventory, …)
   */
  async bumpCompanyFinancialCaches(companyId) {
    try {
      await this.invalidateFinancialReportCaches(companyId);
    } catch (e) {
      console.error('Financial cache invalidation failed:', e);
    }
    try {
      const dashboardCache = require('./DashboardCacheService');
      await dashboardCache.invalidate(companyId);
    } catch (e) {
      console.error('Dashboard cache invalidation failed:', e);
    }
  }

  /**
   * Wrap a function with caching
   * @param {Function} fn - Function to execute
   * @param {string} type - Cache type
   * @param {Object} params - Query parameters for cache key
   * @param {number} ttl - Cache TTL
   * @param {boolean} useCompanyPrefix - Whether to include company in cache key
   */
  async cached(fn, type, params, ttl = null, useCompanyPrefix = true) {
    const config = this.getCacheConfig(type);
    const cacheParams = { ...params };
    
    // Include company in cache key if available
    if (useCompanyPrefix && params.companyId) {
      cacheParams.company = params.companyId;
    }

    const key = this.generateKey(config.prefix, cacheParams);

    // Try to get from cache first
    const cachedData = await this.get(key);
    if (cachedData !== null) {
      return { data: cachedData, fromCache: true };
    }

    // Execute function and cache result
    const data = await fn();
    const cacheTTL = ttl || config.ttl;
    await this.set(key, data, cacheTTL);

    return { data, fromCache: false };
  }

  /**
   * Get cache statistics
   */
  async getStats() {
    try {
      const info = await redisClient.info('memory');
      const keys = await this.scanKeys(`${CACHE_PREFIX}*`);

      return {
        totalKeys: keys.length,
        memoryUsed: info,
      };
    } catch (error) {
      console.error('Cache stats error:', error);
      return null;
    }
  }

  /**
   * Pre-warm cache with common queries
   * @param {Array} queries - Array of {type, params, data, ttl}
   */
  async preWarm(queries) {
    console.log('Pre-warming cache...');
    let warmed = 0;
    
    for (const query of queries) {
      try {
        await this.cacheQuery(query.type, query.params, query.data, query.ttl);
        warmed++;
      } catch (error) {
        console.error(`Error pre-warming cache for ${query.type}:`, error);
      }
    }

    console.log(`Cache pre-warmed: ${warmed}/${queries.length} entries`);
    return warmed;
  }

  /**
   * Middleware helper - Check cache before DB query
   * @param {string} type - Cache type
   * @param {Function} queryFn - Function to execute if cache miss
   * @param {Object} params - Query parameters
   * @param {Object} options - Cache options
   */
  async fetchOrExecute(type, queryFn, params, options = {}) {
    const { ttl = null, useCompanyPrefix = true, invalidateOnError = false } = options;

    const config = this.getCacheConfig(type);
    const cacheParams = { ...params };
    
    if (useCompanyPrefix && params.companyId) {
      cacheParams.company = params.companyId;
    }

    const key = this.generateKey(config.prefix, cacheParams);

    try {
      // Try cache first
      const cached = await this.get(key);
      if (cached !== null) {
        return { data: cached, fromCache: true };
      }

      // Cache miss - execute query
      const data = await queryFn();
      
      // Cache the result
      const cacheTTL = ttl || config.ttl;
      await this.set(key, data, cacheTTL);

      return { data, fromCache: false };
    } catch (error) {
      if (invalidateOnError) {
        await this.delete(key);
      }
      throw error;
    }
  }
}

module.exports = new CacheService();
