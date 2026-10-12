const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const logAction = require('../middleware/logAction');
const { requirePosPermissions, requireAnyPosPermission } = require('../middleware/posAuthorization');
const heldSaleController = require('../controllers/posHeldSaleController');
const {
  createDirectSale,
  getPosProducts,
  getPosAvailableSerialNumbers,
} = require('../controllers/salesLegacyController');
// Canonical printable receipt (shared with the retired /api/pos/sale/:id/receipt alias)
const { getReceipt } = require('../controllers/posController');
const posPromotionController = require('../controllers/posPromotionController');
const posOfflineController = require('../controllers/posOfflineController');
const priceListController = require('../controllers/priceListController');
const posStoredValueController = require('../controllers/posStoredValueController');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');

// All routes require authentication
router.use(protect);

const canCreateSale = requirePosPermissions({ resource: 'point_of_sale', action: 'create' });
const canReadPosCatalog = requireAnyPosPermission(
  { resource: 'point_of_sale', action: 'read' },
  { resource: 'products', action: 'read' },
);
const canReadStoredValue = requireAnyPosPermission(
  { resource: 'point_of_sale', action: 'read' },
  { resource: 'point_of_sale', action: 'create' },
);
const canReadSale = requirePosPermissions({ resource: 'point_of_sale', action: 'read' });
const canManageHeldSales = requirePosPermissions({ resource: 'point_of_sale', action: 'create' });
const canManagePromotions = requirePermissionOrRoles('sales_invoices', 'approve', ['admin', 'manager']);
const canManagePriceLists = requirePermissionOrRoles('warehouses', 'update', ['admin', 'manager', 'warehouse_manager']);

router.route('/held-sales')
  .get(canManageHeldSales, heldSaleController.listHeldSales)
  .post(canManageHeldSales, heldSaleController.createHeldSale);
router.delete('/held-sales/:heldSaleId', canManageHeldSales, heldSaleController.deleteHeldSale);
router.get('/promotions', canReadPosCatalog, posPromotionController.list);
router.get('/promotions/manage', canManagePromotions, posPromotionController.list);
router.post('/promotions', canManagePromotions, posPromotionController.create);
router.patch('/promotions/:promotionId/active', canManagePromotions, posPromotionController.setActive);
router.get('/price-lists/manage', canManagePriceLists, priceListController.listManage);
router.post('/price-lists', canManagePriceLists, priceListController.create);
router.patch('/price-lists/:priceListId', canManagePriceLists, priceListController.update);
router.put('/price-lists/:priceListId/prices', canManagePriceLists, priceListController.replacePrices);
router.put('/warehouses/:warehouseId/price-list', canManagePriceLists, priceListController.assignWarehouse);
router.get('/stored-value/balance', canReadStoredValue, posStoredValueController.lookup);
router.post('/stored-value/issue', canManagePromotions, posStoredValueController.issue);

// Canonical POS checkout (the only supported sale write path)
router.post('/direct-sale', canCreateSale, logAction('sales_legacy_direct_sale'), createDirectSale);
router.post('/offline-snapshot', canCreateSale, posOfflineController.issueSnapshot);
router.get('/offline-conflicts', canManagePromotions, posOfflineController.listConflicts);
router.post('/offline-conflicts/:conflictId/resolve', canManagePromotions, posOfflineController.resolveConflict);

// Get products for POS with stock availability
router.get('/products', canReadPosCatalog, getPosProducts);
router.get('/products/:productId/serial-numbers', canReadPosCatalog, getPosAvailableSerialNumbers);

// Get receipt for printing
router.get('/receipt/:invoiceId', canReadSale, getReceipt);

module.exports = router;
