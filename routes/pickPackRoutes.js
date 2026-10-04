const express = require('express');
const router = express.Router();
const {
  getPickPacks,
  getPickPack,
  createPickPack,
  assignPickPack,
  startPicking,
  pickItems,
  completePicking,
  startPacking,
  packItems,
  completePacking,
  reportIssue,
  getMyTasks,
  getPendingPick,
  getPendingPack,
  cancelPickPack
} = require('../controllers/pickPackController');
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const logAction = require('../middleware/logAction');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

const cachePickPackReads = cacheMiddleware({
  type: 'pick_pack',
  ttl: 30,
  varyByUser: true,
  skipCache: (req) => req.query.refresh === '1' || req.query.refresh === 'true',
});
const invalidatePickPackReads = cacheInvalidationMiddleware({
  types: ['pick_pack', 'sales_order', 'stock', 'report'],
  invalidateDashboards: true,
});

router.use(protect);
router.use(invalidatePickPackReads);

// Special routes (must come before :id routes)
router.get('/my-tasks', requirePermissionOrRoles('pick_packs', 'read', ['admin', 'stock_manager', 'warehouse', 'warehouse_manager']), cachePickPackReads, getMyTasks);
router.get('/pending-pick', requirePermissionOrRoles('pick_packs', 'read', ['admin', 'stock_manager', 'warehouse', 'warehouse_manager']), cachePickPackReads, getPendingPick);
router.get('/pending-pack', requirePermissionOrRoles('pick_packs', 'read', ['admin', 'stock_manager', 'warehouse', 'warehouse_manager']), cachePickPackReads, getPendingPack);

// Main routes
router.route('/')
  .get(requirePermissionOrRoles('pick_packs', 'read', ['admin', 'stock_manager', 'warehouse', 'warehouse_manager']), cachePickPackReads, getPickPacks)
  .post(requirePermissionOrRoles('pick_packs', 'create', ['admin', 'stock_manager', 'warehouse', 'warehouse_manager']), logAction('pick_pack'), createPickPack);

router.route('/:id')
  .get(requirePermissionOrRoles('pick_packs', 'read', ['admin', 'stock_manager', 'warehouse', 'warehouse_manager']), cachePickPackReads, getPickPack);

// Assignment
router.post('/:id/assign', requirePermissionOrRoles('pick_packs', 'update', ['admin', 'stock_manager']), logAction('pick_pack'), assignPickPack);

// Picking workflow
router.post('/:id/start-picking', requirePermissionOrRoles('pick_packs', 'update', ['admin', 'stock_manager', 'warehouse', 'warehouse_manager']), logAction('pick_pack'), startPicking);
router.post('/:id/pick-items', requirePermissionOrRoles('pick_packs', 'update', ['admin', 'stock_manager', 'warehouse', 'warehouse_manager']), logAction('pick_pack'), pickItems);
router.post('/:id/complete-picking', requirePermissionOrRoles('pick_packs', 'update', ['admin', 'stock_manager', 'warehouse', 'warehouse_manager']), logAction('pick_pack'), completePicking);

// Packing workflow
router.post('/:id/start-packing', requirePermissionOrRoles('pick_packs', 'update', ['admin', 'stock_manager', 'warehouse', 'warehouse_manager']), logAction('pick_pack'), startPacking);
router.post('/:id/pack-items', requirePermissionOrRoles('pick_packs', 'update', ['admin', 'stock_manager', 'warehouse', 'warehouse_manager']), logAction('pick_pack'), packItems);
router.post('/:id/complete-packing', requirePermissionOrRoles('pick_packs', 'update', ['admin', 'stock_manager', 'warehouse', 'warehouse_manager']), logAction('pick_pack'), completePacking);

// Issue reporting
router.post('/:id/report-issue', requirePermissionOrRoles('pick_packs', 'update', ['admin', 'stock_manager', 'warehouse', 'warehouse_manager']), logAction('pick_pack'), reportIssue);

// Cancel
router.post('/:id/cancel', requirePermissionOrRoles('pick_packs', 'delete', ['admin', 'stock_manager']), logAction('pick_pack'), cancelPickPack);

module.exports = router;
