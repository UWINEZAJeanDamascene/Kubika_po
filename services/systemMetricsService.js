/**
 * System Metrics Service
 * Collects advanced operational metrics: PostgreSQL stats, request timing,
 * company dataset sizes, capacity estimates, pool saturation, and event-loop health.
 */

const os = require('os');
const { prisma, getPrismaOperationMetrics } = require('../lib/prisma');
const persistentMetrics = require('./performanceMetricsStore');

// ── Request Timing Tracker ──────────────────────────────────────────────
//
// Averages hide the users you care about: an endpoint averaging 400ms with a
// p99 of 12s is broken for 1 request in 100, and the mean will never show it.
// So durations are kept as samples per route and reported as percentiles.
//
// Routes are keyed by their matched Express pattern (`GET /api/products/:id`),
// never the raw URL — otherwise every id would create its own bucket and the
// map would grow without bound.
const requestStats = {
  count: 0,
  errors: 0,
  totalMs: 0,
  slowCount: 0, // >500ms
  samples: [],
};
const MAX_SAMPLES = 200;

/** Apdex satisfaction threshold in ms. Satisfied <= T, tolerating <= 4T. */
const { getSentryPerformanceConfig } = require('../config/sentryPerformance');
const APDEX_T_MS = getSentryPerformanceConfig().satisfaction_threshold_ms;

/** Per-route rolling stats. Bounded so a surprise route explosion cannot leak. */
const routeStats = new Map();
const MAX_ROUTES = Number(process.env.METRICS_MAX_ROUTES) || 200;
const MAX_ROUTE_SAMPLES = 100;
const MAX_CLIENT_METRICS = Math.max(5, Number(process.env.PERFORMANCE_CLIENT_METRICS_MAX || 20));
const MAX_CLIENT_SAMPLES = Math.max(20, Number(process.env.PERFORMANCE_CLIENT_METRICS_SAMPLES || 100));
const clientStats = new Map();

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  // Nearest-rank: the smallest value at or above the p-th percentile position.
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(Math.max(rank, 1), sortedAsc.length) - 1];
}

function summarize(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    p99_ms: percentile(sorted, 99),
    max_ms: sorted[sorted.length - 1] || 0,
  };
}

/**
 * @param {number} durationMs
 * @param {number} statusCode
 * @param {string} [route] Matched route pattern, e.g. "GET /api/products/:id".
 */
function recordRequest(durationMs, statusCode, route) {
  requestStats.count++;
  requestStats.totalMs += durationMs;
  if (durationMs > 500) requestStats.slowCount++;
  if (statusCode >= 400) requestStats.errors++;

  // Queue a non-blocking Redis write. The persistent store batches events so
  // telemetry never adds a network round trip to the request path.
  persistentMetrics.recordRequest({ durationMs, statusCode, route });

  requestStats.samples.push({
    timestamp: Date.now(),
    durationMs: Math.round(durationMs),
    statusCode,
  });
  if (requestStats.samples.length > MAX_SAMPLES) {
    requestStats.samples.shift();
  }

  if (!route) return;
  let entry = routeStats.get(route);
  if (!entry) {
    // Stop adding new routes rather than evicting: a full map still describes
    // the busiest routes accurately, and eviction would bias the percentiles.
    if (routeStats.size >= MAX_ROUTES) return;
    entry = { count: 0, errors: 0, totalMs: 0, durations: [] };
    routeStats.set(route, entry);
  }
  entry.count++;
  entry.totalMs += durationMs;
  if (statusCode >= 400) entry.errors++;
  entry.durations.push(Math.round(durationMs));
  if (entry.durations.length > MAX_ROUTE_SAMPLES) entry.durations.shift();
}

/**
 * Apdex over the recent global sample window: (satisfied + tolerating/2) / total.
 * One 0-1 number for "is the system fast enough", comparable week over week.
 */
function getApdex(samples) {
  if (!samples.length) return null;
  let satisfied = 0;
  let tolerating = 0;
  for (const s of samples) {
    if (s.durationMs <= APDEX_T_MS) satisfied++;
    else if (s.durationMs <= APDEX_T_MS * 4) tolerating++;
  }
  return Math.round(((satisfied + tolerating / 2) / samples.length) * 1000) / 1000;
}

