/**
 * Sentry performance configuration kept next to the SDK bootstrap.
 *
 * Sentry's Apdex satisfaction threshold is a Sentry project setting, not an
 * @sentry/node SDK option. The application therefore keeps the same threshold
 * locally, emits it on every transaction, and requires an explicit deployment
 * acknowledgement (`SENTRY_APDEX_PROJECT_CONFIGURED=true`) before staging or
 * production is considered Phase 0 ready.
 */

const DEFAULT_APDEX_T_MS = 1000;
const APDEX_PROJECT_SETTINGS_PATH = 'Sentry project → Settings → Performance → Response Time Threshold (Apdex)';

function positiveNumber(value, fallback = DEFAULT_APDEX_T_MS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getSentryPerformanceConfig() {
  const thresholdMs = positiveNumber(
    process.env.APDEX_T_MS || process.env.SENTRY_APDEX_T_MS,
    DEFAULT_APDEX_T_MS,
  );
  const projectThresholdMs = optionalPositiveNumber(process.env.SENTRY_APDEX_PROJECT_T_MS);
  const operatorAcknowledged = ['true', '1', 'yes'].includes(
    String(process.env.SENTRY_APDEX_PROJECT_CONFIGURED || '').toLowerCase().trim(),
  );
  const thresholdMatchesProject = projectThresholdMs === thresholdMs;
  const projectConfigured = operatorAcknowledged && thresholdMatchesProject;
  return {
    satisfaction_threshold_ms: thresholdMs,
    tolerating_threshold_ms: thresholdMs * 4,
    project_threshold_ms: projectThresholdMs,
    threshold_matches_project: thresholdMatchesProject,
    operator_acknowledged: operatorAcknowledged,
    project_setting_path: APDEX_PROJECT_SETTINGS_PATH,
    sdk_configurable: false,
    project_configured: projectConfigured,
    verification: projectConfigured
      ? 'operator-confirmed'
      : 'pending-project-setting-confirmation',
  };
}

module.exports = {
  DEFAULT_APDEX_T_MS,
  APDEX_PROJECT_SETTINGS_PATH,
  getSentryPerformanceConfig,
};
