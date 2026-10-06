const express = require('express');
const router = express.Router();
const {
  getAgingReport,
  getClientStatement
} = require('../controllers/arController');
const receipts = require('../controllers/arReceiptController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbacMiddleware');

router.use(protect);

// Receipt transactions are controlled source documents; posting and reversal
// write matching journal entries and update the invoice/customer subledgers.
router.route('/receipts')
  .get(requirePermission('ar_receipts', 'read'), receipts.getReceipts)
  .post(requirePermission('ar_receipts', 'create'), receipts.createReceipt);
router.route('/receipts/:id')
  .get(requirePermission('ar_receipts', 'read'), receipts.getReceipt)
  .put(requirePermission('ar_receipts', 'update'), receipts.updateReceipt);
router.post('/receipts/:id/allocate', requirePermission('ar_receipts', 'update'), receipts.allocateReceipt);
router.post('/receipts/:id/post', requirePermission('ar_receipts', 'create'), receipts.postReceipt);
router.post('/receipts/:id/reverse', requirePermission('ar_receipts', 'reverse'), receipts.reverseReceipt);

// Aging report (all outstanding invoices grouped by age)
router.get('/aging', requirePermission('ar_receipts', 'read'), getAgingReport);

// Client statement (transaction history per customer)
router.get('/statement/:client_id', requirePermission('ar_receipts', 'read'), getClientStatement);

module.exports = router;
