const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

const cachePosReads = cacheMiddleware({
  type: 'pos',
  ttl: 60,
  skipCache: (req) => req.query.refresh === '1' || req.query.refresh === 'true',
});
const invalidatePosReads = cacheInvalidationMiddleware({
  types: ['pos', 'invoice', 'stock', 'report'],
  invalidateDashboards: true,
});
const {
  createSale,
  addPayment,
  openDrawer,
  closeDrawer,
  getDrawer,
  getReceipt
} = require('../controllers/posController');

// All POS routes require authentication
router.use(protect);
router.use(invalidatePosReads);

router.post('/sale', logAction('pos_sale'), createSale);
router.post('/sale/:id/pay', logAction('pos_payment'), addPayment);
router.get('/sale/:id/receipt', cachePosReads, getReceipt);

router.post('/drawer/open', logAction('drawer_open'), openDrawer);
router.post('/drawer/close', logAction('drawer_close'), closeDrawer);
router.get('/drawer/:drawerId', cachePosReads, getDrawer);

module.exports = router;
