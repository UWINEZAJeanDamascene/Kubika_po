const Employee = require('../models/Employee');
const Department = require('../models/Department');
const Timesheet = require('../models/Timesheet');

/**
 * Labor Allocation Service
 * Determines how much of an employee's gross salary is Direct Labor (5300)
 * vs Indirect Labor (5400) based on timesheet or employee defaults.
 */
class LaborAllocationService {

  /**
   * Allocate gross salary between direct and indirect labor for a single employee.
   *
   * @param {Object} employee - Employee document (or employee_id string)
   * @param {number} grossSalary - Total gross salary
   * @param {number} month - Payroll month (1-12)
   * @param {number} year - Payroll year
   * @param {string} companyId - Company ID for fetching related data
   * @returns {Object} { directAmount, indirectAmount, directPct, indirectPct, source, timesheetId, laborType }
   */
  static async allocateForEmployee(employee, grossSalary, month, year, companyId) {
    // Resolve employee document if only ID was passed
    let emp = employee;
    if (typeof employee === 'string' || employee instanceof require('mongoose').Types.ObjectId) {
      emp = await Employee.findById(employee).lean();
    }

    if (!emp) {
      return {
        directAmount: 0,
        indirectAmount: grossSalary,
        directPct: 0,
        indirectPct: 100,
        source: 'indirect_only',
        timesheetId: null,
        laborType: 'indirect',
        warning: 'Employee not found — 100% indirect fallback'
      };
    }

    const laborType = emp.laborType || 'indirect';

    // ── Step A: Try approved timesheet first ──────────────────────────────
    const timesheet = await Timesheet.findOne({
      company: companyId,
      employee: emp._id,
      periodMonth: month,
      periodYear: year,
      status: 'approved'
    }).lean();

    if (timesheet && timesheet.totalHours > 0) {
      const directPct = Math.min(100, Math.max(0, timesheet.directPercentage));
      const indirectPct = 100 - directPct;
      const result = this._applySplit(grossSalary, directPct, indirectPct);
      return {
        ...result,
        source: 'timesheet',
        timesheetId: timesheet._id,
        laborType,
        timesheetDirectHours: timesheet.directHours,
        timesheetTotalHours: timesheet.totalHours
      };
    }

    // ── Step B: Use employee defaults ───────────────────────────────────────
    if (laborType === 'direct') {
      return {
        directAmount: grossSalary,
        indirectAmount: 0,
        directPct: 100,
        indirectPct: 0,
        source: 'direct_only',
        timesheetId: null,
        laborType,
        warning: emp.laborType ? null : 'No laborType assigned — defaulted to 100% direct'
      };
    }

    if (laborType === 'indirect') {
      return {
        directAmount: 0,
        indirectAmount: grossSalary,
        directPct: 0,
        indirectPct: 100,
        source: 'indirect_only',
        timesheetId: null,
        laborType,
        warning: emp.laborType ? null : 'No laborType assigned — defaulted to 100% indirect'
      };
    }

    // Mixed: use defaultDirectPercentage or department default
    if (laborType === 'mixed') {
      let directPct = emp.defaultDirectPercentage;

      if (directPct == null && emp.departmentRef) {
        const dept = await Department.findById(emp.departmentRef).lean();
        if (dept && dept.defaultLaborAccount === '5300') {
          directPct = 100;
        } else if (dept && dept.defaultLaborAccount === '5400') {
          directPct = 0;
        }
      }

      // Default to 50/50 if still not set
      if (directPct == null) {
        directPct = 50;
      }

      directPct = Math.min(100, Math.max(0, directPct));
      const indirectPct = 100 - directPct;
      const result = this._applySplit(grossSalary, directPct, indirectPct);
      return {
        ...result,
        source: 'employee_default',
        timesheetId: null,
        laborType
      };
    }

    // Fallback: 100% indirect
    return {
      directAmount: 0,
      indirectAmount: grossSalary,
      directPct: 0,
      indirectPct: 100,
      source: 'indirect_only',
      timesheetId: null,
      laborType: 'indirect',
      warning: 'Unknown laborType — 100% indirect fallback'
    };
  }

  /**
   * Validate that all active direct/mixed employees have a Labor Type assigned.
   * Called before payroll run creation.
   *
   * @param {string} companyId
   * @param {Array} employeeIds - Array of employee ObjectIds in this payroll run
   * @returns {Object} { valid: boolean, errors: Array<string> }
   */
  static async validateLaborTypes(companyId, employeeIds) {
    const employees = await Employee.find({
      _id: { $in: employeeIds }
    }).lean();

    const errors = [];

    for (const emp of employees) {
      const isDirectOrMixed = ['direct', 'mixed'].includes(emp.laborType);
      if (!emp.laborType && emp.status === 'active') {
        errors.push(`${emp.firstName} ${emp.lastName} (${emp.employeeId}): No Labor Type assigned`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Flag employees whose timesheet direct % differs from default by >30 points.
   *
   * @param {string} companyId
   * @param {Array} employeeIds
   * @param {number} month
   * @param {number} year
   * @returns {Array<Object>} flagged employees with details
   */
  static async flagTimesheetVariance(companyId, employeeIds, month, year) {
    const employees = await Employee.find({
      _id: { $in: employeeIds },
      laborType: 'mixed'
    }).lean();

    const flagged = [];

    for (const emp of employees) {
      if (!emp.defaultDirectPercentage) continue;

      const timesheet = await Timesheet.findOne({
        company: companyId,
        employee: emp._id,
        periodMonth: month,
        periodYear: year,
        status: 'approved'
      }).lean();

      if (timesheet && timesheet.totalHours > 0) {
        const diff = Math.abs(timesheet.directPercentage - emp.defaultDirectPercentage);
        if (diff > 30) {
          flagged.push({
            employeeId: emp.employeeId,
            name: `${emp.firstName} ${emp.lastName}`,
            defaultPct: emp.defaultDirectPercentage,
            timesheetPct: timesheet.directPercentage,
            difference: diff
          });
        }
      }
    }

    return flagged;
  }

  /**
   * Apply split with rounding resolution. Ensures direct + indirect = gross.
   *
   * @param {number} grossSalary
   * @param {number} directPct
   * @param {number} indirectPct
   * @returns {Object} { directAmount, indirectAmount, directPct, indirectPct }
   */
  static _applySplit(grossSalary, directPct, indirectPct) {
    const rounded = (n) => Math.round(n * 100) / 100;

    let directAmount = rounded(grossSalary * (directPct / 100));
    let indirectAmount = rounded(grossSalary * (indirectPct / 100));

    // Resolve rounding gap
    const total = rounded(directAmount + indirectAmount);
    const gap = rounded(grossSalary - total);

    if (gap !== 0) {
      // Assign gap to the larger portion
      if (directAmount >= indirectAmount) {
        directAmount = rounded(directAmount + gap);
      } else {
        indirectAmount = rounded(indirectAmount + gap);
      }
    }

    return {
      directAmount,
      indirectAmount,
      directPct,
      indirectPct
    };
  }
}

module.exports = LaborAllocationService;
