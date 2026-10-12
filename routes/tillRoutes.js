const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const { openTill, closeTill, managerCloseTill, getActiveTill, getTillShifts } = require('../controllers/tillController');
const posCheckoutSupportController = require('../controllers/posCheckoutSupportController');
const { getTillZReport } = require('../controllers/tillZReportController');
const { createApproval, listApprovals } = require('../controllers/posManagerApprovalController');
const posRegisterController = require('../controllers/posRegisterController');

router.use(protect);

const canOperateTill = requirePermissionOrRoles('tills', 'open', ['admin', 'manager', 'sales']);
const canCloseTill = requirePermissionOrRoles('tills', 'close', ['admin', 'manager', 'sales']);
const canReadTill = requirePermissionOrRoles('tills', 'read', ['admin', 'accountant', 'manager', 'sales', 'viewer']);
const canRequestApproval = requirePermissionOrRoles('tills', 'create', ['admin', 'manager', 'sales']);
const canManageRegisters = requirePermissionOrRoles('tills', 'create', ['admin', 'manager']);

router.get('/registers/device/:deviceId', canReadTill, posRegisterController.getDeviceRegister);
router.post('/registers/claim', canOperateTill, posRegisterController.claimRegister);
router.get('/registers', canManageRegisters, posRegisterController.listRegisters);
router.post('/registers', canManageRegisters, posRegisterController.createRegister);
router.post('/registers/:registerId/claim-code', canManageRegisters, posRegisterController.issueClaimCode);
router.post('/registers/:registerId/deactivate', canManageRegisters, posRegisterController.deactivateRegister);

router.post('/open', canOperateTill, openTill);
router.post('/close', canCloseTill, closeTill);
router.post('/manager-close', canCloseTill, managerCloseTill);
router.get('/active', canReadTill, getActiveTill);
router.get('/shifts', canReadTill, getTillShifts);
router.get('/shifts/:tillSessionId/z-report', canReadTill, getTillZReport);
router.get('/checkout-requests/:requestKey', canReadTill, posCheckoutSupportController.getCheckoutRequest);
router.post('/checkout-requests/:requestKey/recover', canCloseTill, posCheckoutSupportController.recoverCheckoutRequest);
router.post('/manager-approvals', canRequestApproval, createApproval);
router.get('/manager-approvals/history', canReadTill, listApprovals);

module.exports = router;