function getRequestMetrics() {
  if (requestStats.count === 0) {
    return {
      total_requests: 0,
      avg_response_ms: 0,
      error_rate: 0,
      slow_rate: 0,
      requests_per_min: 0,
      apdex: null,
      apdex_t_ms: APDEX_T_MS,
    };
  }
  const recent = requestStats.samples.filter(
    (s) => Date.now() - s.timestamp < 60 * 1000
  );
  const recentMs = recent.reduce((s, r) => s + r.durationMs, 0);
  const overall = summarize(requestStats.samples.map((s) => s.durationMs));

  return {
    total_requests: requestStats.count,
    // Kept for backwards compatibility with existing health dashboards, but
    // read the percentiles below instead — this number cannot show the tail.
    avg_response_ms: Math.round((requestStats.totalMs / requestStats.count) * 100) / 100,
    error_rate: Math.round((requestStats.errors / requestStats.count) * 10000) / 100,
    slow_rate: Math.round((requestStats.slowCount / requestStats.count) * 10000) / 100,
    requests_per_min: recent.length,
    recent_avg_ms: recent.length > 0 ? Math.round((recentMs / recent.length) * 100) / 100 : 0,
    p50_ms: overall.p50_ms,
    p95_ms: overall.p95_ms,
    p99_ms: overall.p99_ms,
    max_ms: overall.max_ms,
    apdex: getApdex(requestStats.samples),
    apdex_t_ms: APDEX_T_MS,
  };
}

async function getAggregatedRequestMetrics() {
  const metrics = await persistentMetrics.getRequestMetrics();
  return metrics || getRequestMetrics();
}

/**
 * Per-route breakdown, slowest p95 first — the ranking you actually optimise
 * from. `limit` caps how many rows are returned, not how many are tracked.
 */
function getRouteMetrics(limit = 20) {
  const rows = [];
  for (const [route, e] of routeStats) {
    const s = summarize(e.durations);
    rows.push({
      route,
      count: e.count,
      avg_ms: Math.round((e.totalMs / e.count) * 100) / 100,
      p50_ms: s.p50_ms,
      p95_ms: s.p95_ms,
      p99_ms: s.p99_ms,
      max_ms: s.max_ms,
      error_rate: Math.round((e.errors / e.count) * 10000) / 100,
    });
  }
  rows.sort((a, b) => b.p95_ms - a.p95_ms);
  return {
    tracked_routes: routeStats.size,
    truncated: routeStats.size >= MAX_ROUTES,
    routes: rows.slice(0, limit),
  };
}

async function getAggregatedRouteMetrics(limit = 20) {
  const metrics = await persistentMetrics.getRouteMetrics(limit);
  return metrics || getRouteMetrics(limit);
}

// ── Event Loop Lag Monitor ──────────────────────────────────────────────
let lastEventLoopLag = 0;
const eventLoopSamples = [];
const MAX_LOOP_SAMPLES = 240; // 5s cadence -> ~20 minutes of history

function measureEventLoopLag() {
  const start = process.hrtime.bigint();
  setImmediate(() => {
    const end = process.hrtime.bigint();
    lastEventLoopLag = Number(end - start) / 1_000_000; // ns -> ms
    eventLoopSamples.push(lastEventLoopLag);
    if (eventLoopSamples.length > MAX_LOOP_SAMPLES) eventLoopSamples.shift();
    persistentMetrics.recordEventLoopSample(lastEventLoopLag);
  });
}

// Sample every 5 seconds
const eventLoopTimer = setInterval(measureEventLoopLag, 5000);
if (eventLoopTimer.unref) eventLoopTimer.unref();

/**
 * Rolling event-loop lag. When this rises, every endpoint slows at once and no
 * single query looks guilty — which is exactly the case that per-route
 * percentiles alone cannot explain.
 */
function getEventLoopMetrics() {
  const s = summarize(eventLoopSamples);
  return {
    current_ms: Math.round(lastEventLoopLag * 100) / 100,
    p50_ms: Math.round(s.p50_ms * 100) / 100,
    p95_ms: Math.round(s.p95_ms * 100) / 100,
    max_ms: Math.round(s.max_ms * 100) / 100,
    samples: s.count,
  };
}

async function getAggregatedEventLoopMetrics() {
  const metrics = await persistentMetrics.getEventLoopMetrics();
  return metrics || getEventLoopMetrics();
}

// ── Browser Performance Metrics ──────────────────────────────────────────
function normalizeClientMetricName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
}

function recordClientMetric(name, value, context = {}) {
  const metric = normalizeClientMetricName(name);
  const numericValue = Number(value);
  if (!metric || !Number.isFinite(numericValue) || numericValue < 0) return false;

  let entry = clientStats.get(metric);
  if (!entry) {
    if (clientStats.size >= MAX_CLIENT_METRICS) return false;
    entry = {
      name: metric,
      unit: context.unit === 'score' ? 'score' : 'ms',
      count: 0,
      total: 0,
      samples: [],
    };
    clientStats.set(metric, entry);
  }
  entry.count += 1;
  entry.total += numericValue;
  if (entry.samples.length < MAX_CLIENT_SAMPLES) {
    entry.samples.push(Math.round(numericValue * 100) / 100);
  }

  persistentMetrics.recordClientMetric(metric, numericValue, context);
  return true;
}

