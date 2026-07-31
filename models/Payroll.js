/**
 * Payroll — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const { prisma } = require('../lib/prisma');
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

Payroll.calculatePayroll = function(salary) {
  const basicSalary = salary.basicSalary || 0;
  const transportAllowance = salary.transportAllowance || 0;
  const housingAllowance = salary.housingAllowance || 0;
  const otherAllowances = salary.otherAllowances || 0;
  const grossSalary = basicSalary + transportAllowance + housingAllowance + otherAllowances;

  const payeBrackets = [
    { max: 60000, rate: 0 },
    { max: 100000, rate: 0.1 },
    { max: 200000, rate: 0.2 },
    { max: Infinity, rate: 0.3 },
  ];

  let paye = 0;
  let remaining = grossSalary;
  let prevMax = 0;
  for (const bracket of payeBrackets) {
    const taxableInBracket = Math.min(remaining, bracket.max - prevMax);
    if (taxableInBracket <= 0) break;
    paye += taxableInBracket * bracket.rate;
    remaining -= taxableInBracket;
    prevMax = bracket.max;
  }

  const rssbEmployeePension = grossSalary * 0.06;
  const rssbEmployeeMaternity = grossSalary * 0.005;
  const totalDeductions = paye + rssbEmployeePension + rssbEmployeeMaternity;

  const rssbEmployerPension = grossSalary * 0.06;
  const rssbEmployerMaternity = grossSalary * 0.005;
  const occupationalHazardRate = salary.occupationalHazardRate || 2;
  const occupationalHazard = grossSalary * (occupationalHazardRate / 100);

  const netPay = grossSalary - totalDeductions;

  return {
    grossSalary,
    deductions: {
      paye: Math.round(paye * 100) / 100,
      rssbEmployeePension: Math.round(rssbEmployeePension * 100) / 100,
      rssbEmployeeMaternity: Math.round(rssbEmployeeMaternity * 100) / 100,
      totalDeductions: Math.round(totalDeductions * 100) / 100,
    },
    netPay: Math.round(netPay * 100) / 100,
    contributions: {
      rssbEmployerPension: Math.round(rssbEmployerPension * 100) / 100,
      rssbEmployerMaternity: Math.round(rssbEmployerMaternity * 100) / 100,
      occupationalHazard: Math.round(occupationalHazard * 100) / 100,
    },
  };
};

Payroll.fromEmployeeMaster = function(emp, effectiveSalary, period) {
  const employeeSnapshot = {
    employeeId: emp.employeeId,
    firstName: emp.firstName,
    lastName: emp.lastName,
    email: emp.email,
    department: emp.department,
    position: emp.position,
    laborType: emp.laborType,
    isActive: emp.status === 'active',
  };

  const salary = {
    basicSalary: effectiveSalary.basicSalary || 0,
    transportAllowance: effectiveSalary.transportAllowance || 0,
    housingAllowance: effectiveSalary.housingAllowance || 0,
    otherAllowances: effectiveSalary.otherAllowances || 0,
    occupationalHazardRate: effectiveSalary.occupationalHazardRate || 2,
  };

  const calculated = Payroll.calculatePayroll(salary);

  return {
    employee: employeeSnapshot,
    salary,
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
