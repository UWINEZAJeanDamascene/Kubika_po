'use strict';

const express = require('express');
const { protect } = require('../middleware/auth');
const { getFeatureFlagSnapshot } = require('../services/aiFeatureFlags');
const { getSummary } = require('../services/aiOperationalMetricsService');

const router = express.Router();

router.get('/summary', protect, async (req, res) => {
  if (!req.isPlatformAdmin && req.user?.role !== 'platform_admin') {
    return res.status(403).json({ success: false, message: 'Platform administrator access is required.' });
  }
  try {
    const days = req.query.days === undefined ? 30 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      return res.status(400).json({ success: false, message: 'days must be an integer from 1 to 90.' });
    }
    const companyId = req.query.companyId ? String(req.query.companyId) : null;
    const summary = await getSummary({ days, companyId });
    return res.json({ success: true, summary, featureFlags: getFeatureFlagSnapshot() });
  } catch (error) {
    console.error('[ai-observability] Summary query failed:', error.message || error);
    return res.status(503).json({ success: false, message: 'AI observability data is temporarily unavailable.' });
  }
});

module.exports = router;
