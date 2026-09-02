/**
 * Phase 0 — performance observability readiness.
 *
 * In staging and production, Redis and Sentry are required by default so
 * caching, sessions, and error/performance telemetry are never accidentally
 * running in degraded mode. Tests stay permissive; every other environment
 * requires an explicit Redis opt-out if process-local telemetry is intentional.
 *
 * Override per environment:
 *   PERFORMANCE_REQUIRE_REDIS=false
 *   PERFORMANCE_REQUIRE_SENTRY=false
 */

const { isEnabled: isSentryEnabled } = require('../lib/sentry');
const { getSentryPerformanceConfig } = require('../config/sentryPerformance');

function isDeployedEnvironment(nodeEnv = process.env.NODE_ENV) {
  return nodeEnv === 'staging' || nodeEnv === 'production';
}

function parseOptionalBool(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const lower = String(value).toLowerCase().trim();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return null;
}

/**
 * Resolved requirement flags. Every non-test environment requires durable Redis
 * metrics by default; deployed environments additionally require Sentry and the
 * Apdex project-setting acknowledgement unless explicitly opted out.
 */
function resolvePerformanceRequirements(nodeEnv = process.env.NODE_ENV) {
  const deployed = isDeployedEnvironment(nodeEnv);
  const redisOverride = parseOptionalBool(process.env.PERFORMANCE_REQUIRE_REDIS);
  const sentryOverride = parseOptionalBool(process.env.PERFORMANCE_REQUIRE_SENTRY);
  const apdexOverride = parseOptionalBool(process.env.PERFORMANCE_REQUIRE_SENTRY_APDEX);
  return {
    // Durable, cross-instance Phase 0 metrics require Redis in every runtime
    // except tests. A local no-op is available only through an explicit opt-out.
    redis: redisOverride !== null ? redisOverride : nodeEnv !== 'test',
    sentry: sentryOverride !== null ? sentryOverride : deployed,
    sentryApdex: apdexOverride !== null
      ? apdexOverride
      : deployed && sentryOverride !== false,
    deployed,
    nodeEnv,
  };
}

/**
 * Build the readiness payload used by /api/performance/readiness and boot checks.
 */
async function getPerformanceReadiness(options = {}) {
  const redisCache = require('../utils/redisCache');
  const { isRedisConfigured } = require('../config/redis');

  const required = options.required || resolvePerformanceRequirements(options.nodeEnv);
  const redisHealth = await redisCache.healthCheck();
  const persistentMetrics = require('../services/performanceMetricsStore');
  const redis = {
    configured: isRedisConfigured(),
    connected: Boolean(redisHealth.connected),
    error: redisHealth.error || null,
  };
  const metrics = persistentMetrics.getStorageStatus();
  const sentry = {
    configured: Boolean(process.env.SENTRY_DSN),
    enabled: isSentryEnabled(),
    performance: getSentryPerformanceConfig(),
  };

  const failures = [];
  if (required.redis) {
    if (!redis.configured) {
      failures.push(
        'Redis is required but not configured. Set REDIS_URL or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.',
      );
    } else if (!redis.connected) {
      failures.push('Redis is required but unreachable (health check failed).');
    } else if (!metrics.persistent) {
      failures.push('Redis is reachable but the persistent metrics store is unavailable.');
    }
  }
  if (required.sentry) {
    if (!sentry.configured) {
      failures.push('SENTRY_DSN is required in staging/production (Phase 0 observability).');
    } else if (!sentry.enabled) {
      failures.push('Sentry is required but failed to initialize (check @sentry/node and SENTRY_DSN).');
    }
  }
  if (required.sentryApdex && !sentry.performance.project_configured) {
    failures.push(
      'Sentry Apdex project setting is not confirmed. Configure '
      + sentry.performance.project_setting_path
      + ` to ${sentry.performance.satisfaction_threshold_ms}ms, then set `
      + 'SENTRY_APDEX_PROJECT_T_MS to the same value and SENTRY_APDEX_PROJECT_CONFIGURED=true.',
    );
  }

  return {
    ready: failures.length === 0,
    required,
    redis,
    metrics,
    sentry,
    failures,
  };
}

/**
 * Fail fast during boot when the runtime is missing Phase 0 dependencies.
 * Tests are skipped; explicit PERFORMANCE_REQUIRE_* opt-outs are still allowed.
 */
async function assertPerformanceReadinessAtBoot(options = {}) {
  const nodeEnv = options.nodeEnv || process.env.NODE_ENV;
  if (nodeEnv === 'test') {
    return { ready: true, skipped: true, reason: 'test environment' };
  }

  const required = resolvePerformanceRequirements(nodeEnv);
  const readiness = await getPerformanceReadiness({ required, nodeEnv });

  if (readiness.ready) {
    if (required.deployed) {
      console.log('[Phase 0] Performance readiness OK (Redis metrics + Sentry contract).');
    }
    return readiness;
  }

  const message = `[Phase 0] Performance readiness check failed:\n${readiness.failures.map((f) => `  - ${f}`).join('\n')}`;

  if (required.redis || required.sentry || required.sentryApdex) {
    throw new Error(message);
  }

  console.warn(`${message}\n  (Telemetry opt-out is explicit: set PERFORMANCE_REQUIRE_REDIS=false and/or PERFORMANCE_REQUIRE_SENTRY=false.)`);
  return readiness;
}

module.exports = {
  isDeployedEnvironment,
  resolvePerformanceRequirements,
  getPerformanceReadiness,
  assertPerformanceReadinessAtBoot,
};
