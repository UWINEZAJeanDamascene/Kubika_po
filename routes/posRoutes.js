const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const logAction = require('../middleware/logAction');
const { requirePosPermissions } = require('../middleware/posAuthorization');
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

const canCreateSale = requirePosPermissions({ resource: 'sales_invoices', action: 'create' });
const canReadSale = requirePosPermissions({ resource: 'sales_invoices', action: 'read' });
const canRecordPayment = requirePosPermissions(
  { resource: 'sales_invoices', action: 'update' },
  { resource: 'ar_receipts', action: 'create' },
);

router.post('/sale', canCreateSale, logAction('pos_sale'), createSale);
router.post('/sale/:id/pay', canRecordPayment, logAction('pos_payment'), addPayment);
router.get('/sale/:id/receipt', canReadSale, cachePosReads, getReceipt);

router.post('/drawer/open', canCreateSale, logAction('drawer_open'), openDrawer);
router.post('/drawer/close', canCreateSale, logAction('drawer_close'), closeDrawer);
router.get('/drawer/:drawerId', canReadSale, cachePosReads, getDrawer);

module.exports = router;
