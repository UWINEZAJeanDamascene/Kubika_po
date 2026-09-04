const express = require('express');
const router = express.Router();
const {
  listCurrencies,
  createCurrency,
  updateCurrency,
  seedDefaults
} = require('../controllers/currencyController');
const { protect, authorize } = require('../middleware/auth');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

// The currency list is not tenant-scoped (listCurrencies applies no company
// filter) and this route is public, so it is marked global: without that the
// cache would be skipped for lack of a resolvable tenant.
const cacheCurrencies = cacheMiddleware({ type: 'currency', ttl: 3600, global: true });
const invalidateCurrencies = cacheInvalidationMiddleware({ type: 'currency', invalidateAll: true, global: true });

// @route   GET /api/currencies
// @desc    List currencies (active by default)
// @access  Public
router.get('/', cacheCurrencies, listCurrencies);

// Admin management
router.post('/', protect, authorize('admin'), invalidateCurrencies, createCurrency);
router.post('/seed', protect, authorize('admin'), invalidateCurrencies, seedDefaults);
router.put('/:id', protect, authorize('admin'), invalidateCurrencies, updateCurrency);

module.exports = router;
