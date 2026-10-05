/**
 * Payroll — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const { dbClient } = require('../lib/prisma');
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

// Use the stored payroll period as the source of truth. Some older payroll
// rows have valid period JSON but a missing or stale pay_period_start date.
// Payroll-run eligibility and the period picker must still find those rows.
Payroll.findFinalisedUnassignedForPeriod = async function(companyId, month, year) {
  const normalizedMonth = Number(month);
  const normalizedYear = Number(year);
  const rows = await dbClient().payroll.findMany({
    where: {
      companyId: String(companyId),
      recordStatus: 'finalised',
      payrollRunId: null,
      AND: [
        { period: { path: ['month'], equals: normalizedMonth } },
        { period: { path: ['year'], equals: normalizedYear } },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(payrollToApi);
};

Payroll.calculatePayroll = function(salary, options = {}) {
  const periodDate = options.periodDate || new Date();
  return calculateRwandaPayroll({
    salary,
    additionalIncome: options.additionalIncome || {},
    deductions: options.deductions || {},
    employee: options.employee || {},
    periodDate,
    proration: options.proration || null,
  });
};

Payroll.fromEmployeeMaster = function(emp, effectiveSalary, period, approvedInput = null) {
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
    ...(approvedInput?.additionalIncome || {}),
  };

  const periodDate = new Date(Date.UTC(period.year, period.month, 0, 12));
  const proration = approvedInput ? {
    scheduledDays: Number(approvedInput.scheduledDays),
    workedDays: Number(approvedInput.workedDays),
    paidLeaveDays: Number(approvedInput.paidLeaveDays),
    unpaidLeaveDays: Number(approvedInput.unpaidLeaveDays),
    status: approvedInput.status,
    approvedById: approvedInput.approvedById,
    approvedAt: approvedInput.approvedAt,
    inputId: approvedInput.id,
  } : null;
  const calculated = Payroll.calculatePayroll(salary, {
    employee: emp,
    periodDate,
    proration,
    additionalIncome: approvedInput?.additionalIncome || {},
    deductions: approvedInput?.deductions || {},
  });

  return {
    employee: employeeSnapshot,
    salary: { ...salary, ...calculated.earnings, taxableBase: calculated.taxableBase, grossRemuneration: calculated.grossRemuneration, ruleVersion: calculated.ruleVersion, ruleEffectiveDate: calculated.ruleEffectiveDate, rates: calculated.rates, proration: calculated.proration, originalEarnings: calculated.originalEarnings },
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
