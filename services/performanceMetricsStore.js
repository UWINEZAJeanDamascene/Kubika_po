/**
 * Durable Phase 0 metrics store.
 *
 * Request metrics are recorded in a short in-process buffer and flushed to Redis
 * in batches. This keeps the request path cheap while making counters and
 * rolling samples survive process restarts and aggregate across API replicas.
 * When Redis is not available the caller keeps its local fallback metrics; that
 * mode is exposed explicitly by getStorageStatus() and is rejected by the
 * Phase 0 readiness check outside tests/explicit opt-out.
 */

const crypto = require('crypto');
const { redisClient, isRedisConfigured } = require('../config/redis');

const KEY_PREFIX = String(process.env.PERFORMANCE_METRICS_KEY_PREFIX || 'metrics:performance:v1').replace(/:+$/, '');
const RETENTION_SECONDS = Math.max(300, Number(process.env.PERFORMANCE_METRICS_RETENTION_SECONDS || 7 * 24 * 60 * 60));
const FLUSH_INTERVAL_MS = Math.max(50, Number(process.env.PERFORMANCE_METRICS_FLUSH_INTERVAL_MS || 250));
const MAX_REQUEST_SAMPLES = Math.max(20, Number(process.env.PERFORMANCE_METRICS_MAX_SAMPLES || 200));
const MAX_ROUTE_SAMPLES = Math.max(20, Number(process.env.PERFORMANCE_METRICS_MAX_ROUTE_SAMPLES || 100));
const MAX_ROUTES = Math.max(20, Number(process.env.METRICS_MAX_ROUTES || 200));
const MAX_BATCH_SAMPLES = Math.max(100, Number(process.env.PERFORMANCE_METRICS_MAX_BATCH_SAMPLES || 5000));

const REQUESTS_KEY = `${KEY_PREFIX}:requests`;
const REQUEST_SAMPLES_KEY = `${KEY_PREFIX}:request-samples`;
const ROUTE_INDEX_KEY = `${KEY_PREFIX}:route-index`;
const ROUTE_KEY_PREFIX = `${KEY_PREFIX}:route`;
const CACHE_KEY = `${KEY_PREFIX}:cache`;
const CACHE_TYPE_INDEX_KEY = `${KEY_PREFIX}:cache-type-index`;
const CACHE_TYPE_KEY_PREFIX = `${KEY_PREFIX}:cache-type`;
const EVENT_LOOP_SAMPLES_KEY = `${KEY_PREFIX}:event-loop-samples`;

const health = {
  flushes: 0,
  writeFailures: 0,
  readFailures: 0,
  lastFlushAt: null,
  lastError: null,
};

function createPending() {
  return {
    requests: { count: 0, errors: 0, totalMs: 0, slowCount: 0, samples: [] },
    routes: new Map(),
    cache: { hits: 0, misses: 0, errors: 0, types: new Map() },
    eventLoopSamples: [],
  };
}

let pending = createPending();
let flushTimer = null;
let flushPromise = null;

function enabled() {
  return Boolean(
    isRedisConfigured()
      && redisClient
      && typeof redisClient.hincrby === 'function'
      && typeof redisClient.lpush === 'function'
      && typeof redisClient.expire === 'function',
  );
}

function routeIdFor(route) {
  return crypto.createHash('sha1').update(String(route)).digest('hex');
}

function routeKey(routeId, suffix) {
  return `${ROUTE_KEY_PREFIX}:${routeId}:${suffix}`;
}

function cacheTypeKey(type) {
  return `${CACHE_TYPE_KEY_PREFIX}:${String(type || 'unknown')}`;
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMs(value) {
  return Math.max(0, Math.round(toFiniteNumber(value)));
}

function parseHash(value) {
  if (!value || typeof value !== 'object') return {};
  return value;
}

function parseSample(value) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_) {
    return null;
  }
}


