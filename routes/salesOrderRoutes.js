const express = require('express');
const router = express.Router();
const {
  getSalesOrders,
  getSalesOrder,
  createSalesOrder,
  updateSalesOrder,
  deleteSalesOrder,
  confirmSalesOrder,
  cancelSalesOrder,
  getClientSalesOrders,
  getReadyForPicking,
  getReadyForPacking,
  getReadyForDelivery,
  getBackorders,
  getWorkflowStatus
} = require('../controllers/salesOrderController');
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const logAction = require('../middleware/logAction');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

const cacheSalesOrderReads = cacheMiddleware({
  type: 'sales_order',
  ttl: 30,
  skipCache: (req) => req.query.refresh === '1' || req.query.refresh === 'true',
});
const invalidateSalesOrderReads = cacheInvalidationMiddleware({
  types: ['sales_order', 'pick_pack', 'stock', 'report'],
  invalidateDashboards: true,
});

router.use(protect);
router.use(invalidateSalesOrderReads);

// Special routes (must come before :id routes)
router.get('/ready-for-picking', requirePermissionOrRoles('sales_orders', 'read', ['admin', 'stock_manager', 'warehouse', 'warehouse_manager']), cacheSalesOrderReads, getReadyForPicking);
router.get('/ready-for-packing', requirePermissionOrRoles('sales_orders', 'read', ['admin', 'stock_manager', 'warehouse', 'warehouse_manager']), cacheSalesOrderReads, getReadyForPacking);
router.get('/ready-for-delivery', requirePermissionOrRoles('sales_orders', 'read', ['admin', 'stock_manager', 'warehouse', 'warehouse_manager']), cacheSalesOrderReads, getReadyForDelivery);
router.get('/backorders', requirePermissionOrRoles('sales_orders', 'read', ['admin', 'stock_manager', 'sales']), cacheSalesOrderReads, getBackorders);
router.get('/client/:clientId', requirePermissionOrRoles('sales_orders', 'read', ['admin', 'sales']), cacheSalesOrderReads, getClientSalesOrders);

// Main routes
router.route('/')
  .get(requirePermissionOrRoles('sales_orders', 'read', ['admin', 'sales', 'stock_manager']), cacheSalesOrderReads, getSalesOrders)
  .post(requirePermissionOrRoles('sales_orders', 'create', ['admin', 'sales', 'stock_manager']), logAction('sales_order'), createSalesOrder);

router.route('/:id')
  .get(requirePermissionOrRoles('sales_orders', 'read', ['admin', 'sales', 'stock_manager']), cacheSalesOrderReads, getSalesOrder)
  .put(requirePermissionOrRoles('sales_orders', 'update', ['admin', 'sales', 'stock_manager']), logAction('sales_order'), updateSalesOrder)
  .delete(requirePermissionOrRoles('sales_orders', 'delete', ['admin', 'sales']), logAction('sales_order'), deleteSalesOrder);

// Workflow actions
router.post('/:id/confirm', requirePermissionOrRoles('sales_orders', 'approve', ['admin', 'sales', 'stock_manager']), logAction('sales_order'), confirmSalesOrder);
router.post('/:id/cancel', requirePermissionOrRoles('sales_orders', 'delete', ['admin', 'sales']), logAction('sales_order'), cancelSalesOrder);
router.get('/:id/workflow', requirePermissionOrRoles('sales_orders', 'read', ['admin', 'sales', 'stock_manager']), cacheSalesOrderReads, getWorkflowStatus);

module.exports = router;
