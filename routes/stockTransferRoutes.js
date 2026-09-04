const express = require('express');
const router = express.Router();
const stockTransferController = require('../controllers/stockTransferController');
const { protect } = require('../middleware/auth');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

const cacheStockTransferReads = cacheMiddleware({
  type: 'stock_transfer',
  ttl: 30,
  skipCache: (req) => req.query.refresh === '1' || req.query.refresh === 'true',
});
const invalidateStockTransferReads = cacheInvalidationMiddleware({
  // Confirm/cancel mutate Product.currentStock directly (stockTransferService),
  // so 'product' must be invalidated alongside 'stock' — otherwise
  // /api/products keeps serving the pre-transfer quantity for its own TTL.
  types: ['stock_transfer', 'stock', 'product', 'report'],
  invalidateDashboards: true,
});

router.use(protect);
router.use(cacheStockTransferReads);
router.use(invalidateStockTransferReads);

router.post('/', stockTransferController.create);
router.put('/:id', stockTransferController.update);
router.post('/:id/confirm', stockTransferController.confirm);
router.post('/:id/cancel', stockTransferController.cancel);
router.get('/', stockTransferController.list);
router.get('/:id', stockTransferController.get);

module.exports = router;
