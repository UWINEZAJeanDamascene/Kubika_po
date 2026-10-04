const express = require('express');
const router = express.Router();
const {
  getPaymentSchedules,
  getPaymentSchedule,
  createPaymentSchedule,
  updatePaymentSchedule,
  deletePaymentSchedule,
  recordSchedulePayment,
  getSupplierStatement,
  reconcileSupplierStatement,
  getPayableAgingReport,
  getPayablesSummary,
  generateSchedulesFromPurchases
} = require('../controllers/payableController');
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const logAction = require('../middleware/logAction');

router.use(protect);

// Payment schedules CRUD
router.route('/schedules')
  .get(requirePermissionOrRoles('ap_payments', 'read', ['admin']), getPaymentSchedules)
  .post(requirePermissionOrRoles('ap_payments', 'create', ['admin']), logAction('payable'), createPaymentSchedule);

router.route('/schedules/:id')
  .get(requirePermissionOrRoles('ap_payments', 'read', ['admin']), getPaymentSchedule)
  .put(requirePermissionOrRoles('ap_payments', 'update', ['admin']), logAction('payable'), updatePaymentSchedule)
  .delete(requirePermissionOrRoles('ap_payments', 'delete', ['admin']), logAction('payable'), deletePaymentSchedule);

// Record payment for a schedule
router.post('/schedules/:id/pay', requirePermissionOrRoles('ap_payments', 'create', ['admin', 'accountant']), logAction('payable'), recordSchedulePayment);

// Supplier statement reconciliation
router.get('/supplier/:supplierId/statement', requirePermissionOrRoles('ap_payments', 'read', ['admin', 'accountant']), getSupplierStatement);
router.post('/supplier/:supplierId/reconcile', requirePermissionOrRoles('ap_payments', 'update', ['admin', 'accountant']), logAction('payable'), reconcileSupplierStatement);

// Payable aging report (enhanced version)
router.get('/aging', requirePermissionOrRoles('ap_payments', 'read', ['admin', 'accountant']), getPayableAgingReport);

// Payables dashboard summary
router.get('/summary', requirePermissionOrRoles('ap_payments', 'read', ['admin', 'accountant']), getPayablesSummary);

// Auto-generate payment schedules
router.post('/generate-schedules', requirePermissionOrRoles('ap_payments', 'create', ['admin']), logAction('payable'), generateSchedulesFromPurchases);

module.exports = router;
