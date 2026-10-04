const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const ebmController = require('../controllers/ebmController');
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const { attachCompanyId } = require('../middleware/companyContext');
const validateRequest = require('../middleware/validateRequest');
const stripUnvalidatedBody = require('../middleware/stripUnvalidatedBody');
const { cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

const invalidateWarehouses = cacheInvalidationMiddleware({ type: 'warehouse', invalidateAll: true });

router.use(protect);
router.use(attachCompanyId);

router.get('/devices', requirePermissionOrRoles('ebm', 'read', ['admin', 'stock_manager']), ebmController.getDeviceStatus);
router.get('/readiness', requirePermissionOrRoles('ebm', 'read', ['admin', 'stock_manager']), ebmController.getReadiness);
router.get('/codes/status', requirePermissionOrRoles('ebm', 'read', ['admin', 'stock_manager']), ebmController.getCodeSyncStatus);
router.get('/codes', requirePermissionOrRoles('ebm', 'read', ['admin', 'stock_manager']), ebmController.getCodes);
router.get('/codes/item-classes', requirePermissionOrRoles('ebm', 'read', ['admin', 'stock_manager']), ebmController.getItemClasses);
router.get('/codes/tins', requirePermissionOrRoles('ebm', 'read', ['admin', 'stock_manager']), ebmController.searchTINs);
router.post(
  '/customers/verify-tin',
  requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager', 'sales']),
  body('tin').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 9, max: 9 }),
  body('custmTin').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 9, max: 9 }),
  body('custTin').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 9, max: 9 }),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.verifyCustomerTin,
);
router.get('/notices', requirePermissionOrRoles('ebm', 'read', ['admin', 'stock_manager']), ebmController.getNotices);
router.get('/imports', requirePermissionOrRoles('ebm', 'read', ['admin', 'stock_manager']), ebmController.listImportedItems);
router.get('/purchases/unmatched', requirePermissionOrRoles('ebm', 'read', ['admin', 'stock_manager']), ebmController.listUnmatchedPurchases);
router.get('/queue', requirePermissionOrRoles('ebm', 'read', ['admin', 'stock_manager']), ebmController.listSubmissionQueue);
router.get('/alerts', requirePermissionOrRoles('ebm', 'read', ['admin', 'stock_manager']), ebmController.listAlerts);

router.post(
  '/codes/sync',
  requirePermissionOrRoles('ebm', 'update', ['admin']),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('full').optional().isBoolean(),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.syncCodes,
);

router.post(
  '/devices/initialize',
  requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager']),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('deviceSerialNo').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ max: 100 }),
  body('dvcSrlNo').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ max: 100 }),
  body('tin').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ max: 9 }),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.initializeDevice,
);

router.post(
  '/branches/register',
  requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager']),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  validateRequest,
  stripUnvalidatedBody,
  invalidateWarehouses,
  ebmController.registerBranch,
);

router.post(
  '/imports/sync',
  requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager']),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('full').optional().isBoolean(),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.syncImportedItems,
);

router.post(
  '/purchases/sync',
  requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager']),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('full').optional().isBoolean(),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.syncPurchases,
);

router.post(
  '/sales/sync',
  requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager']),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('full').optional().isBoolean(),
  body('prcOrdCd').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ max: 5 }),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.syncSalesSummaries,
);

router.post(
  '/items/sync',
  requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager']),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('full').optional().isBoolean(),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.syncRegisteredItems,
);

router.post(
  '/imports/:id/confirm',
  requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager']),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('warehouseId').notEmpty().withMessage('warehouseId is required').isMongoId(),
  body('productId').notEmpty().withMessage('productId is required').isMongoId(),
  body('supplierId').optional({ nullable: true, checkFalsy: true }).isMongoId(),
  body('unitCost').optional({ nullable: true }).isNumeric(),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.confirmImportedItem,
);

router.post(
  '/imports/:id/reject',
  requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager']),
  body('reason').notEmpty().withMessage('Rejection reason is required').isString().trim().isLength({ max: 500 }),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.rejectImportedItem,
);

router.post(
  '/imports/:id/retry-stock',
  requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager']),
  body('warehouseId').notEmpty().withMessage('warehouseId is required').isMongoId(),
  body('productId').notEmpty().withMessage('productId is required').isMongoId(),
  body('supplierId').optional({ nullable: true, checkFalsy: true }).isMongoId(),
  body('unitCost').optional({ nullable: true }).isNumeric(),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.retryImportedItemStock,
);
router.post(
  '/stock/reconcile',
  requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager']),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('lastReqDt').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 14, max: 14 }),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.reconcileStockMaster,
);

router.post(
  '/stock/reconcile/resubmit',
  requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager']),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('itemCd').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ max: 20 }),
  body('itemCode').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ max: 20 }),
  body('productId').optional({ nullable: true, checkFalsy: true }).isMongoId(),
  body('allDiscrepancies').optional().isBoolean(),
  body('lastReqDt').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 14, max: 14 }),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.resubmitStockMaster,
);

router.post(
  '/queue/bulk-retry',
  requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager']),
  body('ids').isArray({ min: 1 }).withMessage('ids must be a non-empty array'),
  body('ids.*').isMongoId(),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.bulkRetryQueueItems,
);

router.get(
  '/queue/:id',
  requirePermissionOrRoles('ebm', 'read', ['admin', 'stock_manager']),
  ebmController.getSubmissionQueueItem,
);

router.post(
  '/queue/:id/retry',
  requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager']),
  ebmController.retryQueueItem,
);

router.post(
  '/queue/:id/resolve',
  requirePermissionOrRoles('ebm', 'update', ['admin']),
  ebmController.markQueueItemResolved,
);

router.post(
  '/alerts/:id/acknowledge',
  requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager']),
  ebmController.acknowledgeAlert,
);

router.post(
  '/alerts/:id/reset',
  requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager']),
  ebmController.resetAlert,
);

module.exports = router;
