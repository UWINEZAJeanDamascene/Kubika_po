const { redisClient, isRedisConfigured } = require('../config/redis');
const persistentMetrics = require('./performanceMetricsStore');

// Cache configuration
const DEFAULT_TTL = 300; // 5 minutes default
const CACHE_PREFIX = 'cache:';
const CACHE_LOCK_PREFIX = `${CACHE_PREFIX}lock:`;
const CACHE_LOCK_TIMEOUT_MS = Math.max(1000, Number(process.env.CACHE_STAMPEDE_LOCK_MS || 15000));
const CACHE_LOCK_WAIT_MS = Math.max(100, Number(process.env.CACHE_STAMPEDE_WAIT_MS || 5000));
const CACHE_LOCK_POLL_MS = Math.max(25, Number(process.env.CACHE_STAMPEDE_POLL_MS || 100));
const CACHE_MAX_RESPONSE_BYTES = Math.max(1024, Number(process.env.CACHE_MAX_RESPONSE_BYTES || 2 * 1024 * 1024));
const CACHE_ALERT_MIN_LOOKUPS = Math.max(1, Number(process.env.CACHE_ALERT_MIN_LOOKUPS || 100));
const CACHE_ALERT_THRESHOLD_PERCENT = Math.min(100, Math.max(0, Number(process.env.CACHE_ALERT_HIT_RATIO_THRESHOLD_PERCENT || 50)));
const CACHE_ALERT_TYPES = new Set(
  String(process.env.CACHE_ALERT_TYPES || 'report,dashboard,stock,product')
    .split(',')
    .map((type) => type.trim())
    .filter(Boolean),
);
const CACHE_ALERT_COOLDOWN_MS = Math.max(30000, Number(process.env.CACHE_ALERT_COOLDOWN_MS || 15 * 60 * 1000));
const singleFlights = new Map();
const emittedCacheAlerts = new Map();

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function lockToken() {
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

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
  // Dashboard payloads are Redis-backed; keep the same five-minute default
  // across the dedicated dashboard services and the generic cache layer.
  dashboard: { ttl: 300, prefix: 'dashboard' },
  // Stock levels - 1 minute
  stock: { ttl: 60, prefix: 'stock' },
  // Supplier/client master data feeds the high-frequency form pickers.
  supplier: { ttl: 300, prefix: 'supplier' },
  client: { ttl: 300, prefix: 'client' },
  // Reference data — read on nearly every screen, changed rarely. Each type
  // gets its own prefix so invalidating one does not clear the others (an
  // unknown type falls back to `default`, where they would all collide).
  warehouse: { ttl: 600, prefix: 'warehouse' },
  department: { ttl: 600, prefix: 'department' },
  asset_category: { ttl: 600, prefix: 'asset_category' },
  chart_of_accounts: { ttl: 600, prefix: 'chart_of_accounts' },
  account_mapping: { ttl: 600, prefix: 'account_mapping' },
  period: { ttl: 600, prefix: 'period' },
  // Currencies and rates change at most daily but are read constantly by every
  // multi-currency screen.
  currency: { ttl: 3600, prefix: 'currency', scope: 'global' },
  exchange_rate: { ttl: 3600, prefix: 'exchange_rate', scope: 'tenant' },
  // Budgets: heavily read (74 endpoints) and edited in bursts during planning.
  // Short TTL because budget-vs-actual moves whenever a transaction posts.
  budget: { ttl: 300, prefix: 'budget' },
  // Reports - 15 minutes while open; closed-period entries are promoted to
  // persistent Redis keys by cacheMiddleware and invalidated on reopen.
  report: { ttl: 900, prefix: 'report' },
  // Financial ratios API — 5 minutes (dashboard widget uses Redis separately)
  financial_ratios: { ttl: 300, prefix: 'financial_ratios' },
  // Hot transactional read paths. Writes invalidate the whole tenant namespace.
  sales_order: { ttl: 30, prefix: 'sales_order' },
  invoice: { ttl: 60, prefix: 'invoice' },
  pos: { ttl: 60, prefix: 'pos' },
  stock_transfer: { ttl: 30, prefix: 'stock_transfer' },
  pick_pack: { ttl: 30, prefix: 'pick_pack' },
  general_ledger: { ttl: 60, prefix: 'general_ledger' },
  general_ledger_summary: { ttl: 60, prefix: 'general_ledger_summary' },
  // Default
  default: { ttl: DEFAULT_TTL, prefix: 'default' },
};

