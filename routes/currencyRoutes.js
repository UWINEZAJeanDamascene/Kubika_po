const express = require('express');
const router = express.Router();
const {
  listCurrencies,
  createCurrency,
  updateCurrency,
  seedDefaults
} = require('../controllers/currencyController');
const { protect, authorize } = require('../middleware/auth');

// @route   GET /api/currencies
// @desc    List currencies (active by default)
// @access  Public
router.get('/', listCurrencies);

// Admin management
router.post('/', protect, authorize('admin'), createCurrency);
router.post('/seed', protect, authorize('admin'), seedDefaults);
router.put('/:id', protect, authorize('admin'), updateCurrency);

module.exports = router;
