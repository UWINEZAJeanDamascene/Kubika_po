const express = require('express');
const router = express.Router();

// Warehouse routes
const {
  getWarehouses,
  getWarehouse,
  createWarehouse,
  updateWarehouse,
  deleteWarehouse,
  getWarehouseInventory
} = require('../controllers/warehouseController');

// Inventory Batch routes
const {
  getInventoryBatches,
  getInventoryBatch,
  createInventoryBatch,
  updateInventoryBatch,
  consumeFromBatch,
  getExpiringBatches,
  getProductBatches
} = require('../controllers/inventoryBatchController');

// Serial Number routes
const {
  getSerialNumbers,
  getSerialNumber,
  createSerialNumber,
  updateSerialNumber,
  sellSerialNumber,
  returnSerialNumber,
  lookupSerialNumber,
  getAvailableSerials
} = require('../controllers/serialNumberController');

// Stock Transfer routes
const {
  getStockTransfers,
  getStockTransfer,
  createStockTransfer,
  approveStockTransfer,
  completeStockTransfer,
  cancelStockTransfer
} = require('../controllers/stockTransferController');

// Stock Audit routes
const {
  getStockAudits,
  getStockAudit,
  createStockAudit
} = require('../controllers/stockAuditController');

// Commented out due to missing controller functions:
// completeStockAudit, cancelStockAudit, getAuditVariance

// Reorder Point routes
const {
  getReorderPoints,
  getReorderPoint,
  createReorderPoint,
  updateReorderPoint,
  deleteReorderPoint,
  getProductsNeedingReorder,
  bulkCreateReorderPoints
} = require('../controllers/reorderPointController');

// Purchase Order + GRN controllers
const {
  createPurchaseOrder,
  updatePurchaseOrder,
  approvePurchaseOrder,
  cancelPurchaseOrder,
  getPurchaseOrders,
  getPurchaseOrder,
  recordPOPayment
} = require('../controllers/purchaseOrderController');

const {
  createGRN,
  confirmGRN,
  listGRNs,
  getGRN,
  updateGRN,
  deleteGRN
} = require('../controllers/grnController');

const {
  createPurchaseReturn,
  updatePurchaseReturn,
  confirmPurchaseReturn,
  listPurchaseReturns,
  getPurchaseReturn,
  processRefund
} = require('../controllers/purchaseReturnController');

const {
  createFreightBill,
  updateFreightBill,
  confirmFreightBill,
  listFreightBills,
  getFreightBill,
  deleteFreightBill,
  getFreightAnalysis
} = require('../controllers/freightBillController');

const { protect, authorize } = require('../middleware/auth');
const { requirePermission, requireAnyPermission } = require('../middleware/rbacMiddleware');

// GRNs are needed by GRN UI and by purchase-return creation (select confirmed GRN)
const canReadGrn = requireAnyPermission([
  { resource: 'grn', action: 'read' },
  { resource: 'purchase_returns', action: 'read' },
  { resource: 'purchase_returns', action: 'create' },
]);
const logAction = require('../middleware/logAction');

router.use(protect);

// ========== WAREHOUSE ROUTES ==========
router.route('/warehouses')
  .get(getWarehouses)
  .post(authorize('admin', 'stock_manager'), logAction('stock'), createWarehouse);

router.route('/warehouses/:id')
  .get(getWarehouse)
  .put(authorize('admin', 'stock_manager'), logAction('stock'), updateWarehouse)
  .delete(authorize('admin'), logAction('stock'), deleteWarehouse);

router.get('/warehouses/:id/inventory', getWarehouseInventory);

// ========== INVENTORY BATCH ROUTES ==========
router.route('/batches')
  .get(getInventoryBatches)
  .post(authorize('admin', 'stock_manager'), logAction('stock'), createInventoryBatch);

router.route('/batches/:id')
  .get(getInventoryBatch)
  .put(authorize('admin', 'stock_manager'), logAction('stock'), updateInventoryBatch);

router.post('/batches/:id/consume', authorize('admin', 'stock_manager'), logAction('stock'), consumeFromBatch);

router.get('/batches/expiring', getExpiringBatches);
router.get('/batches/product/:productId', getProductBatches);

// ========== SERIAL NUMBER ROUTES ==========
router.route('/serial-numbers')
  .get(getSerialNumbers)
  .post(authorize('admin', 'stock_manager'), logAction('stock'), createSerialNumber);

router.route('/serial-numbers/:id')
  .get(getSerialNumber)
  .put(authorize('admin', 'stock_manager'), logAction('stock'), updateSerialNumber);

router.post('/serial-numbers/:id/sell', authorize('admin', 'stock_manager'), logAction('stock'), sellSerialNumber);
router.post('/serial-numbers/:id/return', authorize('admin', 'stock_manager'), logAction('stock'), returnSerialNumber);

router.get('/serial-numbers/lookup/:serial', lookupSerialNumber);
router.get('/serial-numbers/product/:productId/available', getAvailableSerials);

// ========== STOCK TRANSFER ROUTES ==========
router.route('/transfers')
  .get(getStockTransfers)
  .post(authorize('admin', 'stock_manager'), logAction('stock'), createStockTransfer);

router.route('/transfers/:id')
  .get(getStockTransfer)
  .post(authorize('admin'), approveStockTransfer);