// ── Hit-ratio instrumentation ───────────────────────────────────────────
//
// A hit ratio sliding from 90% to 40% is the most common cause of a gradual,
// unexplained slowdown, and today it is invisible. Counters are per cache type
// so a single misbehaving type is distinguishable from a Redis-wide problem.
const cacheStats = new Map(); // type -> { hits, misses, errors }

/** Type is the segment after the `cache:` prefix, e.g. cache:product:CID:hash. */
function cacheTypeOf(key) {
  const parts = String(key || '').split(':');
  return parts.length > 1 ? parts[1] : 'unknown';
}

function recordCacheEvent(key, outcome) {
  const type = cacheTypeOf(key);
  let s = cacheStats.get(type);
  if (!s) {
    s = { hits: 0, misses: 0, errors: 0, skipped: 0 };
    cacheStats.set(type, s);
  }
  if (outcome === 'hit') s.hits++;
  else if (outcome === 'miss') s.misses++;
  else if (outcome === 'skip') s.skipped++;
  else s.errors++;
  persistentMetrics.recordCacheEvent(type, outcome);
}

/** Hit ratio overall and per type, worst ratio first. */
function getCacheMetrics() {
  let hits = 0;
  let misses = 0;
  let errors = 0;
  const byType = [];
  let skipped = 0;
  for (const [type, s] of cacheStats) {
    hits += s.hits;
    misses += s.misses;
    errors += s.errors;
    skipped += s.skipped || 0;
    const lookups = s.hits + s.misses;
    byType.push({
      type,
      hits: s.hits,
      misses: s.misses,
      errors: s.errors,
      skipped: s.skipped || 0,
      hit_ratio: lookups ? Math.round((s.hits / lookups) * 1000) / 10 : null,
    });
  }
  byType.sort((a, b) => (a.hit_ratio ?? 101) - (b.hit_ratio ?? 101));
  const lookups = hits + misses;
  return {
    hits,
    misses,
    errors,
    skipped,
    hit_ratio: lookups ? Math.round((hits / lookups) * 1000) / 10 : null,
    by_type: byType,
  };
}

const CACHE_GET_TIMEOUT_MS = Number(process.env.REDIS_CACHE_GET_TIMEOUT_MS || 500);
const CACHE_WRITE_TIMEOUT_MS = Number(process.env.REDIS_CACHE_WRITE_TIMEOUT_MS || 500);

