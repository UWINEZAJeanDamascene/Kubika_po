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
const { protect, authorize } = require('../middleware/auth');
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
router.get('/ready-for-picking', authorize('admin', 'stock_manager', 'warehouse'), cacheSalesOrderReads, getReadyForPicking);
router.get('/ready-for-packing', authorize('admin', 'stock_manager', 'warehouse'), cacheSalesOrderReads, getReadyForPacking);
router.get('/ready-for-delivery', authorize('admin', 'stock_manager', 'warehouse'), cacheSalesOrderReads, getReadyForDelivery);
router.get('/backorders', authorize('admin', 'stock_manager', 'sales'), cacheSalesOrderReads, getBackorders);
router.get('/client/:clientId', cacheSalesOrderReads, getClientSalesOrders);

// Main routes
router.route('/')
  .get(cacheSalesOrderReads, getSalesOrders)
  .post(authorize('admin', 'sales', 'stock_manager'), logAction('sales_order'), createSalesOrder);

router.route('/:id')
  .get(cacheSalesOrderReads, getSalesOrder)
  .put(authorize('admin', 'sales', 'stock_manager'), logAction('sales_order'), updateSalesOrder)
  .delete(authorize('admin', 'sales'), logAction('sales_order'), deleteSalesOrder);

// Workflow actions
router.post('/:id/confirm', authorize('admin', 'sales', 'stock_manager'), logAction('sales_order'), confirmSalesOrder);
router.post('/:id/cancel', authorize('admin', 'sales'), logAction('sales_order'), cancelSalesOrder);
router.get('/:id/workflow', cacheSalesOrderReads, getWorkflowStatus);

module.exports = router;
