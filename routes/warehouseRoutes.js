const express = require('express');
const router = express.Router();
const {
  getWarehouses,
  getWarehouse,
  createWarehouse,
  updateWarehouse,
  deleteWarehouse,
  getWarehouseInventory
} = require('../controllers/warehouseController');
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const logAction = require('../middleware/logAction');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

router.use(protect);

// Warehouses are reference data: read on nearly every stock screen, changed
// rarely. Writes invalidate the whole type so a rename shows up immediately.
const cacheWarehouses = cacheMiddleware({ type: 'warehouse', ttl: 600 });
const invalidateWarehouses = cacheInvalidationMiddleware({ type: 'warehouse', invalidateAll: true });

router.route('/')
  .get(requirePermissionOrRoles('warehouses', 'read', ['admin', 'stock_manager', 'warehouse_manager']), cacheWarehouses, getWarehouses)
  .post(requirePermissionOrRoles('warehouses', 'create', ['admin', 'stock_manager', 'warehouse_manager']), logAction('warehouse'), invalidateWarehouses, createWarehouse);

router.route('/:id')
  .get(requirePermissionOrRoles('warehouses', 'read', ['admin', 'stock_manager', 'warehouse_manager']), cacheWarehouses, getWarehouse)
  .put(requirePermissionOrRoles('warehouses', 'update', ['admin', 'stock_manager', 'warehouse_manager']), logAction('warehouse'), invalidateWarehouses, updateWarehouse)
  .delete(requirePermissionOrRoles('warehouses', 'delete', ['admin']), logAction('warehouse'), invalidateWarehouses, deleteWarehouse);

// Deliberately NOT cached: this returns live stock quantities, which are
// transacted against. A 10-minute-old quantity here could let someone commit
// against stock that is already gone.
router.get('/:id/inventory', requirePermissionOrRoles('warehouses', 'read', ['admin', 'stock_manager', 'warehouse_manager']), getWarehouseInventory);

module.exports = router;
