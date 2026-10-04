const express = require('express');
const router = express.Router();
const {
  getPurchases,
  getPurchase,
  createPurchase,
  updatePurchase,
  deletePurchase,
  receivePurchase,
  recordPayment,
  cancelPurchase,
  getSupplierPurchases,
  generatePurchasePDF
} = require('../controllers/purchaseController');
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const logAction = require('../middleware/logAction');

router.use(protect);

router.route('/')
  .get(requirePermissionOrRoles('purchase_orders', 'read', ['admin']), getPurchases)
  .post(requirePermissionOrRoles('purchase_orders', 'create', ['admin']), logAction('purchase'), createPurchase);

router.route('/:id')
  .get(requirePermissionOrRoles('purchase_orders', 'read', ['admin']), getPurchase)
  .put(requirePermissionOrRoles('purchase_orders', 'update', ['admin']), logAction('purchase'), updatePurchase)
  .delete(requirePermissionOrRoles('purchase_orders', 'delete', ['admin']), logAction('purchase'), deletePurchase);

// Receive purchase (add stock)
router.put('/:id/receive', requirePermissionOrRoles('purchase_orders', 'update', ['admin']), logAction('purchase'), receivePurchase);

// Record payment
router.post('/:id/payment', requirePermissionOrRoles('ap_payments', 'create', ['admin']), logAction('purchase'), recordPayment);

// Cancel purchase
router.put('/:id/cancel', requirePermissionOrRoles('purchase_orders', 'delete', ['admin']), logAction('purchase'), cancelPurchase);

// PDF generation
router.get('/:id/pdf', requirePermissionOrRoles('purchase_orders', 'read', ['admin']), generatePurchasePDF);

// Supplier specific routes
router.get('/supplier/:supplierId', requirePermissionOrRoles('purchase_orders', 'read', ['admin']), getSupplierPurchases);

module.exports = router;
