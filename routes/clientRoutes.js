const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const {
  getClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
  getClientPurchaseHistory,
  getClientOutstandingInvoices,
  toggleClientStatus,
  getClientsWithStats,
  exportClientsToPDF,
  getClientInvoices,
  getClientReceipts,
  getClientCreditNotes,
  getClientStatementPDF,
  verifyClientTin,
  saveClientBranchCustomer
} = require('../controllers/clientController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbacMiddleware');
const logAction = require('../middleware/logAction');
const validateRequest = require('../middleware/validateRequest');
const stripUnvalidatedBody = require('../middleware/stripUnvalidatedBody');

router.use(protect);

router.route('/')
  .get(requirePermission('clients', 'read'), getClients)
  .post(requirePermission('clients', 'create'), logAction('client'), createClient);

// New route for clients with stats (for list view with outstanding invoice counts)
router.get('/with-stats', requirePermission('clients', 'read'), getClientsWithStats);

// Export route
router.get('/export/pdf', requirePermission('clients', 'read'), exportClientsToPDF);

router.route('/:id')
  .get(requirePermission('clients', 'read'), getClient)
  .put(requirePermission('clients', 'update'), logAction('client'), updateClient)
  .delete(requirePermission('clients', 'delete'), logAction('client'), deleteClient);

// Toggle status
router.put('/:id/toggle-status', requirePermission('clients', 'update'), toggleClientStatus);
router.post(
  '/:id/ebm/verify-tin',
  requirePermission('clients', 'update'),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  validateRequest,
  stripUnvalidatedBody,
  verifyClientTin,
);
router.post(
  '/:id/ebm/branch-customer',
  requirePermission('clients', 'update'),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  validateRequest,
  stripUnvalidatedBody,
  saveClientBranchCustomer,
);

router.get('/:id/purchase-history', requirePermission('clients', 'read'), getClientPurchaseHistory);
router.get('/:id/outstanding-invoices', requirePermission('clients', 'read'), getClientOutstandingInvoices);

// Client detail endpoints
router.get('/:id/invoices', requirePermission('clients', 'read'), getClientInvoices);
router.get('/:id/receipts', requirePermission('clients', 'read'), getClientReceipts);
router.get('/:id/credit-notes', requirePermission('clients', 'read'), getClientCreditNotes);
router.get('/:id/statement', requirePermission('clients', 'read'), getClientStatementPDF);

module.exports = router;

