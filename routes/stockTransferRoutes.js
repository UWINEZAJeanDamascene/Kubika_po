const express = require('express');
const router = express.Router();
const stockTransferController = require('../controllers/stockTransferController');
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

const cacheStockTransferReads = cacheMiddleware({
  type: 'stock_transfer',
  ttl: 30,
  skipCache: (req) => req.query.refresh === '1' || req.query.refresh === 'true',
});
const invalidateStockTransferReads = cacheInvalidationMiddleware({
  // Transfer lifecycle actions mutate stock positions, so 'product' must be
  // invalidated alongside 'stock' — otherwise
  // /api/products keeps serving the pre-transfer quantity for its own TTL.
  types: ['stock_transfer', 'stock', 'product', 'report'],
  invalidateDashboards: true,
});

router.use(protect);
router.use(cacheStockTransferReads);
router.use(invalidateStockTransferReads);

router.post('/', stockTransferController.create);
router.put('/:id', stockTransferController.update);
router.post('/:id/dispatch', stockTransferController.dispatch);
router.post('/:id/confirm', stockTransferController.confirm);
router.post(
  '/:id/receive',
  requirePermissionOrRoles('stock_transfers', 'update', ['admin', 'stock_manager', 'warehouse_manager']),
  stockTransferController.receive,
);
router.post('/:id/cancel', stockTransferController.cancel);
router.get('/', stockTransferController.list);
router.get('/:id', stockTransferController.get);

module.exports = router;
