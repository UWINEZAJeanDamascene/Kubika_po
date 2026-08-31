/**
 * Sentry initialisation — performance tracing and error reporting.
 *
 * Entirely inert unless SENTRY_DSN is set: no network calls, no instrumentation,
 * no measurable overhead. That is deliberate, so this can sit in the boot path
 * of every environment while only the ones you configure actually report.
 *
 * Sentry complements, rather than replaces, services/systemMetricsService.js.
 * The in-process metrics give live p50/p95/p99, per-route breakdown, Apdex and
 * cache hit ratio — but they reset on restart and only describe one instance.
 * Sentry adds retention, alerting and cross-instance aggregation.
 *
 * Must be required AFTER dotenv.config() (it reads env at call time) and as
 * early as possible in the boot sequence so instrumentation wraps the app.
 */

let initialized = false;

function initSentry() {
  if (initialized) return false;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;

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
  const tracesSampleRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE);

  try {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.SENTRY_RELEASE || undefined,
      tracesSampleRate: Number.isFinite(tracesSampleRate) ? tracesSampleRate : 0.1,
      // Apdex T. Sentry derives its own satisfaction thresholds from this, so it
      // matches APDEX_T_MS used by the in-process metrics and the 1s target in
      // the performance plan. Keep the two in step or the numbers will disagree.
      // (Set in the Sentry project settings too — this tag makes the intent
      // visible on every event.)
      initialScope: {
        tags: { apdex_t_ms: String(Number(process.env.APDEX_T_MS) || 1000) },
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
    console.log(`[Sentry] Initialized (env=${process.env.NODE_ENV || 'development'}, traces=${Number.isFinite(tracesSampleRate) ? tracesSampleRate : 0.1})`);
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
