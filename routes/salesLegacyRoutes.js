const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const logAction = require('../middleware/logAction');
const { requirePosPermissions } = require('../middleware/posAuthorization');
const heldSaleController = require('../controllers/posHeldSaleController');
const {
  createDirectSale,
  getPosProducts,
  getReceipt
} = require('../controllers/salesLegacyController');

// All routes require authentication
router.use(protect);

const canCreateSale = requirePosPermissions({ resource: 'sales_invoices', action: 'create' });
const canReadPosCatalog = requirePosPermissions(
  { resource: 'sales_invoices', action: 'create' },
  { resource: 'products', action: 'read' },
);
const canReadSale = requirePosPermissions({ resource: 'sales_invoices', action: 'read' });
const canManageHeldSales = requirePosPermissions({ resource: 'sales_invoices', action: 'create' });

router.route('/held-sales')
  .get(canManageHeldSales, heldSaleController.listHeldSales)
  .post(canManageHeldSales, heldSaleController.createHeldSale);
router.delete('/held-sales/:heldSaleId', canManageHeldSales, heldSaleController.deleteHeldSale);

// Direct sale endpoint (Legacy/Direct POS workflow)
router.post('/direct-sale', canCreateSale, logAction('sales_legacy_direct_sale'), createDirectSale);

// Get products for POS with stock availability
router.get('/products', canReadPosCatalog, getPosProducts);

// Get receipt for printing
router.get('/receipt/:invoiceId', canReadSale, getReceipt);

module.exports = router;
