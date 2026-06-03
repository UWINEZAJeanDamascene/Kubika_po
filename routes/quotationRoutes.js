const express = require('express');
const router = express.Router();
const {
  getQuotations,
  getQuotation,
  createQuotation,
  updateQuotation,
  deleteQuotation,
  sendQuotation,
  acceptQuotation,
  rejectQuotation,
  approveQuotation,
  convertToInvoice,
  convertToSalesOrder,
  getClientQuotations,
  getProductQuotations,
  generateQuotationPDF,
  publicAcceptQuotation,
  publicRejectQuotation,
  publicQuotationPDF,
  markExpiredQuotations
} = require('../controllers/quotationController');
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');

// Public token routes (no protect)
router.post('/public/:token/accept', publicAcceptQuotation);
router.post('/public/:token/reject', publicRejectQuotation);
router.get('/public/:token/pdf', publicQuotationPDF);

router.use(protect);

router.route('/')
  .get(getQuotations)
  .post(authorize('admin', 'sales'), logAction('quotation'), createQuotation);

// PDF route must come BEFORE :id route
router.get('/:id/pdf', generateQuotationPDF);

router.route('/:id')
  .get(getQuotation)
  .put(authorize('admin', 'sales'), logAction('quotation'), updateQuotation)
  .delete(authorize('admin', 'sales'), logAction('quotation'), deleteQuotation);

// Status transition routes
router.post('/:id/send', authorize('admin', 'sales'), logAction('quotation'), sendQuotation);
router.post('/:id/accept', authorize('admin'), logAction('quotation'), acceptQuotation);
router.post('/:id/reject', authorize('admin'), logAction('quotation'), rejectQuotation);
// Deprecated - kept for backward compatibility
router.put('/:id/approve', authorize('admin'), logAction('quotation'), approveQuotation);
router.post('/:id/convert', authorize('admin', 'sales'), logAction('quotation'), convertToSalesOrder);
// Old convert route (kept for backward compatibility)
router.post('/:id/convert-to-invoice', authorize('admin', 'sales'), logAction('quotation'), convertToInvoice);
// NEW WORKFLOW: Convert to Sales Order
router.post('/:id/convert-to-so', authorize('admin', 'sales'), logAction('quotation'), convertToSalesOrder);

// Expiry enforcement (cron/manual)
router.post('/expire', authorize('admin'), markExpiredQuotations);

router.get('/client/:clientId', getClientQuotations);
router.get('/product/:productId', getProductQuotations);

module.exports = router;
