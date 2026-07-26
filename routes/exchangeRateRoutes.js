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

router.use(protect);

// Spec endpoints
router.get('/', listRates);
router.post('/', addRate);
router.get('/latest', getLatestRates);
router.get('/current/:currency', getCurrentRate);

// Manual "Refresh Now" (admin)
router.post('/sync', authorize('admin'), syncNow);

// Internal / convert
router.post('/convert', convert);

module.exports = router;
