/**
 * Sentry initialisation — performance tracing and error reporting.
 *
 * Entirely inert unless SENTRY_DSN is set: no network calls, no instrumentation,
 * no measurable overhead. That is deliberate, so this can sit in the boot path
 * of every environment while only the ones you configure actually report.
 *
 * Sentry complements, rather than replaces, services/systemMetricsService.js.
 * Redis-backed metrics give live p50/p95/p99, per-route breakdown, Apdex and
 * cache hit ratio across replicas; the process-local fallback is retained only
 * for explicit test/development opt-outs. Sentry adds trace retention and alerting.
 *
 * Must be required AFTER dotenv.config() (it reads env at call time) and as
 * early as possible in the boot sequence so instrumentation wraps the app.
 */

const { getSentryPerformanceConfig } = require('../config/sentryPerformance');

let initialized = false;

function initSentry() {
  if (initialized) return false;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;

  const nodeEnv = process.env.NODE_ENV || 'development';
  const deployed = nodeEnv === 'staging' || nodeEnv === 'production';
  if (deployed && process.env.SENTRY_TRACES_SAMPLE_RATE === undefined) {
    // Sensible default for deployed environments when not explicitly tuned.
    process.env.SENTRY_TRACES_SAMPLE_RATE = '0.1';
  }

  let Sentry;
  try {
    Sentry = require('@sentry/node');
  } catch (e) {
    console.warn('[Sentry] SENTRY_DSN is set but @sentry/node is not installed — skipping.');
    return false;
  }

  // Fraction of requests traced. Tracing every request is expensive and rarely
  // necessary; percentiles come from the in-process metrics, so this is for
  // sampled detail, not for coverage.
  const configuredRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE);
  const tracesSampleRate = Number.isFinite(configuredRate)
    ? Math.min(Math.max(configuredRate, 0), 1)
    : 0.1;
  const performanceConfig = getSentryPerformanceConfig();

  try {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.SENTRY_RELEASE || undefined,
      tracesSampleRate,
      // Sentry's Apdex T is configured in the project UI rather than the Node
      // SDK. Emit the declared contract on every transaction and expose the
      // operator confirmation in readiness so it cannot drift silently.
      initialScope: {
        tags: {
          apdex_t_ms: String(performanceConfig.satisfaction_threshold_ms),
          apdex_project_t_ms: String(performanceConfig.project_threshold_ms || ''),
          apdex_contract_valid: String(performanceConfig.project_configured),
        },
      },
      // Health checks are polled constantly by uptime monitors and would
      // dominate the trace sample for no diagnostic value.
      beforeSendTransaction(event) {
        const name = event.transaction || '';
        if (name.includes('/api/health') || name === 'GET /health') return null;
        return event;
      },
    });
    initialized = true;
    console.log(`[Sentry] Initialized (env=${process.env.NODE_ENV || 'development'}, traces=${tracesSampleRate}, apdexT=${performanceConfig.satisfaction_threshold_ms}ms)`);
    return true;
  } catch (e) {
    // Never let telemetry stop the server from booting.
    console.warn('[Sentry] Initialization failed, continuing without it:', e.message);
    return false;
  }
}

/** Attach Sentry's Express error handler. No-op when Sentry is not active. */
function setupExpressErrorHandler(app) {
  if (!initialized) return false;
  try {
    require('@sentry/node').setupExpressErrorHandler(app);
    return true;
  } catch (e) {
    console.warn('[Sentry] Could not attach Express error handler:', e.message);
    return false;
  }
}

function isEnabled() {
  return initialized;
}

module.exports = { initSentry, setupExpressErrorHandler, isEnabled };
