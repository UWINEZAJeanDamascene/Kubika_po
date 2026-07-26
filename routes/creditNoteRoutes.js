const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
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
  .get(controller.getCreditNotes)
  .post(controller.createCreditNote);

router.route('/:id')
  .get(controller.getCreditNote)
  .put(controller.updateCreditNote)
  .delete(controller.deleteCreditNote);

router.get('/:id/pdf', controller.generateCreditNotePDF);

// Module 8: Confirm credit note - triggers dual journal reversal + stock return
router.post('/:id/confirm', controller.confirmCreditNote);
router.post('/:id/submit-ebm', controller.submitCreditNoteEbm);

// Legacy endpoints (backwards compatibility)
router.put('/:id/approve', controller.approveCreditNote);
router.post('/:id/apply', controller.applyCreditNote); // Apply to another invoice
router.post('/:id/refund', controller.recordRefund);

module.exports = router;
