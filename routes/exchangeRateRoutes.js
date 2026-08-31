const express = require('express');
const router = express.Router();
const {
  addRate,
  listRates,
  getCurrentRate,
  getLatestRates,
  syncNow,
  convert
} = require('../controllers/exchangeRateController');
const { protect, authorize } = require('../middleware/auth');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

router.use(protect);

// Rates change at most daily but are read by every multi-currency screen, so
// they cache for an hour. Both the manual add and the "Refresh Now" sync
// invalidate, so a new rate is visible immediately rather than up to an hour late.
const cacheRates = cacheMiddleware({ type: 'exchange_rate', ttl: 3600 });
const invalidateRates = cacheInvalidationMiddleware({ type: 'exchange_rate', invalidateAll: true });

// Spec endpoints
router.get('/', cacheRates, listRates);
router.post('/', invalidateRates, addRate);
router.get('/latest', cacheRates, getLatestRates);
router.get('/current/:currency', cacheRates, getCurrentRate);

// Manual "Refresh Now" (admin)
router.post('/sync', authorize('admin'), invalidateRates, syncNow);

// Internal / convert
router.post('/convert', convert);

module.exports = router;
