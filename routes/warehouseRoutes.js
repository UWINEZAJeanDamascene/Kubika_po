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
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

router.use(protect);

// Warehouses are reference data: read on nearly every stock screen, changed
// rarely. Writes invalidate the whole type so a rename shows up immediately.
const cacheWarehouses = cacheMiddleware({ type: 'warehouse', ttl: 600 });
const invalidateWarehouses = cacheInvalidationMiddleware({ type: 'warehouse', invalidateAll: true });

router.route('/')
  .get(cacheWarehouses, getWarehouses)
  .post(authorize('admin', 'stock_manager'), logAction('warehouse'), invalidateWarehouses, createWarehouse);

router.route('/:id')
  .get(cacheWarehouses, getWarehouse)
  .put(authorize('admin', 'stock_manager'), logAction('warehouse'), invalidateWarehouses, updateWarehouse)
  .delete(authorize('admin'), logAction('warehouse'), invalidateWarehouses, deleteWarehouse);

// Deliberately NOT cached: this returns live stock quantities, which are
// transacted against. A 10-minute-old quantity here could let someone commit
// against stock that is already gone.
router.get('/:id/inventory', getWarehouseInventory);

module.exports = router;