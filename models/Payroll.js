/**
 * Payroll — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const { prisma } = require('../lib/prisma');
const { calculateRwandaPayroll } = require('../services/rwandaPayrollRules');
const {
  payrollToApi,
  payrollTranslateCreate,
  payrollTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  employee_id: { target: 'employeeRefId', isId: true },
  payroll_run_id: { target: 'payrollRunId', isId: true },
  record_status: { target: 'recordStatus' },
  pay_period_start: { target: 'payPeriodStart' },
  pay_period_end: { target: 'payPeriodEnd' },
};

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const Payroll = buildTenantModel({
  name: 'Payroll',
  collection: 'payrolls',
  delegateName: 'payroll',
  fieldMap: FIELD_MAP,
  toApi: payrollToApi,
  translateCreate: payrollTranslateCreate,
  translateUpdate: payrollTranslateUpdate,
  mutable: true,
});

Payroll.getMonthName = function(month) {
  return MONTH_NAMES[month] || '';
};

Payroll.calculatePayroll = function(salary, options = {}) {
  const periodDate = options.periodDate || new Date();
  return calculateRwandaPayroll({
    salary,
    additionalIncome: options.additionalIncome || {},
    deductions: options.deductions || {},
    employee: options.employee || {},
    periodDate,
  });
};

Payroll.fromEmployeeMaster = function(emp, effectiveSalary, period) {
  const employeeSnapshot = {
    employeeId: emp.employeeId,
    firstName: emp.firstName,
    lastName: emp.lastName,
    email: emp.email,
    employmentType: emp.employmentType,
    department: emp.department,
    position: emp.position,
    laborType: emp.laborType,
    isPrimaryEmployer: emp.isPrimaryEmployer !== false,
    isActive: emp.status === 'active',
  };

  const salary = {
    basicSalary: effectiveSalary.basicSalary || 0,
    transportAllowance: effectiveSalary.transportAllowance || 0,
    housingAllowance: effectiveSalary.housingAllowance || 0,
    otherAllowances: effectiveSalary.otherAllowances || 0,
    occupationalHazardRate: effectiveSalary.occupationalHazardRate || 2,
  };

  const periodDate = new Date(Date.UTC(period.year, period.month, 0, 12));
  const calculated = Payroll.calculatePayroll(salary, { employee: emp, periodDate });

  return {
    employee: employeeSnapshot,
    salary: { ...salary, taxableBase: calculated.taxableBase, grossRemuneration: calculated.grossRemuneration, ruleVersion: calculated.ruleVersion, ruleEffectiveDate: calculated.ruleEffectiveDate, rates: calculated.rates },
    employee_id: emp._id || emp.employeeId,
    deductions: calculated.deductions,
    netPay: calculated.netPay,
    contributions: calculated.contributions,
    period: {
      month: period.month,
      year: period.year,
      monthName: Payroll.getMonthName(period.month),
    },
  };
};

module.exports = Payroll;
