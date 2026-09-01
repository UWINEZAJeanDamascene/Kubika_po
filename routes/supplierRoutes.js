const express = require('express');
const router = express.Router();
const {
  getSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  getSupplierPurchaseHistory,
  toggleSupplierStatus
} = require('../controllers/supplierController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbacMiddleware');
const logAction = require('../middleware/logAction');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

const cacheSuppliers = cacheMiddleware({ type: 'supplier', ttl: 300 });
const invalidateSuppliers = cacheInvalidationMiddleware({ type: 'supplier' });

router.use(protect);

router.route('/')
  .get(requirePermission('suppliers', 'read'), cacheSuppliers, getSuppliers)
  .post(requirePermission('suppliers', 'create'), invalidateSuppliers, logAction('supplier'), createSupplier);

router.route('/:id')
  .get(requirePermission('suppliers', 'read'), cacheSuppliers, getSupplier)
  .put(requirePermission('suppliers', 'update'), invalidateSuppliers, logAction('supplier'), updateSupplier)
  .delete(requirePermission('suppliers', 'delete'), invalidateSuppliers, logAction('supplier'), deleteSupplier);

router.get('/:id/purchase-history', requirePermission('suppliers', 'read'), getSupplierPurchaseHistory);

router.put('/:id/toggle-status', requirePermission('suppliers', 'update'), invalidateSuppliers, logAction('supplier'), toggleSupplierStatus);

module.exports = router;
