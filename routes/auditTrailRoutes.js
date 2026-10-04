const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const { getAuditTrail, getAuditStats, getAuditDetail } = require('../controllers/auditTrailController');

router.use(protect);
router.get('/', requirePermissionOrRoles('audit_trail', 'read', ['admin']), getAuditTrail);
router.get('/stats', requirePermissionOrRoles('audit_trail', 'read', ['admin']), getAuditStats);
router.get('/:id', requirePermissionOrRoles('audit_trail', 'read', ['admin']), getAuditDetail);

module.exports = router;
