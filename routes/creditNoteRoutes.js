const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requireAssignedPermissions: requirePermission } = require('../middleware/posAuthorization');
const controller = require('../controllers/creditNoteController');

router.use(protect);

// Module 8 API Endpoints:
// POST /api/credit-notes - Create draft (requires invoice_id)
// PUT /api/credit-notes/:id - Edit (draft only)
// POST /api/credit-notes/:id/confirm - Confirm (triggers dual reversal + stock return)
// GET /api/credit-notes - List with filters
// GET /api/credit-notes/:id - Full credit note with lines and journal entries
// DELETE /api/credit-notes/:id - Delete draft credit notes

router.route('/')
  .get(requirePermission('credit_notes', 'read'), controller.getCreditNotes)
  .post(requirePermission('credit_notes', 'create'), controller.createCreditNote);

router.route('/:id')
  .get(requirePermission('credit_notes', 'read'), controller.getCreditNote)
  .put(requirePermission('credit_notes', 'update'), controller.updateCreditNote)
  .delete(requirePermission('credit_notes', 'delete'), controller.deleteCreditNote);

router.get('/:id/pdf', requirePermission('credit_notes', 'read'), controller.generateCreditNotePDF);

// Module 8: Confirm credit note - triggers dual journal reversal + stock return
router.post('/:id/confirm', requirePermission('credit_notes', 'approve'), controller.confirmCreditNote);
router.post('/:id/submit-ebm', requirePermission('credit_notes', 'approve'), controller.submitCreditNoteEbm);

// Legacy endpoints (backwards compatibility)
router.put('/:id/approve', requirePermission('credit_notes', 'approve'), controller.approveCreditNote);
router.post('/:id/apply', requirePermission('credit_notes', 'approve'), controller.applyCreditNote); // Apply to another invoice
router.post('/:id/refund', requirePermission('credit_notes', 'approve'), controller.recordRefund);

module.exports = router;
