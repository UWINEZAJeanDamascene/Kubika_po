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
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
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
  .get(requirePermissionOrRoles('stock', 'read', ['admin']), cacheStockReads, getStockMovements)
  .post(requirePermissionOrRoles('stock', 'create', ['admin']), logAction('stock'), receiveStock);

router.get('/movements/:id', requirePermissionOrRoles('stock', 'read', ['admin']), cacheStockReads, getStockMovement);
router.put('/movements/:id', requirePermissionOrRoles('stock', 'update', ['admin']), logAction('stock'), updateStockMovement);
router.delete('/movements/:id', requirePermissionOrRoles('stock', 'delete', ['admin']), logAction('stock'), deleteStockMovement);
router.get('/product/:productId/movements', requirePermissionOrRoles('stock', 'read', ['admin']), cacheStockReads, getProductStockMovements);
router.post('/adjust', requirePermissionOrRoles('stock', 'update', ['admin']), logAction('stock'), adjustStock);
router.post('/opening', requirePermissionOrRoles('stock', 'create', ['admin']), logAction('stock'), createOpeningStock);
router.get('/summary', requirePermissionOrRoles('stock', 'read', ['admin']), cacheStockReads, getStockSummary);

// Stock Levels endpoint - provides per-warehouse stock information
router.get('/levels', requirePermissionOrRoles('stock', 'read', ['admin']), cacheStockReads, getStockLevels);

module.exports = router;