function getClientMetrics() {
  const metrics = [...clientStats.values()].map((entry) => {
    const summary = summarize(entry.samples);
    return {
      name: entry.name,
      unit: entry.unit,
      count: entry.count,
      avg: entry.count ? Math.round((entry.total / entry.count) * 100) / 100 : 0,
      p50: summary.p50_ms,
      p95: summary.p95_ms,
      p99: summary.p99_ms,
      max: summary.max_ms,
      sample_window: summary.count,
    };
  });
  metrics.sort((a, b) => b.p95 - a.p95);
  return {
    metrics,
    tracked_metrics: clientStats.size,
    truncated: clientStats.size >= MAX_CLIENT_METRICS,
    scope: 'process-memory',
  };
}

async function getAggregatedClientMetrics() {
  const metrics = await persistentMetrics.getClientMetrics();
  return metrics || getClientMetrics();
}

// ── Database Stats ──────────────────────────────────────────────────────
async function getDatabaseStats() {
  try {
    const rows = await prisma.$queryRaw`
      SELECT
        current_database() AS database_name,
        COALESCE(SUM(pg_total_relation_size(relid)), 0)::bigint AS total_size_bytes,
        COUNT(*)::int AS tables_count
      FROM pg_catalog.pg_statio_user_tables
    `;
    const tableRows = await prisma.$queryRaw`
      SELECT
        relname AS table_name,
        COALESCE(n_live_tup, 0)::bigint AS documents,
        pg_total_relation_size(relid)::bigint AS size_bytes,
        COALESCE((
          SELECT COUNT(*)
          FROM pg_catalog.pg_indexes AS indexes
          WHERE indexes.schemaname = stats.schemaname
            AND indexes.tablename = stats.relname
        ), 0)::int AS indexes
      FROM pg_catalog.pg_stat_user_tables AS stats
      ORDER BY n_live_tup DESC
      LIMIT 30
    `;
    const row = rows[0] || {};
    const collectionStats = tableRows.map((table) => ({
      name: table.table_name,
      documents: Number(table.documents || 0),
      size_mb: Math.round((Number(table.size_bytes || 0) / 1024 / 1024) * 100) / 100,
      avg_obj_size: Number(table.documents || 0) > 0
        ? Math.round(Number(table.size_bytes || 0) / Number(table.documents || 1))
        : 0,
      indexes: Number(table.indexes || 0),
    }));
    return {
      engine: 'postgresql',
      name: row.database_name || null,
      total_size_mb: Math.round((Number(row.total_size_bytes || 0) / 1024 / 1024) * 100) / 100,
      collections_count: Number(row.tables_count || 0),
      top_collections: collectionStats.slice(0, 8),
    };
  } catch (e) {
    return null;
  }
}

// ── PostgreSQL Pool Metrics ─────────────────────────────────────────────
async function getPostgresPoolMetrics() {
  const configuredLimit = Number(process.env.PRISMA_CONNECTION_LIMIT || 20);
  try {
    const rows = await prisma.$queryRaw`
      SELECT
        COUNT(*)::int AS total_connections,
        COUNT(*) FILTER (WHERE state = 'active')::int AS active_connections,
        COUNT(*) FILTER (WHERE state = 'idle')::int AS idle_connections,
        COUNT(*) FILTER (WHERE wait_event IS NOT NULL)::int AS waiting_connections
      FROM pg_stat_activity
      WHERE application_name = ${process.env.PRISMA_APPLICATION_NAME || 'stock-management-api'}
    `;
    const row = rows[0] || {};
    const total = Number(row.total_connections || 0);
    const active = Number(row.active_connections || 0);
    return {
      engine: 'postgresql',
      configured_pool_limit: configuredLimit,
      total_connections: total,
      active_connections: active,
      idle_connections: Number(row.idle_connections || 0),
      waiting_connections: Number(row.waiting_connections || 0),
      in_flight_operations: getPrismaOperationMetrics(),
      saturation_percent: configuredLimit > 0 ? Math.round((total / configuredLimit) * 10000) / 100 : null,
      status: total >= configuredLimit ? 'saturated' : total >= configuredLimit * 0.8 ? 'pressured' : 'ok',
    };
  } catch (error) {
    return {
      engine: 'postgresql',
      configured_pool_limit: configuredLimit,
      total_connections: null,
      active_connections: null,
      idle_connections: null,
      waiting_connections: null,
      in_flight_operations: getPrismaOperationMetrics(),
      saturation_percent: null,
      status: 'unavailable',
      error: error.message,
    };
  }
}

