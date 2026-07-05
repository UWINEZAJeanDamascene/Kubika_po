const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const ebmController = require('../controllers/ebmController');
const { protect, authorize } = require('../middleware/auth');
const { attachCompanyId } = require('../middleware/companyContext');
const validateRequest = require('../middleware/validateRequest');
const stripUnvalidatedBody = require('../middleware/stripUnvalidatedBody');

router.use(protect);
router.use(attachCompanyId);

router.get('/devices', ebmController.getDeviceStatus);
router.get('/codes/status', ebmController.getCodeSyncStatus);
router.get('/codes', ebmController.getCodes);
router.get('/codes/item-classes', ebmController.getItemClasses);
router.get('/codes/tins', ebmController.searchTINs);
router.post(
  '/customers/verify-tin',
  authorize('admin', 'stock_manager', 'sales'),
  body('tin').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 9, max: 9 }),
  body('custmTin').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 9, max: 9 }),
  body('custTin').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 9, max: 9 }),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.verifyCustomerTin,
);
router.get('/notices', ebmController.getNotices);
router.get('/imports', ebmController.listImportedItems);
router.get('/purchases/unmatched', ebmController.listUnmatchedPurchases);
router.get('/queue', authorize('admin', 'stock_manager'), ebmController.listSubmissionQueue);
router.get('/alerts', authorize('admin', 'stock_manager'), ebmController.listAlerts);

router.post(
  '/codes/sync',
  authorize('admin'),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('full').optional().isBoolean(),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.syncCodes,
);

router.post(
  '/devices/initialize',
  authorize('admin', 'stock_manager'),
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
  authorize('admin', 'stock_manager'),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.registerBranch,
);

router.post(
  '/imports/sync',
  authorize('admin', 'stock_manager'),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('full').optional().isBoolean(),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.syncImportedItems,
);

router.post(
  '/purchases/sync',
  authorize('admin', 'stock_manager'),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('full').optional().isBoolean(),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.syncPurchases,
);

router.post(
  '/imports/:id/confirm',
  authorize('admin', 'stock_manager'),
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
  authorize('admin', 'stock_manager'),
  body('reason').notEmpty().withMessage('Rejection reason is required').isString().trim().isLength({ max: 500 }),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.rejectImportedItem,
);

router.post(
  '/imports/:id/retry-stock',
  authorize('admin', 'stock_manager'),
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
  authorize('admin', 'stock_manager'),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('lastReqDt').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 14, max: 14 }),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.reconcileStockMaster,
);

router.post(
  '/stock/reconcile/resubmit',
  authorize('admin', 'stock_manager'),
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
  authorize('admin', 'stock_manager'),
  body('ids').isArray({ min: 1 }).withMessage('ids must be a non-empty array'),
  body('ids.*').isMongoId(),
  validateRequest,
  stripUnvalidatedBody,
  ebmController.bulkRetryQueueItems,
);

router.get(
  '/queue/:id',
  authorize('admin', 'stock_manager'),
  ebmController.getSubmissionQueueItem,
);

router.post(
  '/queue/:id/retry',
  authorize('admin', 'stock_manager'),
  ebmController.retryQueueItem,
);

router.post(
  '/queue/:id/resolve',
  authorize('admin'),
  ebmController.markQueueItemResolved,
);

router.post(
  '/alerts/:id/acknowledge',
  authorize('admin', 'stock_manager'),
  ebmController.acknowledgeAlert,
);

router.post(
  '/alerts/:id/reset',
  authorize('admin', 'stock_manager'),
  ebmController.resetAlert,
);

module.exports = router;

