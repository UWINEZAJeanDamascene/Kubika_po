const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const timesheetController = require('../controllers/timesheetController');

router.post('/', protect, timesheetController.createTimesheet);
router.get('/', protect, timesheetController.getTimesheets);
router.get('/:id/audit', protect, timesheetController.getTimesheetAllocationAuditHistory);
router.get('/:id', protect, timesheetController.getTimesheetById);
router.put('/:id/correct-allocation', protect, requirePermissionOrRoles('timesheets', 'correct', ['admin', 'accountant', 'finance', 'finance_manager', 'project_controller']), timesheetController.correctTimesheetAllocation);
router.put('/:id', protect, timesheetController.updateTimesheet);
router.put('/:id/submit', protect, timesheetController.submitTimesheet);
router.put('/:id/approve', protect, timesheetController.approveTimesheet);
router.put('/:id/reject', protect, timesheetController.rejectTimesheet);
router.delete('/:id', protect, timesheetController.deleteTimesheet);

module.exports = router;
