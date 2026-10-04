const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requirePosPermissions } = require('../middleware/posAuthorization');
const { openTill, closeTill, getActiveTill, getTillShifts } = require('../controllers/tillController');
const { createApproval, listApprovals } = require('../controllers/posManagerApprovalController');

router.use(protect);

const canOperateTill = requirePosPermissions({ resource: 'sales_invoices', action: 'create' });
const canReadTill = requirePosPermissions({ resource: 'sales_invoices', action: 'read' });
const canReviewTill = requirePosPermissions({ resource: 'sales_invoices', action: 'approve' });

router.post('/open', canOperateTill, openTill);
router.post('/close', canOperateTill, closeTill);
router.get('/active', canReadTill, getActiveTill);
router.get('/shifts', canReviewTill, getTillShifts);
router.post('/manager-approvals', canOperateTill, createApproval);
router.get('/manager-approvals/history', canReviewTill, listApprovals);

module.exports = router;
