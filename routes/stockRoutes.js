const express = require('express');
const router = express.Router();
const {
  getStockMovements,
  getStockMovement,
  receiveStock,
  adjustStock,
  createOpeningStock,
  getProductStockMovements,
  getStockSummary,
  getStockLevels,
  updateStockMovement,
  deleteStockMovement
} = require('../controllers/stockController');
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

const cacheStockReads = cacheMiddleware({
  type: 'stock',
  ttl: 60,
  skipCache: (req) => req.query.refresh === '1' || req.query.refresh === 'true',
});
const invalidateStockReads = cacheInvalidationMiddleware({
  types: ['stock', 'product', 'report'],
  invalidateDashboards: true,
});

router.use(protect);
router.use(invalidateStockReads);

router.route('/movements')
  .get(cacheStockReads, getStockMovements)
  .post(authorize('admin'), logAction('stock'), receiveStock);

router.get('/movements/:id', cacheStockReads, getStockMovement);
router.put('/movements/:id', authorize('admin'), logAction('stock'), updateStockMovement);
router.delete('/movements/:id', authorize('admin'), logAction('stock'), deleteStockMovement);
router.get('/product/:productId/movements', cacheStockReads, getProductStockMovements);
router.post('/adjust', authorize('admin'), logAction('stock'), adjustStock);
router.post('/opening', authorize('admin'), logAction('stock'), createOpeningStock);
router.get('/summary', cacheStockReads, getStockSummary);

// Stock Levels endpoint - provides per-warehouse stock information
router.get('/levels', cacheStockReads, getStockLevels);

module.exports = router;
