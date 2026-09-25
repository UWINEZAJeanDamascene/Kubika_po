'use strict';

const express = require('express');
const { protect } = require('../middleware/auth');
const { requireAIFeature } = require('../services/aiFeatureFlags');
const authData = require('../services/authDataService');
const { extractUserPermissions, hasPermission } = require('../ai-engine/context-builder/permissionUtils');
const { DOMAIN_PERMISSIONS } = require('../ai-engine/monitoring/MonitoringEngine');
const AIForecastService = require('../services/aiForecastService');

const router = express.Router();

function entityId(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value._id) return String(value._id);
  if (value.id) return String(value.id);
  return String(value);
}

async function authenticatedUser(user) {
  if (user && Array.isArray(user.roles) && user.roles.some((role) => role && typeof role === 'object' && role.permissions)) return user;
  return await authData.findUserById(entityId(user), { populateCompany: true, populateRoles: true }) || user;
}

function companyFor(req, user) {
  return entityId(req.company || user.company);
}

function requireCompany(companyId) {
  if (!companyId) throw Object.assign(new Error('Company context is required.'), { statusCode: 400 });
}

router.use(protect, requireAIFeature('forecasts'));

router.get('/types', async (req, res) => {
  try {
    const user = await authenticatedUser(req.user);
    const permissions = extractUserPermissions(user);
    const types = Object.entries(AIForecastService.FORECAST_TYPES)
      .filter(([, definition]) => definition.permissionDomains.some((domain) => hasPermission(permissions, DOMAIN_PERMISSIONS[domain] || [])))
      .map(([type, definition]) => ({ type, title: definition.title }));
    return res.json({ success: true, types });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to list AI forecast types.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const user = await authenticatedUser(req.user);
    const companyId = companyFor(req, user);
    requireCompany(companyId);
    const forecast = await AIForecastService.generateForecast({
      companyId,
      user,
      forecastType: String(req.body?.forecastType || ''),
      horizon: req.body?.horizon,
      historyMonths: req.body?.historyMonths,
    });
    return res.status(201).json({ success: true, forecast });
  } catch (error) {
    console.error('AI forecast generation error:', error.message || String(error));
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to generate AI forecast.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const user = await authenticatedUser(req.user);
    const companyId = companyFor(req, user);
    requireCompany(companyId);
    const forecasts = await AIForecastService.listForecasts(companyId, extractUserPermissions(user), req.query || {});
    return res.json({ success: true, forecasts });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to list AI forecasts.' });
  }
});

router.get('/:forecastId', async (req, res) => {
  try {
    const user = await authenticatedUser(req.user);
    const companyId = companyFor(req, user);
    requireCompany(companyId);
    const forecast = await AIForecastService.getForecast(companyId, req.params.forecastId, extractUserPermissions(user));
    if (!forecast) return res.status(404).json({ success: false, message: 'AI forecast not found.' });
    return res.json({ success: true, forecast });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to load AI forecast.' });
  }
});

module.exports = router;
