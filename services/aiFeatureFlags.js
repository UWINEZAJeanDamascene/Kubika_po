'use strict';

const config = require('../src/config/environment').getConfig().ai;

const FEATURE_CONFIG_KEYS = Object.freeze({
  aiChatV2: 'aiChatV2',
  proactiveFindings: 'proactiveFindings',
  proposals: 'proposals',
  forecasts: 'forecasts',
  reports: 'reports',
});

function entityId(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value.id || value._id) return String(value.id || value._id);
  return String(value);
}

function isInternalAdmin(user) {
  if (!user) return false;
  if (String(user.role || '').toLowerCase() === 'platform_admin') return true;
  return (user.roles || []).some((role) => {
    const name = String(typeof role === 'string' ? role : role && role.name || '').toLowerCase();
    return name === 'platform_admin';
  });
}

function isTenantFeatureEnabled(feature, companyId) {
  const configKey = FEATURE_CONFIG_KEYS[feature];
  if (!configKey || !config.featureFlags[configKey]) return false;

  const tenantId = entityId(companyId);
  const stage = ['internal', 'test_company', 'beta', 'all'].includes(config.rolloutStage)
    ? config.rolloutStage
    : 'internal';
  if (stage === 'all') return true;
  if (tenantId && config.rolloutInternalTenantIds.includes(tenantId)) return true;
  if (stage === 'internal') return false;

  const testCompany = config.rolloutTestCompanyId;
  if (testCompany && tenantId === testCompany) return true;
  if (stage === 'test_company') return false;
  return Boolean(tenantId && config.rolloutBetaTenantIds.includes(tenantId));
}

function isFeatureEnabled(feature, { companyId, user } = {}) {
  const configKey = FEATURE_CONFIG_KEYS[feature];
  if (!configKey || !config.featureFlags[configKey]) return false;
  return isInternalAdmin(user) || isTenantFeatureEnabled(feature, companyId || user && user.company);
}

function requireAIFeature(feature) {
  return (req, res, next) => {
    if (!isFeatureEnabled(feature, { companyId: req.company || req.user && req.user.company, user: req.user })) {
      return res.status(503).json({
        success: false,
        code: 'AI_FEATURE_UNAVAILABLE',
        message: 'This AI feature is not enabled for this company yet.',
      });
    }
    return next();
  };
}

function getFeatureFlagSnapshot() {
  return {
    stage: config.rolloutStage,
    features: { ...config.featureFlags },
    killSwitches: { ...config.killSwitches },
  };
}

module.exports = { isFeatureEnabled, isTenantFeatureEnabled, requireAIFeature, getFeatureFlagSnapshot, isInternalAdmin };