router.post('/transfers/:id/approve', authorize('admin'), logAction('stock'), approveStockTransfer);
router.post('/transfers/:id/complete', authorize('admin', 'stock_manager'), logAction('stock'), completeStockTransfer);
router.post('/transfers/:id/cancel', authorize('admin'), logAction('stock'), cancelStockTransfer);

// ========== STOCK AUDIT ROUTES ==========
router.route('/audits')
  .get(getStockAudits)
  .post(authorize('admin', 'stock_manager'), logAction('stock'), createStockAudit);

router.route('/audits/:id')
  .get(getStockAudit);

// router.put('/audits/:id/items/:itemId', authorize('admin', 'stock_manager'), updateAuditItem); // Function not implemented
// router.post('/audits/:id/complete', authorize('admin'), logAction('stock'), completeStockAudit); // Not implemented
// router.post('/audits/:id/cancel', authorize('admin'), logAction('stock'), cancelStockAudit); // Not implemented
// router.get('/audits/:id/variance', getAuditVariance); // Not implemented

// ========== REORDER POINT ROUTES ==========
router.route('/reorder-points')
  .get(getReorderPoints)
  .post(authorize('admin', 'stock_manager'), logAction('stock'), createReorderPoint);

// Place static/specific routes before the parameterized :id route to avoid route conflicts
router.get('/reorder-points/needing-reorder', getProductsNeedingReorder);

router.route('/reorder-points/:id')
  .get(getReorderPoint)
  .put(authorize('admin', 'stock_manager'), logAction('stock'), updateReorderPoint)
  .delete(authorize('admin'), logAction('stock'), deleteReorderPoint);
router.post('/reorder-points/bulk', authorize('admin', 'stock_manager'), logAction('stock'), bulkCreateReorderPoints);

// Auto-reorder routes
const { 
  applyReorderPointToProduct, 
  triggerAutoReorderCheck 
} = require('../controllers/reorderPointController');

router.post('/reorder-points/apply-to-product', authorize('admin', 'stock_manager'), logAction('stock'), applyReorderPointToProduct);
router.post('/reorder-points/trigger-auto-check', authorize('admin', 'stock_manager'), triggerAutoReorderCheck);

// ========== PURCHASE ORDER ROUTES ==========
router.route('/purchase-orders')
  .get(requirePermission('purchase_orders', 'read'), getPurchaseOrders)
  .post(requirePermission('purchase_orders', 'create'), logAction('stock'), createPurchaseOrder);

router.route('/purchase-orders/:id')
  .get(requirePermission('purchase_orders', 'read'), getPurchaseOrder)
  .put(requirePermission('purchase_orders', 'update'), logAction('stock'), updatePurchaseOrder);

router.post('/purchase-orders/:id/approve', requirePermission('purchase_orders', 'approve'), logAction('stock'), approvePurchaseOrder);
router.post('/purchase-orders/:id/cancel', requirePermission('purchase_orders', 'delete'), logAction('stock'), cancelPurchaseOrder);
router.post('/purchase-orders/:id/payment', requirePermission('ap_payments', 'create'), logAction('stock'), recordPOPayment);

// ========== GRN ROUTES ==========
router.get('/grn', canReadGrn, listGRNs);
router.post('/grn', requirePermission('grn', 'create'), logAction('stock'), createGRN);
router.get('/grn/:id', canReadGrn, getGRN);
router.put('/grn/:id', requirePermission('grn', 'update'), logAction('stock'), updateGRN);
router.delete('/grn/:id', requirePermission('grn', 'delete'), logAction('stock'), deleteGRN);
router.post('/grn/:id/confirm', requirePermission('grn', 'confirm'), logAction('stock'), confirmGRN);

// ========== PURCHASE RETURNS ==========
router.route('/purchase-returns')
  .get(requirePermission('purchase_returns', 'read'), listPurchaseReturns)
  .post(requirePermission('purchase_returns', 'create'), logAction('stock'), createPurchaseReturn);

router.route('/purchase-returns/:id')
  .get(requirePermission('purchase_returns', 'read'), getPurchaseReturn)
  .put(requirePermission('purchase_returns', 'update'), logAction('stock'), updatePurchaseReturn);

router.route('/purchase-returns/:id/confirm')
  .post(requirePermission('purchase_returns', 'confirm'), logAction('stock'), confirmPurchaseReturn)
  .put(requirePermission('purchase_returns', 'confirm'), logAction('stock'), confirmPurchaseReturn);

router.route('/purchase-returns/:id/refund')
  .post(requirePermission('purchase_returns', 'update'), logAction('stock'), processRefund);

// ========== FREIGHT BILLS ==========
router.route('/freight-bills')
  .get(requirePermission('grn', 'read'), listFreightBills)
  .post(requirePermission('grn', 'create'), logAction('stock'), createFreightBill);

router.route('/freight-bills/:id')
  .get(requirePermission('grn', 'read'), getFreightBill)
  .put(requirePermission('grn', 'update'), logAction('stock'), updateFreightBill)
  .delete(requirePermission('grn', 'delete'), logAction('stock'), deleteFreightBill);

router.post('/freight-bills/:id/confirm', requirePermission('grn', 'confirm'), logAction('stock'), confirmFreightBill);

router.get('/freight-analysis', requirePermission('grn', 'read'), getFreightAnalysis);

module.exports = router;
