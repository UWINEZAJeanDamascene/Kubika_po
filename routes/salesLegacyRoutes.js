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
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');

// All routes require authentication
router.use(protect);

const canCreateSale = requirePosPermissions({ resource: 'point_of_sale', action: 'create' });
const canReadPosCatalog = requireAnyPosPermission(
  { resource: 'point_of_sale', action: 'read' },
  { resource: 'products', action: 'read' },
);
const canReadSale = requirePosPermissions({ resource: 'point_of_sale', action: 'read' });
const canManageHeldSales = requirePosPermissions({ resource: 'point_of_sale', action: 'create' });
const canManagePromotions = requirePermissionOrRoles('sales_invoices', 'approve', ['admin', 'manager']);

router.route('/held-sales')
  .get(canManageHeldSales, heldSaleController.listHeldSales)
  .post(canManageHeldSales, heldSaleController.createHeldSale);
router.delete('/held-sales/:heldSaleId', canManageHeldSales, heldSaleController.deleteHeldSale);
router.get('/promotions', canReadPosCatalog, posPromotionController.list);
router.get('/promotions/manage', canManagePromotions, posPromotionController.list);
router.post('/promotions', canManagePromotions, posPromotionController.create);
router.patch('/promotions/:promotionId/active', canManagePromotions, posPromotionController.setActive);

// Canonical POS checkout (the only supported sale write path)
router.post('/direct-sale', canCreateSale, logAction('sales_legacy_direct_sale'), createDirectSale);

// Get products for POS with stock availability
router.get('/products', canReadPosCatalog, getPosProducts);
router.get('/products/:productId/serial-numbers', canReadPosCatalog, getPosAvailableSerialNumbers);

// Get receipt for printing
router.get('/receipt/:invoiceId', canReadSale, getReceipt);

module.exports = router;
