const v8 = require('v8');
const { redisClient, isRedisConfigured } = require('../config/redis');
const { buildAdvancedMetrics } = require('./systemMetricsService');

const API_VERSION = process.env.API_VERSION || 'v1';

/**
 * Heap usage ratio for memory.status (warning / critical thresholds).
 * Use V8's heap limit rather than heapTotal. heapTotal is only the currently
 * committed heap and can sit near heapUsed during normal operation.
 */
function memoryStatusFromRatio(ratio) {
  if (ratio >= 0.95) return 'critical';
  if (ratio >= 0.85) return 'warning';
  return 'ok';
}

function memoryStatusFromUsage(heapUsedMb, heapLimitMb) {
  const ratio = heapLimitMb > 0 ? heapUsedMb / heapLimitMb : 0;
  return memoryStatusFromRatio(ratio);
}

// ── Memory growth tracking ────────────────────────────────────────────────
const memoryHistory = []; // { timestamp, heap_used_mb, heap_total_mb }
const MAX_HISTORY = 60;   // Keep last 60 snapshots (~30 min at 30s interval)
const GROWTH_ALERT_MB = 50; // Log warning if heap grows >50MB between checks

function recordMemoryGrowth(memory) {
  const heapLimitMb = memory.heap_limit_mb || memory.heap_total_mb || 0;
  const heapUsedPercent = typeof memory.heap_used_percent === 'number'
    ? memory.heap_used_percent
    : Math.round(heapLimitMb > 0 ? (memory.heap_used_mb / heapLimitMb) * 100 : 0);
  const entry = {
    timestamp: Date.now(),
    heap_used_mb: memory.heap_used_mb,
    heap_total_mb: memory.heap_total_mb,
  };
  memoryHistory.push(entry);
  if (memoryHistory.length > MAX_HISTORY) memoryHistory.shift();

  // Detect sustained growth trend (last 3 readings vs previous 3)
  if (memoryHistory.length >= 6) {
    const recent = memoryHistory.slice(-3);
    const prior = memoryHistory.slice(-6, -3);
    const recentAvg = recent.reduce((s, e) => s + e.heap_used_mb, 0) / recent.length;
    const priorAvg = prior.reduce((s, e) => s + e.heap_used_mb, 0) / prior.length;
    const growth = recentAvg - priorAvg;
    if (growth > GROWTH_ALERT_MB) {
      console.warn(
        `[HEALTH] Heap growth detected: +${growth.toFixed(1)}MB over last ~90s ` +
        `(recent avg ${recentAvg.toFixed(1)}MB, prior avg ${priorAvg.toFixed(1)}MB). ` +
        `Current: ${memory.heap_used_mb.toFixed(1)}MB / ${heapLimitMb.toFixed(1)}MB ` +
        `(${heapUsedPercent}%)`
      );
    }
  }

  // Log critical memory state
  if (memory.status === 'critical') {
    console.error(
      `[HEALTH] CRITICAL memory: ${memory.heap_used_mb.toFixed(1)}MB used / ` +
      `${heapLimitMb.toFixed(1)}MB limit (${heapUsedPercent}%). ` +
      `RSS: ${memory.rss_mb.toFixed(1)}MB. ` +
      `Recommend: restart process or enable --max-old-space-size with leak investigation.`
    );
  }
}

function getMemoryTrend() {
  if (memoryHistory.length < 2) return null;
  const first = memoryHistory[0];
  const last = memoryHistory[memoryHistory.length - 1];
  const durationSec = Math.round((last.timestamp - first.timestamp) / 1000);
  const growth = last.heap_used_mb - first.heap_used_mb;
  const rate = durationSec > 0 ? (growth / durationSec) * 60 : 0; // MB/min
  return {
    duration_sec: durationSec,
    growth_mb: Math.round(growth * 100) / 100,
    rate_mb_per_min: Math.round(rate * 100) / 100,
    readings: memoryHistory.length,
  };
}

