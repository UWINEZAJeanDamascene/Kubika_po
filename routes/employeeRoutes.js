const express = require('express');
const router = express.Router();
const {
  getEmployees,
  getNextEmployeeId,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  changeSalary,
  getSalaryHistory,
  terminateEmployee,
  deleteEmployee,
} = require('../controllers/employeeController');
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const { requireCompensationAccess, requireCompensationWriteForSalaryPayload } = require('../middleware/compensationAccess');

router.use(protect);

router.route('/')
  .get(requirePermissionOrRoles('employees', 'read', ['admin', 'manager']), getEmployees)
  .post(
    requirePermissionOrRoles('employees', 'create', ['admin', 'manager']),
    requireCompensationWriteForSalaryPayload,
    createEmployee,
  );

router.route('/next-id')
  .get(requirePermissionOrRoles('employees', 'create', ['admin', 'manager']), getNextEmployeeId);

router.route('/:id')
  .get(requirePermissionOrRoles('employees', 'read', ['admin', 'manager']), getEmployeeById)
  .put(requirePermissionOrRoles('employees', 'update', ['admin', 'manager']), updateEmployee)
  .delete(requirePermissionOrRoles('employees', 'delete', ['admin', 'manager']), deleteEmployee);

router.route('/:id/salary')
  .put(requireCompensationAccess('write_compensation'), changeSalary);

router.route('/:id/salary-history')
  .get(
    requireCompensationAccess('read_compensation'),
    getSalaryHistory,
  );

router.route('/:id/terminate')
  .put(requirePermissionOrRoles('employees', 'update', ['admin', 'manager']), terminateEmployee);

module.exports = router;