// ── Company Dataset Stats ───────────────────────────────────────────────
async function getCompanyDatasetStats() {
  try {
    const tenantTables = [
      'products', 'sales_orders', 'purchase_orders', 'invoices',
      'journal_entries', 'stock_movements', 'goods_received_notes', 'clients', 'suppliers',
    ];
    const [companyCounts, tableRows] = await Promise.all([
      prisma.company.groupBy({
        by: ['isActive'],
        _count: { _all: true },
      }),
      prisma.$queryRaw`
        SELECT relname AS table_name, COALESCE(n_live_tup, 0)::bigint AS documents
        FROM pg_catalog.pg_stat_user_tables
      `,
    ]);
    const totalCompanies = companyCounts.reduce((sum, row) => sum + Number(row._count?._all || 0), 0);
    const activeCompanies = Number(companyCounts.find((row) => row.isActive)?._count?._all || 0);
    const collectionDocs = tenantTables.map((tableName) => ({
      collection: tableName,
      documents: Number(tableRows.find((row) => row.table_name === tableName)?.documents || 0),
    }));
    const totalTenantDocs = collectionDocs.reduce((sum, row) => sum + row.documents, 0);
    return {
      engine: 'postgresql',
      total_companies: totalCompanies,
      active_companies: activeCompanies,
      total_tenant_documents: totalTenantDocs,
      avg_documents_per_company: totalCompanies > 0 ? Math.round(totalTenantDocs / totalCompanies) : 0,
      collection_breakdown: collectionDocs.sort((a, b) => b.documents - a.documents),
    };
  } catch (e) {
    return null;
  }
}

// ── System Capacity Estimate ────────────────────────────────────────────
function getCapacityEstimate(memory, dbStats, companyStats, requestMetrics) {
  const currentLoad = companyStats?.active_companies || 0;
  const totalDocs = companyStats?.total_tenant_documents || 0;
  const dbSizeMb = dbStats?.total_size_mb || 0;

  // 1. Derive actual per-company footprint from DB stats
  const actualDbPerCompanyMb = currentLoad > 0 ? dbSizeMb / currentLoad : 0;
  const actualDocsPerCompany = currentLoad > 0 ? totalDocs / currentLoad : 0;

  // 2. Heap limit from v8 (returns bytes)
  const v8Stats = require('v8').getHeapStatistics();
  const maxHeapMb = Math.round((v8Stats.heap_size_limit || 0) / 1024 / 1024 * 100) / 100;
  const heapHeadroomMb = Math.max(0, maxHeapMb - memory.heap_used_mb);

  // 3. DB headroom: use PostgreSQL relation sizes as the real ceiling.
  // If the database cannot be queried, estimate from the configured ceiling.
  let dbLimitMb = 5120; // Start with 5GB generic assumption
  try {
    // Try to get real wiredTiger cache limit or server disk info
    const os = require('os');
    const freeDiskMb = Math.round(os.freemem() / 1024 / 1024 * 0.3); // Conservative 30% of free RAM for DB
    dbLimitMb = Math.max(dbLimitMb, freeDiskMb);
  } catch (e) {
    // ignore
  }
  const dbHeadroomMb = Math.max(0, dbLimitMb - dbSizeMb);

  // 4. Capacity by DB (based on actual average size per company)
  const companiesByDb = actualDbPerCompanyMb > 0
    ? Math.floor(dbHeadroomMb / actualDbPerCompanyMb)
    : Math.floor(dbHeadroomMb / 20); // fallback only if no data yet

  // 5. Capacity by heap (based on memory pressure)
  // Model: base overhead ~2MB + 0.5MB per 1000 documents in active caches
  const heapPerCompanyMb = actualDocsPerCompany > 0
    ? 2 + (actualDocsPerCompany / 1000) * 0.5
    : 4;
  const companiesByHeap = Math.floor(heapHeadroomMb / heapPerCompanyMb);

  // 6. Capacity by throughput (event loop lag + request rate)
  let companiesByThroughput = 10000; // effectively unlimited if healthy
  if (requestMetrics) {
    const rps = requestMetrics.requests_per_min / 60;
    const lag = requestMetrics.event_loop_lag_ms || 0;
    // If >50 req/min and lag >20ms, we're feeling pressure
    if (rps > 50 && lag > 20) {
      companiesByThroughput = Math.floor(currentLoad * (20 / Math.max(lag, 1)));
    } else if (rps > 200) {
      companiesByThroughput = Math.floor(currentLoad * 1.5); // conservative growth
    }
  }

  // 7. Overall limit = most restrictive bottleneck, capped at 5000
  const estimatedMaxCompanies = Math.min(companiesByHeap, companiesByDb, companiesByThroughput, 5000);
  const capacityPercent = estimatedMaxCompanies > 0
    ? Math.round((currentLoad / estimatedMaxCompanies) * 100)
    : 0;

  return {
    current_active_companies: currentLoad,
    estimated_max_companies: estimatedMaxCompanies,
    capacity_used_percent: capacityPercent,
    headroom_companies: Math.max(0, estimatedMaxCompanies - currentLoad),
    heap_headroom_mb: Math.round(heapHeadroomMb * 100) / 100,
    db_headroom_mb: Math.round(dbHeadroomMb * 100) / 100,
    node_heap_limit_mb: Math.round(maxHeapMb * 100) / 100,
    // Transparency: show how the number was derived
    derived_from: {
      actual_db_per_company_mb: Math.round(actualDbPerCompanyMb * 100) / 100,
      actual_docs_per_company: Math.round(actualDocsPerCompany * 100) / 100,
      heap_per_company_mb: Math.round(heapPerCompanyMb * 100) / 100,
      bottleneck: companiesByHeap <= companiesByDb && companiesByHeap <= companiesByThroughput
        ? 'memory'
        : companiesByDb <= companiesByHeap && companiesByDb <= companiesByThroughput
          ? 'database'
          : 'throughput',
    },
  };
}