function withCacheTimeout(promise, fallback = null, timeoutMs = CACHE_GET_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

function cacheTypeFromKey(key) {
  return cacheTypeOf(key);
}

function cacheAlertRows(metrics) {
  const rows = Array.isArray(metrics?.by_type) ? metrics.by_type : [];
  return rows
    .filter((row) => CACHE_ALERT_TYPES.has(String(row.type)) && (row.hits || 0) + (row.misses || 0) >= CACHE_ALERT_MIN_LOOKUPS)
    .filter((row) => row.hit_ratio !== null && Number(row.hit_ratio) < CACHE_ALERT_THRESHOLD_PERCENT)
    .map((row) => ({
      type: String(row.type),
      hit_ratio: Number(row.hit_ratio),
      threshold_percent: CACHE_ALERT_THRESHOLD_PERCENT,
      lookups: Number(row.hits || 0) + Number(row.misses || 0),
      errors: Number(row.errors || 0),
    }));
}

function reportCacheAlerts(alerts) {
  if (!alerts.length) return;
  const now = Date.now();
  let Sentry = null;
  if (process.env.SENTRY_DSN) {
    try { Sentry = require('@sentry/node'); } catch (_) { /* optional telemetry */ }
  }
  for (const alert of alerts) {
    const lastEmitted = emittedCacheAlerts.get(alert.type) || 0;
    if (now - lastEmitted < CACHE_ALERT_COOLDOWN_MS) continue;
    emittedCacheAlerts.set(alert.type, now);
    const message = `[cache] ${alert.type} hit ratio ${alert.hit_ratio}% below ${alert.threshold_percent}% (${alert.lookups} lookups)`;
    if (Sentry && typeof Sentry.captureMessage === 'function') {
      Sentry.captureMessage(message, {
        level: 'warning',
        tags: { cache_type: alert.type, alert: 'cache_hit_ratio' },
        extra: alert,
      });
    } else {
      console.warn(message, alert);
    }
  }
}

async function releaseRedisLock(key, token) {
  if (!isRedisConfigured() || typeof redisClient.get !== 'function' || typeof redisClient.del !== 'function') return;
  try {
    const current = await withCacheTimeout(redisClient.get(key), null, CACHE_WRITE_TIMEOUT_MS);
    if (current === token) await withCacheTimeout(redisClient.del(key), null, CACHE_WRITE_TIMEOUT_MS);
  } catch (_) {
    // Lock expiry is the safety net; release failures must not affect the response.
  }
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
    // Global scope must hash to the same key for every caller. Stripping
    // companyId/company here too (not just at the cacheMiddleware call site)
    // means a future caller that accidentally passes both `scope: 'global'`
    // and a tenant id still gets one shared entry instead of a silent
    // per-tenant split that looks global but is not.
    if (params.scope === 'global') {
      const globalParams = { ...params, companyId: undefined, company: undefined };
      const hash = this.hashString(JSON.stringify(globalParams));
      return `${CACHE_PREFIX}${prefix}:global:${hash}`;
    }
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
  /** Hit/miss/error counters since process start, overall and per cache type. */
  getMetrics() {
    return getCacheMetrics();
  }

  async getAggregatedMetrics() {
    const metrics = await persistentMetrics.getCacheMetrics();
    const result = metrics || {
      ...getCacheMetrics(),
      scope: 'process-local',
      persistent: false,
    };
    const alerts = cacheAlertRows(result);
    reportCacheAlerts(alerts);
    return {
      ...result,
      alerts,
      alert_policy: {
        min_lookups: CACHE_ALERT_MIN_LOOKUPS,
        threshold_percent: CACHE_ALERT_THRESHOLD_PERCENT,
        types: [...CACHE_ALERT_TYPES],
      },
    };
  }

  async get(key) {
    try {
      const data = await withCacheTimeout(redisClient.get(key));
      if (!data) {
        recordCacheEvent(key, 'miss');
        return null;
      }
      recordCacheEvent(key, 'hit');
      return JSON.parse(data);
    } catch (error) {
      // Counted separately: an error is not a miss. A hit ratio quietly
      // collapsing because Redis is timing out looks identical to a cold cache
      // unless the two are distinguished.
      recordCacheEvent(key, 'error');
      console.error('Cache get error:', error);
      return null;
    }
  }

  async _tryAcquireLock(key, token) {
    if (!isRedisConfigured() || typeof redisClient.set !== 'function') return null;
    const lockKey = `${CACHE_LOCK_PREFIX}${this.hashString(key)}`;
    try {
      let result;
      try {
        result = await withCacheTimeout(
          redisClient.set(lockKey, token, 'PX', CACHE_LOCK_TIMEOUT_MS, 'NX'),
          null,
          CACHE_WRITE_TIMEOUT_MS,
        );
      } catch (_) {
        // Upstash uses an options object while ioredis uses command arguments.
        result = await withCacheTimeout(
          redisClient.set(lockKey, token, { px: CACHE_LOCK_TIMEOUT_MS, nx: true }),
          null,
          CACHE_WRITE_TIMEOUT_MS,
        );
      }
      return result === 'OK' || result === true;
    } catch (error) {
      console.error('Cache lock error:', error);
      return null;
    }
  }

  async _waitForCacheOrLock(key) {
    const lockKey = `${CACHE_LOCK_PREFIX}${this.hashString(key)}`;
    const deadline = Date.now() + CACHE_LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      const cached = await this.get(key);
      if (cached !== null) return cached;
      if (typeof redisClient.exists !== 'function') {
        await new Promise((resolve) => setTimeout(resolve, CACHE_LOCK_POLL_MS));
        continue;
      }
      const lockExists = await withCacheTimeout(redisClient.exists(lockKey), 0, CACHE_GET_TIMEOUT_MS);
      if (!lockExists) return undefined;
      await new Promise((resolve) => setTimeout(resolve, CACHE_LOCK_POLL_MS));
    }
    return undefined;
  }

  async withSingleFlight(key, work) {
    const current = singleFlights.get(key);
    if (current) {
      await current.promise.catch(() => {});
      const cached = await this.get(key);
      return cached !== null ? { data: cached, fromCache: true } : work();
    }

    const token = lockToken();
    const distributed = await this._tryAcquireLock(key, token);
    if (distributed === false) {
      const cached = await this._waitForCacheOrLock(key);
      if (cached !== undefined) return { data: cached, fromCache: true };
    }

    const flight = deferred();
    singleFlights.set(key, flight);
    try {
      return await work();
    } finally {
      singleFlights.delete(key);
      flight.resolve();
      if (distributed === true) {
        await releaseRedisLock(`${CACHE_LOCK_PREFIX}${this.hashString(key)}`, token);
      }
    }
  }

  /**
   * Request middleware helper. Followers wait for the owner to populate the
   * response cache; if the owner fails, the follower is allowed to recompute.
   */
  async beginRequestFlight(key) {
    const current = singleFlights.get(key);
    if (current) {
      const cached = await this._waitForCacheOrLock(key);
      return { acquired: false, cached };
    }
    const token = lockToken();
    const distributed = await this._tryAcquireLock(key, token);
    if (distributed === false) {
      const cached = await this._waitForCacheOrLock(key);
      if (cached !== undefined) return { acquired: false, cached };
    }
    const flight = deferred();
    singleFlights.set(key, { ...flight, token, distributed });
    return {
      acquired: true,
      release: async () => {
        if (singleFlights.get(key)?.promise === flight.promise) singleFlights.delete(key);
        flight.resolve();
        if (distributed === true) {
          await releaseRedisLock(`${CACHE_LOCK_PREFIX}${this.hashString(key)}`, token);
        }
      },
    };
  }

  /**
   * Set cached data with TTL
   * @param {string} key - Cache key
   * @param {any} data - Data to cache
   * @param {number} ttl - Time to live in seconds
   */
  async set(key, data, ttl = DEFAULT_TTL) {
    try {
      // `ttl === 0` means immutable/persistent. Closed-period reports use a
      // plain Redis SET so the result survives process restarts and never
      // expires until the report namespace is invalidated after a reopen.
      const numericTtl = ttl === null || ttl === undefined ? DEFAULT_TTL : Number(ttl);
      const payload = JSON.stringify(data);
      if (Buffer.byteLength(payload, 'utf8') > CACHE_MAX_RESPONSE_BYTES) {
        recordCacheEvent(key, 'skip');
        return false;
      }
      const write = numericTtl === 0
        ? redisClient.set(key, payload)
        : redisClient.setex(
          key,
          Number.isFinite(numericTtl) && numericTtl > 0 ? Math.ceil(numericTtl) : DEFAULT_TTL,
          payload,
        );
      // Bound direct callers too; cache failure must not become API latency.
      await withCacheTimeout(write, null, CACHE_WRITE_TIMEOUT_MS);
      return true;
    } catch (error) {
      recordCacheEvent(key, 'error');
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
    const ttl = customTTL === null || customTTL === undefined ? config.ttl : customTTL;

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
    // 'budget' belongs here because budget-vs-actual consumption is derived
    // from posted transactions: a journal entry changes the answer even though
    // nothing under /api/budgets was written, so route-level invalidation alone
    // would leave those figures stale.
    for (const t of ['report', 'financial_ratios', 'general_ledger', 'general_ledger_summary', 'budget']) {
      total += await this.invalidateByCompany(companyId, t);
    }
    return total;
  }

  /**
   * Product/stock browse caches. `Product.currentStock` is a denormalized
   * field mutated directly by GRN confirmation, purchase receipt, delivery-note
   * confirm/cancel, and credit-note (goods-return) confirm — none of which
   * write through `/api/products` or `/api/stock/*`, so the route-level
   * invalidation middleware on those routes never fires for them. Call this
   * alongside `bumpCompanyFinancialCaches` at every place that mutates stock
   * outside its own cached route, or the product/stock list can keep serving
   * a pre-commit quantity for up to the cache TTL (120s/60s).
   */
  async bumpCompanyStockCaches(companyId) {
    try {
      await this.invalidateByCompany(companyId, 'product');
    } catch (e) {
      console.error('Product cache invalidation failed:', e);
    }
    try {
      await this.invalidateByCompany(companyId, 'stock');
    } catch (e) {
      console.error('Stock cache invalidation failed:', e);
    }
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
    const cacheTTL = ttl === null || ttl === undefined ? config.ttl : ttl;
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
        metrics: await this.getAggregatedMetrics(),
        storage: persistentMetrics.getStorageStatus(),
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
      const cacheTTL = ttl === null || ttl === undefined ? config.ttl : ttl;
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
