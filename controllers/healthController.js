const healthService = require('../services/healthService');
const { getHealthReport } = require('../services/accountingHealthService');
const redisCache = require('../utils/redisCache');
const v8 = require('v8');

const FALLBACK_VERSION = () => {
  const v = process.env.API_VERSION || 'v1';
  return v.startsWith('v') ? v : `v${v}`;
};

// GET /api/health, GET /health
exports.systemHealth = async (req, res) => {
  try {
    const snapshot = await healthService.buildSystemHealthSnapshot();
    const { httpStatus, ...body } = snapshot;
    res.status(httpStatus).json(body);
  } catch (e) {
    res.status(503).json({
      status: 'down',
      version: FALLBACK_VERSION(),
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      database: { status: 'error', ping_ms: 0 },
      memory: { heap_used_mb: 0, heap_total_mb: 0, heap_limit_mb: 0, heap_used_percent: 0, rss_mb: 0, status: 'ok' },
      cache: { status: 'ok' },
      memory_trend: null,
      metrics: null,
    });
  }
};

/**
 * GET /api/performance
 *
 * The performance block on its own — per-route p50/p95/p99, Apdex, cache hit
 * ratio and event-loop lag — without the database/collection statistics the
 * full health payload gathers. Cheap enough to poll, and it is what a baseline
 * capture reads.
 *
 * When Redis is configured, the returned counters are retained and aggregated
 * across API replicas. Development/test without Redis exposes the process
 * fallback and its storage status instead of silently claiming fleet coverage.
 */
exports.performanceMetrics = async (req, res) => {
  try {
    const {
      getAggregatedRequestMetrics,
      getAggregatedRouteMetrics,
      getAggregatedEventLoopMetrics,
      getPostgresPoolMetrics,
    } = require('../services/systemMetricsService');
    const cacheService = require('../services/cacheService');
    const persistentMetrics = require('../services/performanceMetricsStore');

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const [requests, routes, cache, eventLoop, databasePool] = await Promise.all([
      getAggregatedRequestMetrics(),
      getAggregatedRouteMetrics(limit),
      cacheService.getAggregatedMetrics(),
      getAggregatedEventLoopMetrics(),
      getPostgresPoolMetrics(),
    ]);

    res.json({
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      requests,
      routes,
      cache,
      event_loop_lag: eventLoop,
      database_pool: databasePool,
      storage: persistentMetrics.getStorageStatus(),
    });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
};

/** GET /api/performance/readiness — Phase 0 deployment/readiness signal. */
exports.performanceReadiness = async (_req, res) => {
  try {
    const { getPerformanceReadiness } = require('../services/performanceReadinessService');
    const readiness = await getPerformanceReadiness();
    res.status(readiness.ready ? 200 : 503).json({ timestamp: new Date().toISOString(), ...readiness });
  } catch (error) {
    res.status(503).json({ ready: false, failures: [error.message] });
  }
};
// GET /api/health/accounting
exports.accountingHealth = async (req, res, next) => {
  try {
    const companyId = req.company._id;
    const report = await getHealthReport(companyId);
    res.json({
      company_id: String(companyId),
      journal_balanced: !!(report.journal && report.journal.healthy),
      stock_reconciled: !!(report.stock && report.stock.healthy),
      checked_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/health/redis
exports.redisHealth = async (req, res) => {
  const start = Date.now();
  try {
    const health = await redisCache.healthCheck();
    const ttlTestKey = 'health:redis:ttl:test';
    let ttlOk = false;
    if (health.connected) {
      await redisCache.set(ttlTestKey, { ok: true }, 10);
      const got = await redisCache.get(ttlTestKey);
      ttlOk = got && got.ok === true;
      await redisCache.del(ttlTestKey);
    }
    const payload = {
      ...health,
      ping_ms: Date.now() - start,
      operations: {
        set_get_delete: ttlOk,
      },
    };
    const status = health.connected && ttlOk ? 200 : 503;
    res.status(status).json(payload);
  } catch (e) {
    res.status(503).json({ configured: true, connected: false, error: e.message });
  }
};

// POST /api/health/gc — hint to run GC if exposed; returns guidance either way
exports.gcHint = async (req, res) => {
  const before = process.memoryUsage();
  let gcRan = false;
  let message = '';

  if (global.gc && typeof global.gc === 'function') {
    try {
      global.gc();
      gcRan = true;
      message = 'Garbage collection executed successfully.';
    } catch (e) {
      message = `GC invocation failed: ${e.message}`;
    }
  } else {
    message = 'Manual GC is not exposed. Start Node.js with --expose-gc flag to enable this feature.';
  }

  const after = process.memoryUsage();
  const heapLimitMb = Math.round((v8.getHeapStatistics().heap_size_limit / 1024 / 1024) * 100) / 100;
  const freed = Math.round(((before.heapUsed - after.heapUsed) / 1024 / 1024) * 100) / 100;

  res.json({
    gc_ran: gcRan,
    message,
    heap_freed_mb: freed > 0 ? freed : 0,
    before: {
      heap_used_mb: Math.round((before.heapUsed / 1024 / 1024) * 100) / 100,
      heap_total_mb: Math.round((before.heapTotal / 1024 / 1024) * 100) / 100,
      heap_limit_mb: heapLimitMb,
      rss_mb: Math.round((before.rss / 1024 / 1024) * 100) / 100,
    },
    after: {
      heap_used_mb: Math.round((after.heapUsed / 1024 / 1024) * 100) / 100,
      heap_total_mb: Math.round((after.heapTotal / 1024 / 1024) * 100) / 100,
      heap_limit_mb: heapLimitMb,
      rss_mb: Math.round((after.rss / 1024 / 1024) * 100) / 100,
    },
  });
};