// ── System Load / CPU ───────────────────────────────────────────────────
function getSystemLoad() {
  const cpus = os.cpus();
  const loadAvg = os.loadavg();
  const cpuCount = cpus.length || 1;
  return {
    cpu_count: cpuCount,
    load_average_1m: Math.round(loadAvg[0] * 100) / 100,
    load_average_5m: Math.round(loadAvg[1] * 100) / 100,
    load_average_15m: Math.round(loadAvg[2] * 100) / 100,
    load_percent_1m: Math.round((loadAvg[0] / cpuCount) * 100),
    total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
    free_memory_mb: Math.round(os.freemem() / 1024 / 1024),
    uptime_hours: Math.round(os.uptime() / 3600 * 10) / 10,
  };
}

// ── Aggregate Metrics Builder ───────────────────────────────────────────
async function buildAdvancedMetrics(memorySnapshot) {
  const [dbStats, companyStats] = await Promise.all([
    getDatabaseStats(),
    getCompanyDatasetStats(),
  ]);
  const system = getSystemLoad();

  // Cache and persistent metrics are read defensively: metrics must never be
  // the thing that breaks a health endpoint.
  let cache = null;
  try {
    cache = await require('./cacheService').getAggregatedMetrics();
  } catch (e) {
    cache = { error: e.message };
  }

  const [requests, routes, eventLoop, pool, client] = await Promise.all([
    getAggregatedRequestMetrics(),
    getAggregatedRouteMetrics(),
    getAggregatedEventLoopMetrics(),
    getPostgresPoolMetrics(),
    getAggregatedClientMetrics(),
  ]);
  const capacity = getCapacityEstimate(memorySnapshot, dbStats, companyStats, {
    requests_per_min: requests.requests_per_min,
    event_loop_lag_ms: eventLoop.current_ms,
  });

  return {
    requests,
    routes,
    cache,
    database_stats: dbStats,
    company_stats: companyStats,
    database_pool: pool,
    capacity,
    system,
    client,
    event_loop_lag_ms: Math.round(eventLoop.current_ms * 100) / 100,
    // A single instantaneous sample can miss a spike entirely; the window shows
    // whether the loop is intermittently blocked, which is what actually
    // degrades every endpoint at once.
    event_loop_lag: eventLoop,
    // Backwards-compatible scalar, now sourced from PostgreSQL pg_stat_activity.
    active_connections: pool.active_connections ?? 0,
    metrics_storage: persistentMetrics.getStorageStatus(),
  };
}

module.exports = {
  recordRequest,
  getRequestMetrics,
  getAggregatedRequestMetrics,
  getRouteMetrics,
  getAggregatedRouteMetrics,
  getEventLoopMetrics,
  getAggregatedEventLoopMetrics,
  recordClientMetric,
  getClientMetrics,
  getAggregatedClientMetrics,
  getDatabaseStats,
  getCompanyDatasetStats,
  getPostgresPoolMetrics,
  getCapacityEstimate,
  getSystemLoad,
  buildAdvancedMetrics,
};
