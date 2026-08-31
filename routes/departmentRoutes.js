const express = require('express');
const router = express.Router();
const {
  getDepartments,
  getDepartment,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  assignUsers,
  removeUser,
  getDepartmentEmployees,
  assignEmployees,
  removeEmployee
} = require('../controllers/departmentController');
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

// Reference data: read constantly by pickers, changed rarely.
const cacheRef = cacheMiddleware({ type: 'department', ttl: 600 });
const invalidateRef = cacheInvalidationMiddleware({ type: 'department', invalidateAll: true });

router.use(protect);

router.route('/')
  .get(cacheRef, getDepartments)
  .post(authorize('admin'), logAction('department'), invalidateRef, createDepartment);

router.route('/:id')
  .get(cacheRef, getDepartment)
  .put(authorize('admin'), logAction('department'), invalidateRef, updateDepartment)
  .delete(authorize('admin'), logAction('department'), invalidateRef, deleteDepartment);

router.put('/:id/assign-users', authorize('admin'), logAction('department'), invalidateRef, assignUsers);
router.put('/:id/remove-user/:userId', authorize('admin'), logAction('department'), invalidateRef, removeUser);

// Employee department routes
router.get('/:id/employees', protect, getDepartmentEmployees);
router.put('/:id/assign-employees', authorize('admin'), logAction('department'), invalidateRef, assignEmployees);
router.put('/:id/remove-employee/:employeeId', authorize('admin'), logAction('department'), invalidateRef, removeEmployee);

module.exports = router;
