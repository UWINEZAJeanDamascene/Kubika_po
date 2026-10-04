const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const { openTill, closeTill, getActiveTill, getTillShifts } = require('../controllers/tillController');
const { createApproval, listApprovals } = require('../controllers/posManagerApprovalController');

router.use(protect);

const canOperateTill = requirePermissionOrRoles('tills', 'open', ['admin', 'manager', 'sales']);
const canCloseTill = requirePermissionOrRoles('tills', 'close', ['admin', 'manager', 'sales']);
const canReadTill = requirePermissionOrRoles('tills', 'read', ['admin', 'accountant', 'manager', 'sales', 'viewer']);
const canRequestApproval = requirePermissionOrRoles('tills', 'create', ['admin', 'manager', 'sales']);

router.post('/open', canOperateTill, openTill);
router.post('/close', canCloseTill, closeTill);
router.get('/active', canReadTill, getActiveTill);
router.get('/shifts', canReadTill, getTillShifts);
router.post('/manager-approvals', canRequestApproval, createApproval);
router.get('/manager-approvals/history', canReadTill, listApprovals);

module.exports = router;