function scheduleFlush() {
  if (!enabled() || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(() => {});
  }, FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function recordRequest({ durationMs, statusCode, route }) {
  if (!enabled()) return;
  const duration = roundMs(durationMs);
  const status = Number(statusCode) || 500;
  const sample = { timestamp: Date.now(), durationMs: duration, statusCode: status };
  const stats = pending.requests;
  stats.count += 1;
  stats.totalMs += duration;
  if (duration > 500) stats.slowCount += 1;
  if (status >= 400) stats.errors += 1;
  if (stats.samples.length < MAX_BATCH_SAMPLES) stats.samples.push(sample);

  if (route) {
    const routeLabel = String(route);
    const routeId = routeIdFor(routeLabel);
    let entry = pending.routes.get(routeId);
    if (!entry) {
      if (pending.routes.size >= MAX_ROUTES) {
        scheduleFlush();
        return;
      }
      entry = { routeId, route: routeLabel, count: 0, errors: 0, totalMs: 0, samples: [] };
      pending.routes.set(routeId, entry);
    }
    entry.count += 1;
    entry.totalMs += duration;
    if (status >= 400) entry.errors += 1;
    if (entry.samples.length < MAX_BATCH_SAMPLES) entry.samples.push(sample);
  }
  scheduleFlush();
}

function recordCacheEvent(type, outcome) {
  if (!enabled()) return;
  const normalizedType = String(type || 'unknown');
  const key = outcome === 'hit' ? 'hits' : outcome === 'miss' ? 'misses' : 'errors';
  pending.cache[key] += 1;
  let stats = pending.cache.types.get(normalizedType);
  if (!stats) {
    stats = { hits: 0, misses: 0, errors: 0 };
    pending.cache.types.set(normalizedType, stats);
  }
  stats[key] += 1;
  scheduleFlush();
}

function recordEventLoopSample(value) {
  if (!enabled()) return;
  if (pending.eventLoopSamples.length < MAX_BATCH_SAMPLES) {
    pending.eventLoopSamples.push({ timestamp: Date.now(), value: toFiniteNumber(value) });
  }
  scheduleFlush();
}

function addCommand(pipeline, directCommands, method, args) {
  if (pipeline && typeof pipeline[method] === 'function') {
    pipeline[method](...args);
    return;
  }
  if (typeof redisClient[method] === 'function') {
    directCommands.push(() => redisClient[method](...args));
  }
}

function addCounterCommands(pipeline, directCommands, key, stats) {
  if (!stats) return;
  for (const [field, value] of Object.entries(stats)) {
    if (!value) continue;
    // Durations are rounded before recording, so integer Redis counters are
    // sufficient and work identically with ioredis and Upstash REST clients.
    addCommand(pipeline, directCommands, 'hincrby', [key, field, value]);
  }
  addCommand(pipeline, directCommands, 'expire', [key, RETENTION_SECONDS]);
}

function addSamplesCommands(pipeline, directCommands, key, samples, maxSamples) {
  for (const sample of samples || []) {
    addCommand(pipeline, directCommands, 'lpush', [key, JSON.stringify(sample)]);
  }
  if (samples && samples.length) {
    addCommand(pipeline, directCommands, 'ltrim', [key, 0, maxSamples - 1]);
    addCommand(pipeline, directCommands, 'expire', [key, RETENTION_SECONDS]);
  }
}

async function trimRouteIndex() {
  if (typeof redisClient.smembers !== 'function' || typeof redisClient.srem !== 'function') return;
  const members = await redisClient.smembers(ROUTE_INDEX_KEY);
  if (!Array.isArray(members) || members.length <= MAX_ROUTES) return;
  const stale = members.slice(MAX_ROUTES);
  await redisClient.srem(ROUTE_INDEX_KEY, ...stale);
  if (typeof redisClient.del === 'function') {
    await Promise.all(stale.flatMap((id) => [
      redisClient.del(routeKey(id, 'stats')),
      redisClient.del(routeKey(id, 'samples')),
      redisClient.del(routeKey(id, 'label')),
    ]));
  }
}

async function flush() {
  if (!enabled()) return false;
  if (flushPromise) return flushPromise;

  const batch = pending;
  pending = createPending();
  if (
    batch.requests.count === 0
    && batch.routes.size === 0
    && batch.cache.hits === 0
    && batch.cache.misses === 0
    && batch.cache.errors === 0
    && batch.eventLoopSamples.length === 0
  ) return true;

  flushPromise = (async () => {
    const directCommands = [];
    const pipeline = typeof redisClient.pipeline === 'function' ? redisClient.pipeline() : null;

    addCounterCommands(pipeline, directCommands, REQUESTS_KEY, {
      count: batch.requests.count,
      errors: batch.requests.errors,
      totalMs: batch.requests.totalMs,
      slowCount: batch.requests.slowCount,
    });
    addSamplesCommands(pipeline, directCommands, REQUEST_SAMPLES_KEY, batch.requests.samples, MAX_REQUEST_SAMPLES);

    for (const entry of batch.routes.values()) {
      addCommand(pipeline, directCommands, 'sadd', [ROUTE_INDEX_KEY, entry.routeId]);
      addCommand(pipeline, directCommands, 'setex', [routeKey(entry.routeId, 'label'), RETENTION_SECONDS, entry.route]);
      addCounterCommands(pipeline, directCommands, routeKey(entry.routeId, 'stats'), {
        count: entry.count,
        errors: entry.errors,
        totalMs: entry.totalMs,
      });
      addSamplesCommands(pipeline, directCommands, routeKey(entry.routeId, 'samples'), entry.samples, MAX_ROUTE_SAMPLES);
    }
    if (batch.routes.size) addCommand(pipeline, directCommands, 'expire', [ROUTE_INDEX_KEY, RETENTION_SECONDS]);

    addCounterCommands(pipeline, directCommands, CACHE_KEY, {
      hits: batch.cache.hits,
      misses: batch.cache.misses,
      errors: batch.cache.errors,
    });
    for (const [type, stats] of batch.cache.types) {
      addCommand(pipeline, directCommands, 'sadd', [CACHE_TYPE_INDEX_KEY, type]);
      addCounterCommands(pipeline, directCommands, cacheTypeKey(type), stats);
    }
    if (batch.cache.types.size) addCommand(pipeline, directCommands, 'expire', [CACHE_TYPE_INDEX_KEY, RETENTION_SECONDS]);

    addSamplesCommands(pipeline, directCommands, EVENT_LOOP_SAMPLES_KEY, batch.eventLoopSamples, MAX_REQUEST_SAMPLES);

    if (pipeline && typeof pipeline.exec === 'function') await pipeline.exec();
    if (directCommands.length) await Promise.all(directCommands.map((command) => command()));
    await trimRouteIndex();

    health.flushes += 1;
    health.lastFlushAt = new Date().toISOString();
    health.lastError = null;
    return true;
  })().catch((error) => {
    health.writeFailures += 1;
    health.lastError = error.message || String(error);
    // Put the unflushed batch back in front of newly collected data. A later
    // request can retry it without blocking the request that caused the error.
    const retry = pending;
    pending = batch;
    for (const [id, route] of retry.routes) {
      const existing = pending.routes.get(id);
      if (!existing) {
        pending.routes.set(id, route);
      } else {
        existing.count += route.count;
        existing.errors += route.errors;
        existing.totalMs += route.totalMs;
        existing.samples = existing.samples.concat(route.samples).slice(-MAX_BATCH_SAMPLES);
      }
    }
    pending.requests.samples = pending.requests.samples.concat(retry.requests.samples).slice(-MAX_BATCH_SAMPLES);
    pending.requests.count += retry.requests.count;
    pending.requests.errors += retry.requests.errors;
    pending.requests.totalMs += retry.requests.totalMs;
    pending.requests.slowCount += retry.requests.slowCount;
    pending.cache.hits += retry.cache.hits;
    pending.cache.misses += retry.cache.misses;
    pending.cache.errors += retry.cache.errors;
    for (const [type, stats] of retry.cache.types) {
      const existing = pending.cache.types.get(type) || { hits: 0, misses: 0, errors: 0 };
      existing.hits += stats.hits;
      existing.misses += stats.misses;
      existing.errors += stats.errors;
      pending.cache.types.set(type, existing);
    }
    pending.eventLoopSamples = pending.eventLoopSamples.concat(retry.eventLoopSamples).slice(-MAX_BATCH_SAMPLES);
    return false;
  }).finally(() => {
    flushPromise = null;
  });

  return flushPromise;
}

async function readRedis(method, ...args) {
  if (!enabled() || typeof redisClient[method] !== 'function') return null;
  try {
    return await redisClient[method](...args);
  } catch (error) {
    health.readFailures += 1;
    health.lastError = error.message || String(error);
    return null;
  }
}

function summarizeDurations(durations) {
  const values = durations.map((value) => roundMs(value)).sort((a, b) => a - b);
  if (!values.length) return { count: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0, max_ms: 0 };
  const percentile = (p) => values[Math.min(Math.max(Math.ceil((p / 100) * values.length), 1), values.length) - 1];
  return {
    count: values.length,
    p50_ms: percentile(50),
    p95_ms: percentile(95),
    p99_ms: percentile(99),
    max_ms: values[values.length - 1],
  };
}

function parseSamples(values) {
  return (Array.isArray(values) ? values : [])
    .map(parseSample)
    .filter(Boolean);
}

function unwrapPipelineResult(value) {
  // ioredis returns [error, value]; Upstash returns value directly.
  if (Array.isArray(value) && value.length === 2 && (value[0] === null || value[0] instanceof Error)) {
    return value[0] ? null : value[1];
  }
  return value;
}

async function getRequestMetrics() {
  if (!enabled()) return null;
  await flush();
  const [rawStats, rawSamples] = await Promise.all([
    readRedis('hgetall', REQUESTS_KEY),
    readRedis('lrange', REQUEST_SAMPLES_KEY, 0, MAX_REQUEST_SAMPLES - 1),
  ]);
  if (!rawStats && !rawSamples) return null;
  const stats = parseHash(rawStats);
  const samples = parseSamples(rawSamples);
  const count = toFiniteNumber(stats.count);
  const totalMs = toFiniteNumber(stats.totalMs);
  const now = Date.now();
  const recent = samples.filter((sample) => now - toFiniteNumber(sample.timestamp) < 60 * 1000);
  const durations = samples.map((sample) => toFiniteNumber(sample.durationMs));
  const summary = summarizeDurations(durations);
  const satisfied = samples.filter((sample) => sample.durationMs <= toFiniteNumber(process.env.APDEX_T_MS, 1000)).length;
  const tolerating = samples.filter((sample) => sample.durationMs > toFiniteNumber(process.env.APDEX_T_MS, 1000) && sample.durationMs <= toFiniteNumber(process.env.APDEX_T_MS, 1000) * 4).length;
  const apdex = samples.length ? Math.round(((satisfied + tolerating / 2) / samples.length) * 1000) / 1000 : null;
  return {
    total_requests: count,
    avg_response_ms: count ? Math.round((totalMs / count) * 100) / 100 : 0,
    error_rate: count ? Math.round((toFiniteNumber(stats.errors) / count) * 10000) / 100 : 0,
    slow_rate: count ? Math.round((toFiniteNumber(stats.slowCount) / count) * 10000) / 100 : 0,
    requests_per_min: recent.length,
    recent_avg_ms: recent.length ? Math.round((recent.reduce((sum, sample) => sum + toFiniteNumber(sample.durationMs), 0) / recent.length) * 100) / 100 : 0,
    p50_ms: summary.p50_ms,
    p95_ms: summary.p95_ms,
    p99_ms: summary.p99_ms,
    max_ms: summary.max_ms,
    apdex,
    apdex_t_ms: toFiniteNumber(process.env.APDEX_T_MS, 1000),
    sample_window: samples.length,
    scope: 'redis-fleet',
  };
}

async function getRouteMetrics(limit = 20) {
  if (!enabled()) return null;
  await flush();
  const ids = await readRedis('smembers', ROUTE_INDEX_KEY);
  if (!Array.isArray(ids)) return null;
  const boundedIds = ids.slice(0, MAX_ROUTES);
  const rows = [];
  try {
    if (typeof redisClient.pipeline === 'function') {
      const pipeline = redisClient.pipeline();
      for (const id of boundedIds) {
        pipeline.get(routeKey(id, 'label'));
        pipeline.hgetall(routeKey(id, 'stats'));
        pipeline.lrange(routeKey(id, 'samples'), 0, MAX_ROUTE_SAMPLES - 1);
      }
      const values = await pipeline.exec();
      for (let i = 0; i < boundedIds.length; i += 1) {
        const label = unwrapPipelineResult(values[i * 3]);
        if (!label) continue;
        const stats = parseHash(unwrapPipelineResult(values[i * 3 + 1]));
        const samples = parseSamples(unwrapPipelineResult(values[i * 3 + 2]));
        const count = toFiniteNumber(stats.count);
        const summary = summarizeDurations(samples.map((sample) => sample.durationMs));
        rows.push({
          route: String(label),
          count,
          avg_ms: count ? Math.round((toFiniteNumber(stats.totalMs) / count) * 100) / 100 : 0,
          p50_ms: summary.p50_ms,
          p95_ms: summary.p95_ms,
          p99_ms: summary.p99_ms,
          max_ms: summary.max_ms,
          error_rate: count ? Math.round((toFiniteNumber(stats.errors) / count) * 10000) / 100 : 0,
          sample_window: samples.length,
        });
      }
    } else {
      for (const id of boundedIds) {
        const [label, rawStats, rawSamples] = await Promise.all([
          readRedis('get', routeKey(id, 'label')),
          readRedis('hgetall', routeKey(id, 'stats')),
          readRedis('lrange', routeKey(id, 'samples'), 0, MAX_ROUTE_SAMPLES - 1),
        ]);
        if (!label) continue;
        const stats = parseHash(rawStats);
        const samples = parseSamples(rawSamples);
        const count = toFiniteNumber(stats.count);
        const summary = summarizeDurations(samples.map((sample) => sample.durationMs));
        rows.push({
          route: String(label),
          count,
          avg_ms: count ? Math.round((toFiniteNumber(stats.totalMs) / count) * 100) / 100 : 0,
          p50_ms: summary.p50_ms,
          p95_ms: summary.p95_ms,
          p99_ms: summary.p99_ms,
          max_ms: summary.max_ms,
          error_rate: count ? Math.round((toFiniteNumber(stats.errors) / count) * 10000) / 100 : 0,
          sample_window: samples.length,
        });
      }
    }
  } catch (error) {
    health.readFailures += 1;
    health.lastError = error.message || String(error);
    return null;
  }
  rows.sort((a, b) => b.p95_ms - a.p95_ms);
  return {
    tracked_routes: ids.length,
    truncated: ids.length >= MAX_ROUTES,
    routes: rows.slice(0, Math.max(1, Math.min(Number(limit) || 20, 100))),
    scope: 'redis-fleet',
  };
}

function formatCacheMetrics(rawStats, typeRows) {
  const stats = parseHash(rawStats);
  const hits = toFiniteNumber(stats.hits);
  const misses = toFiniteNumber(stats.misses);
  const errors = toFiniteNumber(stats.errors);
  const byType = typeRows.map(({ type, raw }) => {
    const values = parseHash(raw);
    const typeHits = toFiniteNumber(values.hits);
    const typeMisses = toFiniteNumber(values.misses);
    const lookups = typeHits + typeMisses;
    return {
      type,
      hits: typeHits,
      misses: typeMisses,
      errors: toFiniteNumber(values.errors),
      hit_ratio: lookups ? Math.round((typeHits / lookups) * 1000) / 10 : null,
    };
  }).sort((a, b) => (a.hit_ratio ?? 101) - (b.hit_ratio ?? 101));
  const lookups = hits + misses;
  return {
    hits,
    misses,
    errors,
    hit_ratio: lookups ? Math.round((hits / lookups) * 1000) / 10 : null,
    by_type: byType,
    scope: 'redis-fleet',
  };
}

async function getCacheMetrics() {
  if (!enabled()) return null;
  await flush();
  const [rawStats, types] = await Promise.all([
    readRedis('hgetall', CACHE_KEY),
    readRedis('smembers', CACHE_TYPE_INDEX_KEY),
  ]);
  if (!rawStats && !types) return null;
  const typeList = Array.isArray(types) ? types : [];
  const typeRows = [];
  try {
    if (typeof redisClient.pipeline === 'function' && typeList.length) {
      const pipeline = redisClient.pipeline();
      for (const type of typeList) pipeline.hgetall(cacheTypeKey(type));
      const values = await pipeline.exec();
      typeList.forEach((type, index) => typeRows.push({ type, raw: unwrapPipelineResult(values[index]) }));
    } else {
      for (const type of typeList) {
        typeRows.push({ type, raw: await readRedis('hgetall', cacheTypeKey(type)) });
      }
    }
  } catch (error) {
    health.readFailures += 1;
    health.lastError = error.message || String(error);
  }
  return formatCacheMetrics(rawStats, typeRows);
}

async function getEventLoopMetrics() {
  if (!enabled()) return null;
  await flush();
  const rawSamples = await readRedis('lrange', EVENT_LOOP_SAMPLES_KEY, 0, MAX_REQUEST_SAMPLES - 1);
  if (!rawSamples) return null;
  const samples = parseSamples(rawSamples);
  const summary = summarizeDurations(samples.map((sample) => sample.value));
  const latest = samples.reduce((current, sample) => (toFiniteNumber(sample.timestamp) > toFiniteNumber(current?.timestamp) ? sample : current), null);
  return {
    current_ms: Math.round(toFiniteNumber(latest?.value) * 100) / 100,
    p50_ms: Math.round(summary.p50_ms * 100) / 100,
    p95_ms: Math.round(summary.p95_ms * 100) / 100,
    max_ms: Math.round(summary.max_ms * 100) / 100,
    samples: summary.count,
    scope: 'redis-fleet',
  };
}

function getStorageStatus() {
  return {
    backend: enabled() ? 'redis' : 'process-memory',
    persistent: enabled(),
    aggregated_across_instances: enabled(),
    key_prefix: KEY_PREFIX,
    retention_seconds: RETENTION_SECONDS,
    flush_interval_ms: FLUSH_INTERVAL_MS,
    pending_events: pending.requests.count + pending.routes.size + pending.cache.hits + pending.cache.misses + pending.cache.errors + pending.eventLoopSamples.length,
    health: { ...health },
  };
}

module.exports = {
  enabled,
  recordRequest,
  recordCacheEvent,
  recordEventLoopSample,
  flush,
  getRequestMetrics,
  getRouteMetrics,
  getCacheMetrics,
  getEventLoopMetrics,
  getStorageStatus,
};
