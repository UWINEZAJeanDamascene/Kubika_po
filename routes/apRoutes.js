const express = require('express');
const router = express.Router();
const apController = require('../controllers/apController');
const { protect } = require('../middleware/authMiddleware');
const paymentController = require('../controllers/apPaymentController');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const logAction = require('../middleware/logAction');

// All routes require authentication
router.use(protect);

/**
 * AP reporting and supplier payment lifecycle.
 *
 * Core Principle: AP is an auto-generated ledger, NOT a transaction entry module.
 * All AP movements originate from source documents:
 *   - Purchase/GRN received          -> AP increases (Dr Inventory/Expense / Cr AP)
 *   - Payment recorded on GRN/Purchase -> AP decreases (Dr AP / Cr Cash/Bank)
 *   - Debit note issued             -> AP decreases (Dr AP / Cr Inventory/Expense)
 *   - Bad debt/write-off            -> AP decreases (Dr Expense / Cr AP)
 *
 * These endpoints return reports only. No manual transaction entry here.
 */

router.get('/aging', requirePermissionOrRoles('ap_payments', 'read', ['admin', 'accountant']), apController.getAgingReport);

// GET /api/ap/statement/:supplier_id - Supplier statement
router.get('/statement/:supplier_id', requirePermissionOrRoles('ap_payments', 'read', ['admin', 'accountant']), apController.getSupplierStatement);

router.get('/payments', requirePermissionOrRoles('ap_payments', 'read', ['admin', 'accountant']), paymentController.list);
router.get('/payments/:id', requirePermissionOrRoles('ap_payments', 'read', ['admin', 'accountant']), paymentController.get);
router.post('/payments', requirePermissionOrRoles('ap_payments', 'create', ['admin', 'accountant']), logAction('ap_payment'), paymentController.create);
router.put('/payments/:id', requirePermissionOrRoles('ap_payments', 'update', ['admin', 'accountant']), logAction('ap_payment'), paymentController.update);
router.post('/payments/:id/post', requirePermissionOrRoles('ap_payments', 'create', ['admin', 'accountant']), logAction('ap_payment'), paymentController.post);
router.post('/payments/:id/reverse', requirePermissionOrRoles('ap_payments', 'update', ['admin', 'accountant']), logAction('ap_payment'), paymentController.reverse);

module.exports = router;
