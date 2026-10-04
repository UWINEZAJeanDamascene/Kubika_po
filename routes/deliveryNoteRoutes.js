const express = require('express');
const router = express.Router();
const {
  getDeliveryNotes,
  getDeliveryNote,
  createDeliveryNote,
  updateDeliveryNote,
  deleteDeliveryNote,
  confirmDelivery,
  dispatchDeliveryNote,
  markDelivered,
  cancelDeliveryNote,
  createInvoiceFromDeliveryNote,
  getInvoiceDeliveryNotes,
  getQuotationDeliveryNotes,
  generateDeliveryNotePDF,
  updateLineDeliveryQty,
  updateItemDeliveryQty // Legacy
} = require('../controllers/deliveryNoteController');
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const logAction = require('../middleware/logAction');

router.use(protect);

router.route('/')
  .get(requirePermissionOrRoles('delivery_notes', 'read', ['admin', 'sales', 'stock_manager', 'warehouse_manager']), getDeliveryNotes)
  .post(requirePermissionOrRoles('delivery_notes', 'create', ['admin', 'sales', 'stock_manager', 'warehouse_manager']), logAction('delivery_note'), createDeliveryNote);

// PDF route must come BEFORE :id route
router.get('/:id/pdf', requirePermissionOrRoles('delivery_notes', 'read', ['admin', 'sales', 'stock_manager', 'warehouse_manager']), generateDeliveryNotePDF);

// Get delivery notes for an invoice (Module 7)
router.get('/invoice/:invoiceId', requirePermissionOrRoles('delivery_notes', 'read', ['admin', 'sales', 'stock_manager', 'warehouse_manager']), getInvoiceDeliveryNotes);

// Get delivery notes for a quotation (legacy)
router.get('/quotation/:quotationId', requirePermissionOrRoles('delivery_notes', 'read', ['admin', 'sales', 'stock_manager', 'warehouse_manager']), getQuotationDeliveryNotes);

router.route('/:id')
  .get(requirePermissionOrRoles('delivery_notes', 'read', ['admin', 'sales', 'stock_manager', 'warehouse_manager']), getDeliveryNote)
  .put(requirePermissionOrRoles('delivery_notes', 'update', ['admin', 'sales', 'stock_manager', 'warehouse_manager']), logAction('delivery_note'), updateDeliveryNote)
  .delete(requirePermissionOrRoles('delivery_notes', 'delete', ['admin', 'sales']), logAction('delivery_note'), deleteDeliveryNote);

router.route('/:id/confirm')
  .post(requirePermissionOrRoles('delivery_notes', 'update', ['admin', 'sales', 'stock_manager', 'warehouse_manager']), logAction('delivery_note'), confirmDelivery)
  .put(requirePermissionOrRoles('delivery_notes', 'update', ['admin', 'sales', 'stock_manager', 'warehouse_manager']), logAction('delivery_note'), confirmDelivery);

router.route('/:id/dispatch')
  .put(requirePermissionOrRoles('delivery_notes', 'update', ['admin', 'sales', 'stock_manager', 'warehouse_manager']), logAction('delivery_note'), dispatchDeliveryNote);

// Mark delivery note as delivered
router.route('/:id/deliver')
  .put(requirePermissionOrRoles('delivery_notes', 'update', ['admin', 'sales', 'stock_manager', 'warehouse_manager']), logAction('delivery_note'), markDelivered);

router.route('/:id/cancel')
  .post(requirePermissionOrRoles('delivery_notes', 'delete', ['admin']), logAction('delivery_note'), cancelDeliveryNote)
  .put(requirePermissionOrRoles('delivery_notes', 'delete', ['admin']), logAction('delivery_note'), cancelDeliveryNote);

// Update line delivery qty (Module 7)
router.put('/:id/lines/:lineId', requirePermissionOrRoles('delivery_notes', 'update', ['admin', 'sales', 'stock_manager', 'warehouse_manager']), logAction('delivery_note'), updateLineDeliveryQty);

// Legacy: Update item delivery qty (backwards compatibility)
router.put('/:id/items/:itemId', requirePermissionOrRoles('delivery_notes', 'update', ['admin', 'sales', 'stock_manager', 'warehouse_manager']), logAction('delivery_note'), updateItemDeliveryQty);

// Confirm delivery (Module 7: POST /api/delivery-notes/:id/confirm)
router.post('/:id/confirm', requirePermissionOrRoles('delivery_notes', 'update', ['admin', 'sales', 'stock_manager', 'warehouse_manager']), logAction('delivery_note'), confirmDelivery);

// Legacy: PUT confirm still works but deprecated
router.put('/:id/confirm', requirePermissionOrRoles('delivery_notes', 'update', ['admin', 'sales', 'stock_manager', 'warehouse_manager']), logAction('delivery_note'), confirmDelivery);

// Cancel delivery note
router.post('/:id/cancel', requirePermissionOrRoles('delivery_notes', 'delete', ['admin']), logAction('delivery_note'), cancelDeliveryNote);

// Legacy: PUT cancel still works but deprecated
router.put('/:id/cancel', requirePermissionOrRoles('delivery_notes', 'delete', ['admin']), logAction('delivery_note'), cancelDeliveryNote);

// Create invoice from delivery note (legacy - Module 7 uses invoice -> delivery flow)
router.post('/:id/create-invoice', requirePermissionOrRoles('delivery_notes', 'update', ['admin', 'sales']), logAction('delivery_note'), createInvoiceFromDeliveryNote);

module.exports = router;
