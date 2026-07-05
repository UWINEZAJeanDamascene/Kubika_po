const express = require('express');
const router = express.Router();
const {
  getInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  deleteInvoice,
  confirmInvoice,
  recordPayment,
  writeOffInvoiceBadDebt,
  cancelInvoice,
  saveReceiptMetadata,
  verifyInvoiceCustomerTin,
  getClientInvoices,
  getProductInvoices,
  generateInvoicePDF,
  sendInvoiceEmail
} = require('../controllers/invoiceController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbacMiddleware');
const logAction = require('../middleware/logAction');

router.use(protect);

router.route('/')
  .get(requirePermission('sales_invoices', 'read'), getInvoices)
  .post(requirePermission('sales_invoices', 'create'), logAction('invoice'), createInvoice);

router.route('/:id')
  .get(requirePermission('sales_invoices', 'read'), getInvoice)
  .put(requirePermission('sales_invoices', 'update'), logAction('invoice'), updateInvoice)
  .delete(requirePermission('sales_invoices', 'delete'), logAction('invoice'), deleteInvoice);

// Confirm invoice (deducts stock)
router.put('/:id/confirm', requirePermission('sales_invoices', 'approve'), logAction('invoice'), confirmInvoice);

router.post('/:id/ebm/verify-tin', requirePermission('sales_invoices', 'update'), verifyInvoiceCustomerTin);
// Record payment
router.post('/:id/payment', requirePermission('ar_receipts', 'create'), logAction('invoice'), recordPayment);

// Write off as bad debt (AR decreases)
router.post('/:id/write-off', requirePermission('ar_receipts', 'reverse'), logAction('invoice'), writeOffInvoiceBadDebt);

// Cancel invoice (reverses stock)
router.put('/:id/cancel', requirePermission('sales_invoices', 'delete'), logAction('invoice'), cancelInvoice);

// Save receipt metadata (SDC/Receipt info)
router.post('/:id/receipt-metadata', requirePermission('sales_invoices', 'update'), saveReceiptMetadata);

// PDF generation
router.get('/:id/pdf', requirePermission('sales_invoices', 'read'), generateInvoicePDF);

// Send invoice via email
router.post('/:id/send-email', requirePermission('sales_invoices', 'send'), logAction('invoice'), sendInvoiceEmail);

// Client and product specific routes
router.get('/client/:clientId', requirePermission('sales_invoices', 'read'), getClientInvoices);
router.get('/product/:productId', requirePermission('sales_invoices', 'read'), getProductInvoices);

module.exports = router;
