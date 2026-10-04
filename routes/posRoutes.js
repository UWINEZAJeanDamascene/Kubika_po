const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const logAction = require('../middleware/logAction');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
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

router.post('/sale', requirePermissionOrRoles('point_of_sale', 'create', ['admin', 'manager', 'sales']), logAction('pos_sale'), createSale);
router.post('/sale/:id/pay', requirePermissionOrRoles('point_of_sale', 'pay', ['admin', 'accountant', 'sales']), logAction('pos_payment'), addPayment);
router.get('/sale/:id/receipt', requirePermissionOrRoles('point_of_sale', 'read', ['admin', 'accountant', 'manager', 'sales', 'viewer']), cachePosReads, getReceipt);

router.post('/drawer/open', requirePermissionOrRoles('point_of_sale', 'open', ['admin', 'manager', 'sales']), logAction('drawer_open'), openDrawer);
router.post('/drawer/close', requirePermissionOrRoles('point_of_sale', 'close', ['admin', 'manager', 'sales']), logAction('drawer_close'), closeDrawer);
router.get('/drawer/:drawerId', requirePermissionOrRoles('point_of_sale', 'read', ['admin', 'accountant', 'manager', 'sales', 'viewer']), cachePosReads, getDrawer);

module.exports = router;
