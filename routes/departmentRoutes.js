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
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const logAction = require('../middleware/logAction');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

// Reference data: read constantly by pickers, changed rarely.
const cacheRef = cacheMiddleware({ type: 'department', ttl: 600 });
const invalidateRef = cacheInvalidationMiddleware({ type: 'department', invalidateAll: true });

router.use(protect);

router.route('/')
  .get(requirePermissionOrRoles('departments', 'read', ['admin']), cacheRef, getDepartments)
  .post(requirePermissionOrRoles('departments', 'create', ['admin']), logAction('department'), invalidateRef, createDepartment);

router.route('/:id')
  .get(requirePermissionOrRoles('departments', 'read', ['admin']), cacheRef, getDepartment)
  .put(requirePermissionOrRoles('departments', 'update', ['admin']), logAction('department'), invalidateRef, updateDepartment)
  .delete(requirePermissionOrRoles('departments', 'delete', ['admin']), logAction('department'), invalidateRef, deleteDepartment);

router.put('/:id/assign-users', requirePermissionOrRoles('departments', 'update', ['admin']), logAction('department'), invalidateRef, assignUsers);
router.put('/:id/remove-user/:userId', requirePermissionOrRoles('departments', 'update', ['admin']), logAction('department'), invalidateRef, removeUser);

// Employee department routes
router.get('/:id/employees', requirePermissionOrRoles('departments', 'read', ['admin']), getDepartmentEmployees);
router.put('/:id/assign-employees', requirePermissionOrRoles('departments', 'update', ['admin']), logAction('department'), invalidateRef, assignEmployees);
router.put('/:id/remove-employee/:employeeId', requirePermissionOrRoles('departments', 'update', ['admin']), logAction('department'), invalidateRef, removeEmployee);

module.exports = router;
