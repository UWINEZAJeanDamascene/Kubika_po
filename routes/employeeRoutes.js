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
const { requirePayrollPermission } = require('../middleware/payrollPermission');

// Keep legacy Admin/Manager/HR access while allowing tenant-defined payroll
// roles to use Employee Master according to their payroll permissions.
function payrollOrLegacy(action, legacyRoles = []) {
  const checkPayrollPermission = requirePayrollPermission(action);
  return (req, res, next) => {
    const assignedRoleNames = [
      req.user?.role,
      ...(Array.isArray(req.user?.roles)
        ? req.user.roles.map((role) => typeof role === 'string' ? role : role?.name)
        : []),
    ].filter(Boolean);
    if (assignedRoleNames.some((name) => legacyRoles.includes(name))) return next();
    return checkPayrollPermission(req, res, next);
  };
}

router.use(protect);

router.route('/')
  .get(payrollOrLegacy('read', ['admin', 'manager', 'hr']), getEmployees)
  .post(payrollOrLegacy('create', ['admin', 'manager', 'hr']), createEmployee);

router.route('/next-id')
  .get(payrollOrLegacy('create', ['admin', 'manager', 'hr']), getNextEmployeeId);

router.route('/:id')
  .get(payrollOrLegacy('read', ['admin', 'manager', 'hr']), getEmployeeById)
  .put(payrollOrLegacy('update', ['admin', 'manager', 'hr']), updateEmployee)
  .delete(payrollOrLegacy('delete', ['admin', 'manager']), deleteEmployee);

router.route('/:id/salary')
  .put(payrollOrLegacy('update', ['admin', 'manager', 'hr']), changeSalary);

router.route('/:id/salary-history')
  .get(payrollOrLegacy('read', ['admin', 'manager', 'hr']), getSalaryHistory);

router.route('/:id/terminate')
  .put(payrollOrLegacy('update', ['admin', 'manager', 'hr']), terminateEmployee);

module.exports = router;