function buildMemorySnapshot(usage = process.memoryUsage(), heapStats = v8.getHeapStatistics()) {
  const heap_used_mb = Math.round((usage.heapUsed / 1024 / 1024) * 100) / 100;
  const heap_total_mb = Math.round((usage.heapTotal / 1024 / 1024) * 100) / 100;
  const heap_limit_mb = Math.round(((heapStats.heap_size_limit || usage.heapTotal) / 1024 / 1024) * 100) / 100;
  const rss_mb = Math.round((usage.rss / 1024 / 1024) * 100) / 100;
  const ratio = heap_limit_mb > 0 ? heap_used_mb / heap_limit_mb : 0;
  return {
    heap_used_mb,
    heap_total_mb,
    heap_limit_mb,
    heap_used_percent: Math.round(ratio * 100),
    rss_mb,
    status: memoryStatusFromRatio(ratio),
  };
}

/**
 * DB ping; returns { status, ping_ms }.
 */
async function checkDatabase() {
  const start = Date.now();

  // PostgreSQL is the system of record: it is what "the database is up" means.
  // PostgreSQL is the system of record. Keeping this probe on Prisma avoids
  // waking or waiting on legacy MongoDB for every uptime check.
  try {
    const { prisma } = require('../lib/prisma');
    await prisma.$queryRaw`SELECT 1`;
    const ping_ms = Date.now() - start;
    const result = { status: 'ok', ping_ms, engine: 'postgresql' };

    return result;
  } catch (e) {
    return {
      status: 'error',
      ping_ms: Math.max(0, Date.now() - start),
      engine: 'postgresql',
      error: e.message,
    };
  }
}

/**
 * Redis / cache. The API can only run without it through the explicit
 * PERFORMANCE_REQUIRE_REDIS=false compatibility opt-out.
 */
async function checkCache() {
  if (!isRedisConfigured()) {
    return { status: 'ok' };
  }
  try {
    if (typeof redisClient.ping === 'function') {
      await redisClient.ping();
    } else if (typeof redisClient.get === 'function') {
      await redisClient.get('__health_check__');
    }
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error' };
  }
}

/**
 * Overall status: down = DB unreachable; degraded = slow DB, cache down, or memory warning/critical.
 */
function computeOverallStatus({ database, memory, cache }) {
  if (database.status === 'error') return 'down';
  let degraded = false;
  if (database.ping_ms > 100) degraded = true;
  if (cache.status === 'error') degraded = true;
  if (memory.status === 'warning' || memory.status === 'critical') degraded = true;
  if (degraded) return 'degraded';
  return 'ok';
}

function httpStatusForOverall(overall) {
  return overall === 'down' ? 503 : 200;
}

/**
 * Full system health payload (no secrets).
 * Uses module.exports for sub-checks so tests can jest.spyOn exports.
 */
async function buildSystemHealthSnapshot(deps = {}) {
  const memoryUsage = deps.memoryUsage || process.memoryUsage.bind(process);
  const [database, cache] = await Promise.all([
    deps.checkDatabase ? deps.checkDatabase() : module.exports.checkDatabase(),
    deps.checkCache ? deps.checkCache() : module.exports.checkCache(),
  ]);
  const memory = deps.buildMemorySnapshot
    ? deps.buildMemorySnapshot(memoryUsage())
    : module.exports.buildMemorySnapshot(memoryUsage());
  recordMemoryGrowth(memory);
  const overall = computeOverallStatus({ database, memory, cache });

  // Gather advanced metrics in parallel (don't fail health check if they error)
  let advanced = null;
  try {
    advanced = await buildAdvancedMetrics(memory);
  } catch (e) {
    console.warn('[HEALTH] Advanced metrics failed:', e.message);
  }

  return {
    status: overall,
    version: API_VERSION.startsWith('v') ? API_VERSION : `v${API_VERSION}`,
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    database,
    memory,
    cache,
    memory_trend: getMemoryTrend(),
    httpStatus: httpStatusForOverall(overall),
    metrics: advanced,
  };
}

module.exports = {
  buildSystemHealthSnapshot,
  buildMemorySnapshot,
  checkDatabase,
  checkCache,
  computeOverallStatus,
  memoryStatusFromRatio,
  memoryStatusFromUsage,
  httpStatusForOverall,
  getMemoryTrend,
  recordMemoryGrowth,
};
