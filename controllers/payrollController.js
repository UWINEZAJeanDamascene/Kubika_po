const Payroll = require("../models/Payroll");
const Employee = require("../models/Employee");
const SalaryHistory = require("../models/SalaryHistory");
const User = require("../models/User");
const JournalService = require("../services/journalService");
const TaxAutomationService = require("../services/taxAutomationService");
const LaborAllocationService = require('../services/laborAllocationService');
const { parsePagination, paginationMeta } = require("../utils/pagination");
const JournalEntry = require("../models/JournalEntry");
const { runInPrismaTransaction } = require("../services/transactionService");
const { dbClient } = require("../lib/prisma");
const { generateObjectId } = require("../utils/objectId");
const { PAYROLL_ACCOUNTS, assertJournalBalanced } = require("../constants/payrollAccounts");
const { PermissionService, resolveUserRoles } = require("../middleware/authorize");
const { recordPayrollAudit, payrollSnapshot } = require("../services/payrollAuditService");

function sameActor(left, right) {
  const id = (value) => value && typeof value === "object" ? String(value._id || value.id || "") : String(value || "");
  return Boolean(id(left) && id(left) === id(right));
}

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

function maskPersonalIdentifier(value) {
  const normalized = String(value || "").replace(/\s+/g, "");
  return normalized.length < 5 ? null : `${"•".repeat(Math.max(4, normalized.length - 4))}${normalized.slice(-4)}`;
}

async function findSelfServiceEmployee(companyId, email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!companyId || !normalizedEmail) return null;
  const matches = await dbClient().employee.findMany({
    where: { companyId: String(companyId), email: { equals: normalizedEmail, mode: "insensitive" } },
    take: 2,
  });
  if (matches.length > 1) {
    const error = new Error("This login email is linked to multiple employee profiles. Ask payroll administration to resolve the duplicate.");
    error.statusCode = 409;
    error.code = "PAYROLL_EMPLOYEE_LINK_AMBIGUOUS";
    throw error;
  }
  return matches[0] || null;
}

function payrollPeriodConflict(error) {
  if (["P2002", "23505", 11000].includes(error?.code)) {
    const conflict = new Error("A payroll record already exists for this employee and period.");
    conflict.code = "PAYROLL_PERIOD_EXISTS";
    conflict.statusCode = 409;
    return conflict;
  }
  return error;
}

async function buildPayrollAccrualLines(companyId, payroll, suffix = "") {
  const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");

  const grossSalary = round2(payroll.salary?.grossSalary);
  const paye = round2(payroll.deductions?.paye);
  const rssbEmployee = round2(
    (payroll.deductions?.rssbEmployeePension || 0) +
      (payroll.deductions?.rssbEmployeeMaternity || 0),
  );
  const netPay = round2(payroll.netPay);
  const occupationalHazard = round2(payroll.contributions?.occupationalHazard);
  const healthInsurance = round2(payroll.deductions?.healthInsurance);
  const loanDeductions = round2(payroll.deductions?.loanDeductions);
  const otherDeductions = round2(payroll.deductions?.otherDeductions);

  const employeeName =
    `${payroll.employee?.firstName || ""} ${payroll.employee?.lastName || ""}`.trim() ||
    "Unknown Employee";
  const periodLabel =
    `${payroll.period?.monthName || ""} ${payroll.period?.year || ""}`.trim();

  const allocation = await LaborAllocationService.allocateForEmployee(
    payroll.employee_id,
    grossSalary,
    payroll.period?.month,
    payroll.period?.year,
    companyId,
  );

  const lines = [];

  if (allocation.directAmount > 0) {
    lines.push(
      JournalService.createDebitLine(
        DEFAULT_ACCOUNTS.directLabor || "5300",
        allocation.directAmount,
        `Direct labor accrual - ${employeeName} - ${periodLabel}${suffix}`,
      ),
    );
  }

  if (allocation.indirectAmount > 0) {
    lines.push(
      JournalService.createDebitLine(
        DEFAULT_ACCOUNTS.salariesWages || "5400",
        allocation.indirectAmount,
        `Salary accrual - ${employeeName} - ${periodLabel}${suffix}`,
      ),
    );
  }

  if (paye > 0) {
    lines.push(
      JournalService.createCreditLine(
        PAYROLL_ACCOUNTS.payePayable,
        paye,
        `PAYE withheld - ${employeeName}${suffix}`,
      ),
    );
  }

  const rssbEmployeePension = round2(payroll.deductions?.rssbEmployeePension);
  const rssbEmployeeMaternity = round2(payroll.deductions?.rssbEmployeeMaternity);
  if (rssbEmployeePension > 0) {
    lines.push(
      JournalService.createCreditLine(
        PAYROLL_ACCOUNTS.employeePensionPayable,
        rssbEmployeePension,
        `RSSB employee pension deduction - ${employeeName}${suffix}`,
      ),
    );
  }
  if (rssbEmployeeMaternity > 0) {
    lines.push(JournalService.createCreditLine(
      PAYROLL_ACCOUNTS.employeeMaternityPayable,
      rssbEmployeeMaternity,
      `RSSB employee maternity deduction - ${employeeName}${suffix}`,
    ));
  }

  if (occupationalHazard > 0) {
    lines.push(
      JournalService.createDebitLine(
        DEFAULT_ACCOUNTS.rssbEmployerCost || "6150",
        occupationalHazard,
        `Occupational hazard - ${employeeName}${suffix}`,
      ),
    );
    lines.push(
      JournalService.createCreditLine(
        PAYROLL_ACCOUNTS.occupationalHazardPayable,
        occupationalHazard,
        `Occupational hazard payable - ${employeeName}${suffix}`,
      ),
    );
  }

  if (healthInsurance > 0) {
    lines.push(
      JournalService.createCreditLine(
        PAYROLL_ACCOUNTS.otherDeductionsPayable,
        healthInsurance,
        `Health Insurance Payable - ${employeeName}${suffix}`,
      ),
    );
  }

  if (loanDeductions > 0) {
    lines.push(
      JournalService.createCreditLine(
        PAYROLL_ACCOUNTS.otherDeductionsPayable,
        loanDeductions,
        `Loan Deductions Payable - ${employeeName}${suffix}`,
      ),
    );
  }

  if (otherDeductions > 0) {
    lines.push(
      JournalService.createCreditLine(
        PAYROLL_ACCOUNTS.otherDeductionsPayable,
        otherDeductions,
        `Other Deductions Payable - ${employeeName}${suffix}`,
      ),
    );
  }

  if (netPay > 0) {
    lines.push(
      JournalService.createCreditLine(
        PAYROLL_ACCOUNTS.salaryPayable,
        netPay,
        `Net salary payable - ${employeeName}${suffix}`,
      ),
    );
  }

  assertJournalBalanced(lines, `Payroll accrual for ${employeeName}`);
  return { lines, allocation, employeeName, periodLabel };
}

async function postPayrollAccrualJournals(companyId, userId, payroll, options = {}) {
  const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");
  const suffix = options.suffix || "";
  const entryDate =
    options.entryDate ||
    (payroll.pay_period_end ? new Date(payroll.pay_period_end) : new Date());
  const grossSalary = round2(payroll.salary?.grossSalary);
  const rssbEmployerPensionMaternity = round2(
    (payroll.contributions?.rssbEmployerPension || 0) +
      (payroll.contributions?.rssbEmployerMaternity || 0),
  );

  if (grossSalary <= 0) {
    return { skippedZero: true };
  }

  const { lines, allocation, employeeName, periodLabel } =
    await buildPayrollAccrualLines(companyId, payroll, suffix);

  if (lines.length >= 2) {
    await JournalService.createEntry(companyId, userId, {
      date: entryDate,
      description: `Payroll Accrual - ${employeeName} - ${periodLabel}${suffix}`,
      sourceType: "payroll_salary",
      sourceId: payroll._id,
      sourceReference: periodLabel,
      lines,
      isAutoGenerated: true,
    });
  }

  if (rssbEmployerPensionMaternity > 0) {
    const pension = round2(payroll.contributions?.rssbEmployerPension);
    const maternity = round2(payroll.contributions?.rssbEmployerMaternity);
    const employerLines = [
      JournalService.createDebitLine(
        PAYROLL_ACCOUNTS.employerContributionExpense,
        rssbEmployerPensionMaternity,
        `Employer RSSB cost - ${employeeName}${suffix}`,
      ),
    ];
    if (pension > 0) employerLines.push(JournalService.createCreditLine(PAYROLL_ACCOUNTS.employerPensionPayable, pension, `Employer RSSB pension - ${employeeName}${suffix}`));
    if (maternity > 0) employerLines.push(JournalService.createCreditLine(PAYROLL_ACCOUNTS.employerMaternityPayable, maternity, `Employer RSSB maternity - ${employeeName}${suffix}`));
    assertJournalBalanced(employerLines, `Employer RSSB accrual for ${employeeName}`);
    await JournalService.createEntry(companyId, userId, {
      date: entryDate,
      description: `Employer RSSB Contribution - ${employeeName} - ${periodLabel}${suffix}`,
      sourceType: "payroll_employer",
      sourceId: payroll._id,
      sourceReference: periodLabel,
      lines: employerLines,
      isAutoGenerated: true,
    });
  }

  return { allocation, skippedZero: false };
}

// @desc    Get all payroll records for a company
// @route   GET /api/payroll
// @access  Private
exports.getPayrollRecords = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { month, year, status, search } = req.query;

    const mongoQuery = { company: companyId };

    if (month && year) {
      const payPeriodStart = new Date(parseInt(year), parseInt(month) - 1, 1);
      const payPeriodEnd = new Date(parseInt(year), parseInt(month), 0);
      mongoQuery.pay_period_start = { gte: payPeriodStart, lte: payPeriodEnd };
    } else if (year) {
      const payPeriodStart = new Date(parseInt(year), 0, 1);
      const payPeriodEnd = new Date(parseInt(year), 11, 31);
      mongoQuery.pay_period_start = { gte: payPeriodStart, lte: payPeriodEnd };
    }

    if (status) mongoQuery.record_status = status;

    const { page, limit, skip } = parsePagination(req.query);

    const [total, payrollRecords] = await Promise.all([
      Payroll.countDocuments(mongoQuery),
      Payroll.find(mongoQuery)
        .populate("createdBy", "name email")
        .populate("approvedBy", "name email")
        .sort({ payPeriodStart: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit),
    ]);

    let totalGrossSalary = 0;
    let totalNetPay = 0;
    let totalPAYE = 0;
    let totalRSSB = 0;

    for (const p of payrollRecords) {
      totalGrossSalary += p.salary?.grossSalary || 0;
      totalNetPay += p.netPay || 0;
      totalPAYE += p.deductions?.paye || 0;
      totalRSSB += (p.deductions?.rssbEmployeePension || 0) + (p.deductions?.rssbEmployeeMaternity || 0);
    }

    res.json({
      success: true,
      count: payrollRecords.length,
      data: payrollRecords,
      pagination: paginationMeta(page, limit, total),
      summary: {
        totalGrossSalary: Math.round(totalGrossSalary * 100) / 100,
        totalNetPay: Math.round(totalNetPay * 100) / 100,
        totalPAYE: Math.round(totalPAYE * 100) / 100,
        totalRSSB: Math.round(totalRSSB * 100) / 100,
        employeeCount: payrollRecords.length,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single payroll record
// @route   GET /api/payroll/:id
// @access  Private
exports.getPayrollById = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const payroll = await Payroll.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate("createdBy", "name email")
      .populate("approvedBy", "name email");

    if (!payroll) {
      return res
        .status(404)
        .json({ success: false, message: "Payroll record not found" });
    }

    res.json({ success: true, data: payroll });
  } catch (error) {
    next(error);
  }
};

// @desc    Create payroll record
// @route   POST /api/payroll
// @access  Private
exports.createPayroll = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;

    const { employee_id, employee, salary, deductions = {}, additionalIncome = {}, salaryOverrides, period, notes } = req.body;

    let employeeSnapshot = employee;
    let salaryData = salary;
    let linkedEmployeeId = null;
    let approvedPeriodInput = null;

    // ── Path A: Create from Employee Master (preferred) ─────────────
    if (employee_id) {
      const emp = await Employee.findOne({
        _id: employee_id,
        company: companyId,
      });

      if (!emp) {
        return res.status(404).json({
          success: false,
          message: "Employee master record not found",
        });
      }

      // Determine pay period boundaries
      const payPeriodStart = new Date(period.year, period.month - 1, 1);
      const payPeriodEnd = new Date(period.year, period.month, 0);

      // Reject if terminated before period starts
      if (emp.status === "terminated" && emp.terminationDate && new Date(emp.terminationDate) < payPeriodStart) {
        return res.status(400).json({
          success: false,
          message: "Employee was terminated before this pay period",
        });
      }

      // Get effective salary for the period
      let effectiveSalary = await SalaryHistory.getEffectiveSalary(emp._id, payPeriodStart, companyId);

      // Fallback: if no salary history but manual salary data provided, use it directly
      if (!effectiveSalary && salary && typeof salary.basicSalary === "number") {
        effectiveSalary = {
          basicSalary: salary.basicSalary || 0,
          transportAllowance: salary.transportAllowance || 0,
          housingAllowance: salary.housingAllowance || 0,
          otherAllowances: salary.otherAllowances || 0,
          occupationalHazardRate: typeof salary.occupationalHazardRate === "number" ? salary.occupationalHazardRate : 2,
        };
      }

      if (!effectiveSalary) {
        return res.status(400).json({
          success: false,
          message: "No active salary history found for this employee for the selected period. Please set a salary first.",
        });
      }

      approvedPeriodInput = await dbClient().payrollPeriodInput.findUnique({
        where: { companyId_employeeId_periodYear_periodMonth: { companyId: String(companyId), employeeId: String(emp._id), periodYear: Number(period.year), periodMonth: Number(period.month) } },
      });
      if (approvedPeriodInput?.status === "applied") throw Object.assign(new Error("Approved payroll inputs have already been applied for this employee and period"), { statusCode: 409 });
      if (approvedPeriodInput?.status === "draft") throw Object.assign(new Error("Attendance and leave inputs must be approved before payroll can be created"), { statusCode: 409 });

      // Build from salary history and only approved period inputs.
      const fromMaster = Payroll.fromEmployeeMaster(emp, effectiveSalary, period, approvedPeriodInput);
      employeeSnapshot = fromMaster.employee;
      salaryData = fromMaster.salary;
      linkedEmployeeId = fromMaster.employee_id;

      // Apply period-specific overrides if provided
      if (salaryOverrides) {
        if (typeof salaryOverrides.basicSalary === "number") salaryData.basicSalary = salaryOverrides.basicSalary;
        if (typeof salaryOverrides.transportAllowance === "number") salaryData.transportAllowance = salaryOverrides.transportAllowance;
        if (typeof salaryOverrides.housingAllowance === "number") salaryData.housingAllowance = salaryOverrides.housingAllowance;
        if (typeof salaryOverrides.otherAllowances === "number") salaryData.otherAllowances = salaryOverrides.otherAllowances;
      }

      // Merge any additional income/deductions from manual salary input
      if (salary) {
        if (typeof salary.overtime === "number") salaryData.overtime = salary.overtime;
        if (typeof salary.bonuses === "number") salaryData.bonuses = salary.bonuses;
        if (typeof salary.commissions === "number") salaryData.commissions = salary.commissions;
        if (typeof salary.benefitsInKind === "number") salaryData.benefitsInKind = salary.benefitsInKind;
        if (typeof salary.healthInsurance === "number") salaryData.healthInsurance = salary.healthInsurance;
        if (typeof salary.loanDeductions === "number") salaryData.loanDeductions = salary.loanDeductions;
        if (typeof salary.otherDeductions === "number") salaryData.otherDeductions = salary.otherDeductions;
        if (typeof salary.occupationalHazardRate === "number") salaryData.occupationalHazardRate = salary.occupationalHazardRate;
        if (typeof salary.vehicleProvided === "boolean") salaryData.vehicleProvided = salary.vehicleProvided;
        if (typeof salary.accommodationProvided === "boolean") salaryData.accommodationProvided = salary.accommodationProvided;
      }
    }

    // ── Path B: Legacy manual entry (backward compat) ────────────────
    if (!employeeSnapshot || !salaryData || !salaryData.basicSalary) {
      return res.status(400).json({
        success: false,
        message: "Employee information and salary are required",
      });
    }
    if (!linkedEmployeeId && !String(employeeSnapshot.employeeId || "").trim()) {
      return res.status(400).json({ success: false, message: "An employee ID is required to prevent duplicate payroll records for the same period." });
    }

    // Calculate payroll using Rwanda tax rules
    const periodDate = new Date(Date.UTC(Number(period.year), Number(period.month), 0, 12));
    const calculatedIncome = {
      overtime: additionalIncome.overtime ?? salaryData.overtime ?? 0,
      bonuses: additionalIncome.bonuses ?? salaryData.bonuses ?? 0,
      commissions: additionalIncome.commissions ?? salaryData.commissions ?? 0,
      benefitsInKind: additionalIncome.benefitsInKind ?? salaryData.benefitsInKind ?? 0,
      vehicleProvided: additionalIncome.vehicleProvided ?? Boolean(salaryData.vehicleProvided),
      accommodationProvided: additionalIncome.accommodationProvided ?? Boolean(salaryData.accommodationProvided),
    };
    const employeeForTax = linkedEmployeeId
      ? await Employee.findOne({ _id: linkedEmployeeId, company: companyId }).lean()
      : employeeSnapshot;
    const salaryForCalculation = approvedPeriodInput && salaryData.originalEarnings
      ? { ...salaryData, ...salaryData.originalEarnings }
      : salaryData;
    const calculated = Payroll.calculatePayroll(salaryForCalculation, {
      periodDate,
      employee: employeeForTax || employeeSnapshot,
      additionalIncome: calculatedIncome,
      deductions: {
        healthInsurance: deductions.healthInsurance ?? approvedPeriodInput?.deductions?.healthInsurance ?? salaryData.healthInsurance ?? 0,
        loanDeductions: deductions.loanDeductions ?? approvedPeriodInput?.deductions?.loanDeductions ?? salaryData.loanDeductions ?? 0,
        otherDeductions: deductions.otherDeductions ?? approvedPeriodInput?.deductions?.otherDeductions ?? salaryData.otherDeductions ?? 0,
      },
      proration: approvedPeriodInput ? { scheduledDays: Number(approvedPeriodInput.scheduledDays), workedDays: Number(approvedPeriodInput.workedDays), paidLeaveDays: Number(approvedPeriodInput.paidLeaveDays), unpaidLeaveDays: Number(approvedPeriodInput.unpaidLeaveDays), status: approvedPeriodInput.status, approvedById: approvedPeriodInput.approvedById, approvedAt: approvedPeriodInput.approvedAt, inputId: approvedPeriodInput.id } : null,
    });

    const payroll = new Payroll({
      company: companyId,
      employee_id: linkedEmployeeId,
      employee: {
        ...employeeSnapshot,
        isActive: employeeSnapshot.isActive !== undefined ? employeeSnapshot.isActive : true,
      },
      salary: {
        ...salaryData,
        ...calculated.earnings,
        ...calculatedIncome,
        grossSalary: calculated.grossSalary,
        grossRemuneration: calculated.grossRemuneration,
        taxableBase: calculated.taxableBase,
        rssbBases: calculated.rssbBases,
        ruleVersion: calculated.ruleVersion,
        ruleEffectiveDate: calculated.ruleEffectiveDate,
        rates: calculated.rates,
        proration: calculated.proration,
        originalEarnings: calculated.originalEarnings,
      },
      deductions: {
        paye: calculated.deductions.paye,
        rssbEmployeePension: calculated.deductions.rssbEmployeePension,
        rssbEmployeeMaternity: calculated.deductions.rssbEmployeeMaternity,
        healthInsurance: calculated.deductions.healthInsurance,
        loanDeductions: calculated.deductions.loanDeductions,
        otherDeductions: calculated.deductions.otherDeductions,
        totalDeductions: calculated.deductions.totalDeductions,
      },
      netPay: calculated.netPay,
      contributions: {
        rssbEmployerPension: calculated.contributions.rssbEmployerPension,
        rssbEmployerMaternity: calculated.contributions.rssbEmployerMaternity,
        occupationalHazard: calculated.contributions.occupationalHazard,
        rates: calculated.rates,
      },
      period: {
        month: period.month,
        year: period.year,
        monthName: Payroll.getMonthName(period.month),
      },
      pay_period_start: new Date(Number(period.year), Number(period.month) - 1, 1),
      pay_period_end: new Date(Number(period.year), Number(period.month), 0),
      notes,
      createdBy: userId,
    });

    await runInPrismaTransaction(async () => {
      await payroll.save();
      if (approvedPeriodInput) {
        const consumed = await dbClient().payrollPeriodInput.updateMany({ where: { id: approvedPeriodInput.id, companyId: String(companyId), status: "approved", appliedPayrollId: null }, data: { status: "applied", appliedPayrollId: String(payroll._id) } });
        if (!consumed.count) throw Object.assign(new Error("Approved payroll input was already applied to another payroll record"), { statusCode: 409 });
        await recordPayrollAudit({ companyId, userId, action: "payroll.period_input.applied", entityType: "payroll_period_input", entityId: approvedPeriodInput.id, before: { status: "approved", appliedPayrollId: null }, after: { status: "applied", appliedPayrollId: String(payroll._id) }, req });
      }
      await recordPayrollAudit({ companyId, userId, action: "payroll.record.created", entityType: "payroll", entityId: payroll._id, before: null, after: payrollSnapshot(payroll), req });
    });

    res.status(201).json({
      success: true,
      data: payroll,
    });
  } catch (error) {
    next(payrollPeriodConflict(error));
  }
};

// @desc    Update payroll record
// @route   PUT /api/payroll/:id
// @access  Private
exports.updatePayroll = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    let payroll = await Payroll.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!payroll) {
      return res
        .status(404)
        .json({ success: false, message: "Payroll record not found" });
    }

    const before = payrollSnapshot(payroll);

    // Check if already paid
    if (payroll.payment.status === "paid") {
      return res.status(400).json({
        success: false,
        message: "Cannot update a paid payroll record",
      });
    }

    const { employee, salary, period, notes, additionalIncome = {}, deductions = {} } = req.body;

    if (payroll.record_status === "finalised") {
      return res.status(400).json({ success: false, message: "Cannot change earnings or deductions after payroll is finalised" });
    }

    // Recalculate if salary changed
    let calculated = null;
    if (salary) {
      const recordPeriodDate = period
        ? new Date(Date.UTC(Number(period.year), Number(period.month), 0, 12))
        : payroll.pay_period_end || new Date();
      const calculationSalary = { ...salary };
      const approvedProration = payroll.salary?.proration?.status === "approved" ? payroll.salary.proration : null;
      if (approvedProration && payroll.salary?.originalEarnings) {
        for (const field of ["basicSalary", "transportAllowance", "housingAllowance", "otherAllowances", "benefitsInKind"]) {
          if (Number(calculationSalary[field] || 0) === Number(payroll.salary[field] || 0)) {
            calculationSalary[field] = payroll.salary.originalEarnings[field] ?? calculationSalary[field];
          }
        }
      }
      calculated = Payroll.calculatePayroll(calculationSalary, {
        periodDate: recordPeriodDate,
        employee: payroll.employee || {},
        additionalIncome: { ...salary, ...additionalIncome },
        deductions: { ...salary, ...deductions },
        proration: approvedProration,
      });
    }

    if (employee) {
      payroll.employee = { ...payroll.employee.toObject(), ...employee };
    }

    if (salary) {
      payroll.salary = {
        ...salary,
        basicSalary: salary.basicSalary,
        transportAllowance: salary.transportAllowance || 0,
        housingAllowance: salary.housingAllowance || 0,
        otherAllowances: salary.otherAllowances || 0,
        overtime: additionalIncome.overtime ?? salary.overtime ?? 0,
        bonuses: additionalIncome.bonuses ?? salary.bonuses ?? 0,
        commissions: additionalIncome.commissions ?? salary.commissions ?? 0,
        benefitsInKind: additionalIncome.benefitsInKind ?? salary.benefitsInKind ?? 0,
        vehicleProvided: additionalIncome.vehicleProvided ?? Boolean(salary.vehicleProvided),
        accommodationProvided: additionalIncome.accommodationProvided ?? Boolean(salary.accommodationProvided),
        grossSalary: calculated.grossSalary,
        grossRemuneration: calculated.grossRemuneration,
        taxableBase: calculated.taxableBase,
        rssbBases: calculated.rssbBases,
        ruleVersion: calculated.ruleVersion,
        ruleEffectiveDate: calculated.ruleEffectiveDate,
        rates: calculated.rates,
        proration: calculated.proration,
        originalEarnings: calculated.originalEarnings,
      };
      payroll.deductions = {
        paye: calculated.deductions.paye,
        rssbEmployeePension: calculated.deductions.rssbEmployeePension,
        rssbEmployeeMaternity: calculated.deductions.rssbEmployeeMaternity,
        healthInsurance: calculated.deductions.healthInsurance,
        loanDeductions: calculated.deductions.loanDeductions,
        otherDeductions: calculated.deductions.otherDeductions,
        totalDeductions: calculated.deductions.totalDeductions,
      };
      payroll.netPay = calculated.netPay;
      payroll.contributions = {
        rssbEmployerPension: calculated.contributions.rssbEmployerPension,
        rssbEmployerMaternity: calculated.contributions.rssbEmployerMaternity,
        occupationalHazard: calculated.contributions.occupationalHazard,
        rates: calculated.rates,
      };
    }

    if (period) {
      payroll.period = {
        month: period.month,
        year: period.year,
        monthName: Payroll.getMonthName(period.month),
      };
      payroll.pay_period_start = new Date(Number(period.year), Number(period.month) - 1, 1);
      payroll.pay_period_end = new Date(Number(period.year), Number(period.month), 0);
    }

    if (notes !== undefined) {
      payroll.notes = notes;
    }

    payroll.updatedAt = new Date();
    await runInPrismaTransaction(async () => {
      await payroll.save();
      await recordPayrollAudit({ companyId, userId: req.user._id, action: "payroll.record.updated", entityType: "payroll", entityId: payroll._id, before, after: payrollSnapshot(payroll), req });
    });

    res.json({
      success: true,
      data: payroll,
    });
  } catch (error) {
    next(payrollPeriodConflict(error));
  }
};

// @desc    Delete payroll record
// @route   DELETE /api/payroll/:id
// @access  Private
exports.deletePayroll = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const payroll = await Payroll.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!payroll) {
      return res
        .status(404)
        .json({ success: false, message: "Payroll record not found" });
    }

    // Check if already paid
    if (payroll.payment.status === "paid") {
      return res.status(400).json({
        success: false,
        message: "Cannot delete a paid payroll record",
      });
    }

    if (payroll.payroll_run_id) {
      return res.status(409).json({
        success: false,
        message: "This payroll record belongs to a payroll run and cannot be deleted. Reverse or cancel the run first.",
        code: "PAYROLL_RECORD_ASSIGNED_TO_RUN",
      });
    }

    const before = payrollSnapshot(payroll);
    await runInPrismaTransaction(async () => {
      await payroll.deleteOne();
      await recordPayrollAudit({ companyId, userId: req.user._id, action: "payroll.record.deleted", entityType: "payroll", entityId: req.params.id, before, after: null, req });
    });

    res.json({
      success: true,
      message: "Payroll record deleted",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Process payroll payment
// @route   POST /api/payroll/:id/pay
// @access  Private
exports.processPayment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;

    const { paymentMethod, reference, notes, bankAccountId } = req.body;

    const payroll = await Payroll.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!payroll) {
      return res
        .status(404)
        .json({ success: false, message: "Payroll record not found" });
    }

    if (payroll.payment.status === "paid") {
      return res.status(400).json({
        success: false,
        message: "Payment already processed",
      });
    }

    payroll.payment = {
      status: "paid",
      paymentDate: new Date(),
      paymentMethod: paymentMethod || "bank_transfer",
      reference: reference,
    };

    payroll.approvedBy = userId;
    await payroll.save();

    // Create BankTransaction on the specific bank account (withdrawal — salary paid out)
    if (
      bankAccountId &&
      (paymentMethod === "bank_transfer" ||
        paymentMethod === "bank" ||
        paymentMethod === "cheque" ||
        paymentMethod === "mobile_money")
    ) {
      try {
        const { BankAccount } = require("../models/BankAccount");
        const bankAcct = await BankAccount.findOne({
          _id: bankAccountId,
          company: companyId,
          isActive: true,
        });
        if (bankAcct) {
          const netPay = payroll.netPay || 0;
          await bankAcct.addTransaction({
            type: "withdrawal",
            amount: netPay,
            description: `Salary: ${payroll.employee?.firstName || ""} ${payroll.employee?.lastName || ""} — ${payroll.period?.monthName || ""} ${payroll.period?.year || ""}`,
            date: new Date(),
            referenceNumber: reference || String(payroll._id),
            paymentMethod:
              paymentMethod === "bank" ? "bank_transfer" : paymentMethod,
            status: "completed",
            reference: payroll._id,
            referenceType: "Payment",
            createdBy: userId,
            notes: notes || `Payroll payment`,
          });
        }
      } catch (btErr) {
        console.error(
          "Failed to create BankTransaction for payroll:",
          btErr.message,
        );
        // Non-fatal — journal entries still post correctly
      }
    }

    // ── Payment journal entry ────────────────────────────────────────────────
    // Since finalisePayroll() already created the payroll expense accrual:
    //   DR Salaries / CR PAYE Payable / CR RSSB Payable / CR Accrued Payroll (2600)
    //
    // processPayment only needs to clear the accrued payroll and pay the bank:
    //   DR 2600 Accrued Payroll  (net pay)
    //   CR Bank/Cash             (net pay)
    //
    // If the record was NOT finalised via the normal flow (record_status went
    // straight from draft to paid via legacy path), fall back to the full journal
    // so the GL is always complete.
    try {
      const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");

      // Resolve the bank/cash GL account
      let cashAccount;
      if (bankAccountId) {
        const { BankAccount: BA } = require("../models/BankAccount");
        const bankAcctForJournal = await BA.findOne({
          _id: bankAccountId,
          company: companyId,
          isActive: true,
        });
        cashAccount =
          bankAcctForJournal?.ledgerAccountId || DEFAULT_ACCOUNTS.cashAtBank;
      } else {
        cashAccount =
          paymentMethod === "bank"
            ? DEFAULT_ACCOUNTS.cashAtBank
            : DEFAULT_ACCOUNTS.cashInHand;
      }

      const netPay = payroll.netPay || 0;
      const grossSalary = payroll.salary?.grossSalary || 0;
      const paye = payroll.deductions?.paye || 0;
      const rssbEmployeeTotal =
        (payroll.deductions?.rssbEmployeePension || 0) +
        (payroll.deductions?.rssbEmployeeMaternity || 0);
      const rssbEmployerPensionMaternity =
        (payroll.contributions?.rssbEmployerPension || 0) +
        (payroll.contributions?.rssbEmployerMaternity || 0);
      const occupationalHazard = payroll.contributions?.occupationalHazard || 0;
      const employerContribTotal = rssbEmployerPensionMaternity + occupationalHazard;

      const employeeName =
        `${payroll.employee?.firstName || ""} ${payroll.employee?.lastName || ""}`.trim();
      const periodLabel =
        `${payroll.period?.monthName || ""} ${payroll.period?.year || ""}`.trim();

      // Check if a finalize accrual journal was already posted for this record
      const JournalEntry = require("../models/JournalEntry");
      const accrualExists = await JournalEntry.exists({
        company: companyId,
        sourceType: "payroll_salary",
        sourceId: payroll._id,
        status: "posted",
      });

      if (accrualExists && netPay > 0) {
        // ── Path A: Accrual already posted by finalise ──────────────────────
        // Only post the cash disbursement: DR Accrued Payroll / CR Bank
        await JournalService.createEntry(companyId, userId, {
          date: new Date(),
          description: `Salary Payment (cash) — ${employeeName} — ${periodLabel}`,
          sourceType: "payroll_salary",
          sourceId: payroll._id,
          lines: [
            JournalService.createDebitLine(
              DEFAULT_ACCOUNTS.accruedExpenses || "2600",
              netPay,
              `Clear accrued salary — ${employeeName}`,
            ),
            JournalService.createCreditLine(
              cashAccount,
              netPay,
              `Net salary paid — ${employeeName}`,
            ),
          ],
          isAutoGenerated: true,
          // Allow a second entry on the same sourceId for this record
          allowDuplicate: true,
        });
      } else if (!accrualExists && grossSalary > 0) {
        // ── Path B: Legacy / direct-pay path — no prior accrual ──────────────
        // Post the full payroll journal in one entry (expense + payment combined)
        const lines1 = [
          JournalService.createDebitLine(
            DEFAULT_ACCOUNTS.salariesWages || "5400",
            grossSalary,
            `Salary payment — ${employeeName} — ${periodLabel}`,
          ),
        ];
        if (paye > 0) {
          lines1.push(
            JournalService.createCreditLine(
              DEFAULT_ACCOUNTS.payePayable ||
                DEFAULT_ACCOUNTS.payePayable ||
                "2230",
              paye,
              `PAYE withheld — ${employeeName}`,
            ),
          );
        }
        if (rssbEmployeeTotal > 0) {
          lines1.push(
            JournalService.createCreditLine(
              DEFAULT_ACCOUNTS.rssbPayable ||
                DEFAULT_ACCOUNTS.rssbPayable ||
                "2240",
              rssbEmployeeTotal,
              `RSSB employee deduction — ${employeeName}`,
            ),
          );
        }
        if (occupationalHazard > 0) {
          lines1.push(
            JournalService.createDebitLine(
              DEFAULT_ACCOUNTS.rssbEmployerCost || "6150",
              occupationalHazard,
              `Occupational hazard — ${employeeName}`,
            ),
          );
          lines1.push(
            JournalService.createCreditLine(
              DEFAULT_ACCOUNTS.employerContributionPayable || "2310",
              occupationalHazard,
              `Occupational hazard payable — ${employeeName}`,
            ),
          );
        }
        if (netPay > 0) {
          lines1.push(
            JournalService.createCreditLine(
              cashAccount,
              netPay,
              `Net salary paid — ${employeeName}`,
            ),
          );
        }
        if (lines1.length >= 2) {
          await JournalService.createEntry(companyId, userId, {
            date: new Date(),
            description: `Salary Payment — ${employeeName} — ${periodLabel}`,
            sourceType: "payroll_salary",
            sourceId: payroll._id,
            lines: lines1,
            isAutoGenerated: true,
          });
        }

        // Employer contributions — pension/maternity only (occupational hazard in main journal)
        if (rssbEmployerPensionMaternity > 0) {
          await JournalService.createEntry(companyId, userId, {
            date: new Date(),
            description: `Employer RSSB — ${employeeName} — ${periodLabel}`,
            sourceType: "payroll_employer",
            sourceId: payroll._id,
            lines: [
              JournalService.createDebitLine(
                DEFAULT_ACCOUNTS.rssbEmployerCost || "6150",
                rssbEmployerPensionMaternity,
                `Employer RSSB — ${employeeName}`,
              ),
              JournalService.createCreditLine(
                DEFAULT_ACCOUNTS.rssbPayable || "2240",
                rssbEmployerPensionMaternity,
                `Employer RSSB pension/maternity — ${employeeName}`,
              ),
            ],
            isAutoGenerated: true,
            allowDuplicate: true,
          });
        }
      }
    } catch (journalError) {
      console.error(
        "[processPayment] Journal entry creation failed:",
        journalError.message,
      );
      // Non-fatal — BankTransaction and payment status are already saved
    }

    res.json({
      success: true,
      data: payroll,
      message: "Payment processed successfully",
    });
  } catch (error) {
    next(error);
  }
};

exports.getPayrollPeriodInputs = async (req, res, next) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) {
      return res.status(400).json({ success: false, message: "A valid month and year are required" });
    }
    const rows = await dbClient().payrollPeriodInput.findMany({
      where: { companyId: String(req.user.company._id), periodMonth: month, periodYear: year },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });
    return res.json({ success: true, data: rows });
  } catch (error) { return next(error); }
};

exports.savePayrollPeriodInput = async (req, res, next) => {
  try {
    const companyId = String(req.user.company._id);
    const userId = String(req.user._id);
    const { employeeId, periodMonth, periodYear } = req.body;
    const month = Number(periodMonth), year = Number(periodYear);
    const scheduledDays = Number(req.body.scheduledDays);
    const workedDays = Number(req.body.workedDays || 0);
    const paidLeaveDays = Number(req.body.paidLeaveDays || 0);
    const unpaidLeaveDays = Number(req.body.unpaidLeaveDays || 0);
    if (!employeeId || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) throw Object.assign(new Error("Employee and a valid period are required"), { statusCode: 400 });
    if (![scheduledDays, workedDays, paidLeaveDays, unpaidLeaveDays].every(Number.isFinite) || scheduledDays <= 0 || [workedDays, paidLeaveDays, unpaidLeaveDays].some((value) => value < 0) || workedDays + paidLeaveDays + unpaidLeaveDays > scheduledDays + 0.0001) {
      throw Object.assign(new Error("Attendance and leave days must be valid and cannot exceed scheduled work days"), { statusCode: 400 });
    }
    const employee = await Employee.findOne({ _id: employeeId, company: companyId });
    if (!employee) throw Object.assign(new Error("Employee not found"), { statusCode: 404 });
    const existing = await dbClient().payrollPeriodInput.findUnique({ where: { companyId_employeeId_periodYear_periodMonth: { companyId, employeeId: String(employeeId), periodYear: year, periodMonth: month } } });
    if (existing && existing.status !== "draft") throw Object.assign(new Error("Approved or applied payroll inputs cannot be edited"), { statusCode: 409 });
    const earningKeys = ["overtime", "bonuses", "commissions", "benefitsInKind", "vehicleProvided", "accommodationProvided"];
    const deductionKeys = ["healthInsurance", "loanDeductions", "otherDeductions"];
    const pick = (source, keys) => Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));
    const additionalIncome = pick(req.body.additionalIncome || {}, earningKeys);
    const deductions = pick(req.body.deductions || {}, deductionKeys);
    for (const [key, value] of [...Object.entries(additionalIncome), ...Object.entries(deductions)]) {
      if (typeof value === "boolean" && ["vehicleProvided", "accommodationProvided"].includes(key)) continue;
      if (!Number.isFinite(Number(value)) || Number(value) < 0) throw Object.assign(new Error(`${key} must be a non-negative amount`), { statusCode: 400 });
    }
    const base = {
      companyId, employeeId: String(employeeId), periodMonth: month, periodYear: year,
      scheduledDays: String(scheduledDays), workedDays: String(workedDays), paidLeaveDays: String(paidLeaveDays), unpaidLeaveDays: String(unpaidLeaveDays),
      additionalIncome, deductions, notes: String(req.body.notes || ""), status: "draft", enteredById: userId,
      approvedById: null, approvedAt: null,
    };
    const row = await runInPrismaTransaction(async () => {
      const saved = existing
        ? await dbClient().payrollPeriodInput.update({ where: { id: existing.id }, data: base })
        : await dbClient().payrollPeriodInput.create({ data: { id: generateObjectId(), ...base } });
      await recordPayrollAudit({ companyId, userId, action: existing ? "payroll.period_input.updated" : "payroll.period_input.created", entityType: "payroll_period_input", entityId: saved.id, before: existing ? { ...existing } : null, after: { ...saved }, req });
      return saved;
    });
    return res.status(existing ? 200 : 201).json({ success: true, data: row });
  } catch (error) { return next(error); }
};

exports.approvePayrollPeriodInput = async (req, res, next) => {
  try {
    const companyId = String(req.user.company._id);
    const userId = String(req.user._id);
    const row = await dbClient().payrollPeriodInput.findFirst({ where: { id: String(req.params.inputId), companyId } });
    if (!row) throw Object.assign(new Error("Payroll period input not found"), { statusCode: 404 });
    if (row.status !== "draft") throw Object.assign(new Error("Only draft payroll inputs can be approved"), { statusCode: 409 });
    if (sameActor(row.enteredById, userId)) throw Object.assign(new Error("Payroll inputs must be approved by a different user than the preparer"), { statusCode: 403, code: "PAYROLL_APPROVAL_SEPARATION_REQUIRED" });
    const scheduled = Number(row.scheduledDays), worked = Number(row.workedDays), paidLeave = Number(row.paidLeaveDays), unpaidLeave = Number(row.unpaidLeaveDays);
    if (scheduled <= 0 || worked + paidLeave + unpaidLeave > scheduled + 0.0001) throw Object.assign(new Error("Attendance and leave totals are invalid"), { statusCode: 400 });
    const updatedRow = await runInPrismaTransaction(async () => {
      const updated = await dbClient().payrollPeriodInput.updateMany({ where: { id: row.id, companyId, status: "draft" }, data: { status: "approved", approvedById: userId, approvedAt: new Date() } });
      if (!updated.count) throw Object.assign(new Error("Input was changed by another user; refresh and retry"), { statusCode: 409 });
      const result = await dbClient().payrollPeriodInput.findUnique({ where: { id: row.id } });
      await recordPayrollAudit({ companyId, userId, action: "payroll.period_input.approved", entityType: "payroll_period_input", entityId: row.id, before: { status: row.status, enteredById: row.enteredById }, after: { status: result.status, approvedById: result.approvedById, approvedAt: result.approvedAt }, req });
      return result;
    });
    return res.json({ success: true, data: updatedRow });
  } catch (error) { return next(error); }
};

// @desc    Get payroll summary
// @route   GET /api/payroll/summary
// @access  Private
exports.getPayrollSummary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { year } = req.query;

    const query = { company: companyId };
    let payPeriodStartFilter = null;
    if (year) {
      payPeriodStartFilter = {
        gte: new Date(parseInt(year), 0, 1),
        lte: new Date(parseInt(year), 11, 31),
      };
    }

    // Get all payroll for the year
    const payrollRecords = await Payroll.find({
      ...query,
      ...(payPeriodStartFilter ? { pay_period_start: payPeriodStartFilter } : {}),
    }).sort({
      payPeriodStart: -1,
      createdAt: -1,
    });

    // Group by month
    const monthlyData = {};
    let totalGross = 0;
    let totalNet = 0;
    let totalPAYE = 0;
    let totalRSSB = 0;
    let totalEmployerContrib = 0;

    payrollRecords.forEach((record) => {
      const key = `${record.period.year}-${String(record.period.month).padStart(2, "0")}`;
      if (!monthlyData[key]) {
        monthlyData[key] = {
          month: record.period.month,
          year: record.period.year,
          monthName: record.period.monthName,
          grossSalary: 0,
          netPay: 0,
          paye: 0,
          rssb: 0,
          employerContrib: 0,
          employeeCount: 0,
        };
      }

      monthlyData[key].grossSalary += record.salary.grossSalary || 0;
      monthlyData[key].netPay += record.netPay || 0;
      monthlyData[key].paye += record.deductions.paye || 0;
      monthlyData[key].rssb +=
        (record.deductions.rssbEmployeePension || 0) +
        (record.deductions.rssbEmployeeMaternity || 0);
      monthlyData[key].employerContrib +=
        (record.contributions.rssbEmployerPension || 0) +
        (record.contributions.rssbEmployerMaternity || 0) +
        (record.contributions.occupationalHazard || 0);
      monthlyData[key].employeeCount += 1;

      totalGross += record.salary.grossSalary || 0;
      totalNet += record.netPay || 0;
      totalPAYE += record.deductions.paye || 0;
      totalRSSB +=
        (record.deductions.rssbEmployeePension || 0) +
        (record.deductions.rssbEmployeeMaternity || 0);
      totalEmployerContrib +=
        (record.contributions.rssbEmployerPension || 0) +
        (record.contributions.rssbEmployerMaternity || 0) +
        (record.contributions.occupationalHazard || 0);
    });

    // Get current month stats
    const now = new Date();
    const currentMonthPayroll = payrollRecords.filter(
      (p) =>
        p.period.month === now.getMonth() + 1 &&
        p.period.year === now.getFullYear(),
    );

    const currentMonthGross = currentMonthPayroll.reduce(
      (sum, p) => sum + (p.salary.grossSalary || 0),
      0,
    );
    const currentMonthNet = currentMonthPayroll.reduce(
      (sum, p) => sum + (p.netPay || 0),
      0,
    );

    res.json({
      success: true,
      data: {
        monthlyData: Object.values(monthlyData).reverse(),
        totals: {
          totalGrossSalary: Math.round(totalGross * 100) / 100,
          totalNetPay: Math.round(totalNet * 100) / 100,
          totalPAYE: Math.round(totalPAYE * 100) / 100,
          totalRSSB: Math.round(totalRSSB * 100) / 100,
          totalEmployerContrib: Math.round(totalEmployerContrib * 100) / 100,
        },
        currentMonth: {
          grossSalary: Math.round(currentMonthGross * 100) / 100,
          netPay: Math.round(currentMonthNet * 100) / 100,
          employeeCount: currentMonthPayroll.length,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Calculate payroll (preview)
// @route   POST /api/payroll/calculate
// @access  Private
exports.calculatePayroll = async (req, res, next) => {
  try {
    const { salary, deductions = {}, additionalIncome = {}, employee = {}, period } = req.body;

    if (!salary || !salary.basicSalary) {
      return res.status(400).json({
        success: false,
        message: "Basic salary is required",
      });
    }

    const periodDate = period?.month && period?.year
      ? new Date(Date.UTC(Number(period.year), Number(period.month), 0, 12))
      : new Date();
    const calculated = Payroll.calculatePayroll(salary, { periodDate, employee, additionalIncome, deductions });

    res.json({
      success: true,
      data: {
        ...calculated,
        taxBrackets: calculated.payeBreakdown.map((band) => ({
          range: `${band.from.toLocaleString()} - ${band.to == null ? "above" : band.to.toLocaleString()}`,
          rate: `${band.rate * 100}%`,
          tax: band.tax,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Bulk create payroll for all employees
// @route   POST /api/payroll/bulk
// @access  Private
exports.bulkCreatePayroll = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;

    const { employees, period, notes } = req.body;

    if (!employees || !Array.isArray(employees) || employees.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Employees array is required",
      });
    }
    const employeeKeys = employees.map((item) => String(item.employee_id || item.employee?.employeeId || "").trim().toLowerCase());
    if (employeeKeys.some((key) => !key) || new Set(employeeKeys).size !== employeeKeys.length) {
      return res.status(400).json({ success: false, message: "Bulk payroll requires a unique employee ID for every employee." });
    }

    const createdPayroll = [];

    for (const emp of employees) {
      const periodDate = new Date(Date.UTC(Number(period.year), Number(period.month), 0, 12));
      const additionalIncome = {
        overtime: emp.additionalIncome?.overtime ?? emp.salary.overtime ?? 0,
        bonuses: emp.additionalIncome?.bonuses ?? emp.salary.bonuses ?? 0,
        commissions: emp.additionalIncome?.commissions ?? emp.salary.commissions ?? 0,
        benefitsInKind: emp.additionalIncome?.benefitsInKind ?? emp.salary.benefitsInKind ?? 0,
        vehicleProvided: emp.additionalIncome?.vehicleProvided ?? Boolean(emp.salary.vehicleProvided),
        accommodationProvided: emp.additionalIncome?.accommodationProvided ?? Boolean(emp.salary.accommodationProvided),
      };
      const deductionInputs = { ...emp.salary, ...(emp.deductions || {}) };
      const calculated = Payroll.calculatePayroll(emp.salary, {
        periodDate,
        employee: emp.employee || {},
        additionalIncome,
        deductions: deductionInputs,
      });

      const payroll = new Payroll({
        company: companyId,
        employee: {
          ...emp.employee,
          isActive: true,
        },
        salary: {
          ...emp.salary,
          ...calculated.earnings,
          basicSalary: emp.salary.basicSalary,
          ...additionalIncome,
          grossSalary: calculated.grossSalary,
          grossRemuneration: calculated.grossRemuneration,
          taxableBase: calculated.taxableBase,
          rssbBases: calculated.rssbBases,
          ruleVersion: calculated.ruleVersion,
          ruleEffectiveDate: calculated.ruleEffectiveDate,
          rates: calculated.rates,
          originalEarnings: calculated.originalEarnings,
          proration: calculated.proration,
        },
        deductions: {
          paye: calculated.deductions.paye,
          rssbEmployeePension: calculated.deductions.rssbEmployeePension,
          rssbEmployeeMaternity: calculated.deductions.rssbEmployeeMaternity,
          healthInsurance: calculated.deductions.healthInsurance,
          loanDeductions: calculated.deductions.loanDeductions,
          otherDeductions: calculated.deductions.otherDeductions,
          totalDeductions: calculated.deductions.totalDeductions,
        },
        netPay: calculated.netPay,
        contributions: {
          rssbEmployerPension: calculated.contributions.rssbEmployerPension,
          rssbEmployerMaternity: calculated.contributions.rssbEmployerMaternity,
          occupationalHazard: calculated.contributions.occupationalHazard,
          rates: calculated.rates,
        },
        period: {
          month: period.month,
          year: period.year,
          monthName: Payroll.getMonthName(period.month),
        },
        pay_period_start: new Date(Number(period.year), Number(period.month) - 1, 1),
        pay_period_end: new Date(Number(period.year), Number(period.month), 0),
        notes,
        createdBy: userId,
      });

      await runInPrismaTransaction(async () => {
        await payroll.save();
        await recordPayrollAudit({ companyId, userId, action: "payroll.record.created", entityType: "payroll", entityId: payroll._id, before: null, after: payrollSnapshot(payroll), req });
      });
      createdPayroll.push(payroll);
    }

    res.status(201).json({
      success: true,
      count: createdPayroll.length,
      data: createdPayroll,
    });
  } catch (error) {
    next(payrollPeriodConflict(error));
  }
};

// @desc    Generate payroll for all active employees (or selected subset)
// @route   POST /api/payroll/generate
// @access  Private (admin, manager)
exports.generatePayroll = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;

    const { period, employeeIds, payrollRunId } = req.body;

    if (!period || !period.month || !period.year) {
      return res.status(400).json({
        success: false,
        message: "period.month and period.year are required",
      });
    }

    const payPeriodStart = new Date(period.year, period.month - 1, 1);
    const payPeriodEnd = new Date(period.year, period.month, 0);

    // Build employee query
    const empQuery = { company: companyId };
    if (employeeIds && Array.isArray(employeeIds) && employeeIds.length > 0) {
      empQuery._id = { $in: employeeIds };
    } else {
      empQuery.status = "active";
    }

    const employees = await Employee.find(empQuery).lean();
    const approvedInputs = await dbClient().payrollPeriodInput.findMany({
      where: { companyId: String(companyId), periodMonth: Number(period.month), periodYear: Number(period.year), status: { in: ["draft", "approved"] } },
    });
    const approvedInputByEmployee = new Map(approvedInputs.map((input) => [String(input.employeeId), input]));
    const createdRecords = [];
    const errors = [];

    for (const emp of employees) {
      try {
        // Skip if hire date is after period end
        if (emp.hireDate && new Date(emp.hireDate) > payPeriodEnd) {
          errors.push({
            employeeId: emp.employeeId,
            name: `${emp.firstName} ${emp.lastName}`,
            reason: "Hire date is after the pay period",
          });
          continue;
        }

        // Skip if terminated before period starts
        if (emp.status === "terminated" && emp.terminationDate && new Date(emp.terminationDate) < payPeriodStart) {
          errors.push({
            employeeId: emp.employeeId,
            name: `${emp.firstName} ${emp.lastName}`,
            reason: "Terminated before the pay period",
          });
          continue;
        }

        // Get effective salary for the period
        const effectiveSalary = await SalaryHistory.getEffectiveSalary(emp._id, payPeriodStart, companyId);
        if (!effectiveSalary) {
          errors.push({
            employeeId: emp.employeeId,
            name: `${emp.firstName} ${emp.lastName}`,
            reason: "No active salary history for the selected period",
          });
          continue;
        }

        // Build payroll from master
        const approvedInput = approvedInputByEmployee.get(String(emp._id)) || null;
        if (approvedInput?.status === "draft") {
          errors.push({ employeeId: emp.employeeId, name: `${emp.firstName} ${emp.lastName}`, reason: "Attendance and leave inputs must be approved before payroll can be generated" });
          continue;
        }
        const fromMaster = Payroll.fromEmployeeMaster(emp, effectiveSalary, period, approvedInput);

        // Assemble full payroll document
        const payrollDoc = {
          company: companyId,
          employee_id: fromMaster.employee_id,
          employee: fromMaster.employee,
          salary: fromMaster.salary,
          deductions: fromMaster.deductions,
          netPay: fromMaster.netPay,
          contributions: fromMaster.contributions,
          period: fromMaster.period,
          payroll_run_id: payrollRunId || null,
          pay_period_start: payPeriodStart,
          pay_period_end: payPeriodEnd,
          createdBy: userId,
        };

        const payroll = new Payroll(payrollDoc);
        await runInPrismaTransaction(async () => {
          await payroll.save();
          if (approvedInput) {
            const consumed = await dbClient().payrollPeriodInput.updateMany({ where: { id: approvedInput.id, companyId: String(companyId), status: "approved", appliedPayrollId: null }, data: { status: "applied", appliedPayrollId: String(payroll._id) } });
            if (!consumed.count) throw Object.assign(new Error("Approved payroll input was already applied"), { statusCode: 409 });
            await recordPayrollAudit({ companyId, userId, action: "payroll.period_input.applied", entityType: "payroll_period_input", entityId: approvedInput.id, before: { status: "approved", appliedPayrollId: null }, after: { status: "applied", appliedPayrollId: String(payroll._id) }, req });
          }
          await recordPayrollAudit({ companyId, userId, action: "payroll.record.created", entityType: "payroll", entityId: payroll._id, before: null, after: payrollSnapshot(payroll), req });
        });
        createdRecords.push(payroll);
      } catch (err) {
        // Catch duplicate key (employee already has payroll for this period)
        if ([11000, "P2002", "23505"].includes(err.code)) {
          errors.push({
            employeeId: emp.employeeId,
            name: `${emp.firstName} ${emp.lastName}`,
            reason: "Payroll already exists for this employee and period",
          });
        } else {
          errors.push({
            employeeId: emp.employeeId,
            name: `${emp.firstName} ${emp.lastName}`,
            reason: err.message || "Unknown error",
          });
        }
      }
    }

    res.status(201).json({
      success: true,
      count: createdRecords.length,
      errors: errors.length > 0 ? errors : undefined,
      data: createdRecords,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Finalise payroll record (ready for PayrollRun)
// @route   POST /api/payroll/:id/finalise
// @access  Private (admin, manager)
exports.finalisePayroll = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const payroll = await Payroll.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!payroll) {
      return res
        .status(404)
        .json({ success: false, message: "Payroll record not found" });
    }

    // Check if already finalised or paid
    if (payroll.record_status === "finalised") {
      const postingResult = await postPayrollAccrualJournals(
        companyId,
        req.user._id,
        payroll,
      );

      if (postingResult.allocation) {
        payroll.laborAllocation = {
          directAmount: postingResult.allocation.directAmount,
          indirectAmount: postingResult.allocation.indirectAmount,
          directPercentage: postingResult.allocation.directPct,
          indirectPercentage: postingResult.allocation.indirectPct,
          source: postingResult.allocation.source,
          timesheetId: postingResult.allocation.timesheetId,
        };
        await payroll.save();
      }

      return res.json({
        success: true,
        data: payroll,
        message: "Payroll record already finalised; journal entries are posted",
      });
    }

    if (payroll.record_status === "paid") {
      return res.status(400).json({
        success: false,
        message: "Payroll record already paid",
      });
    }

    // Set pay period if not set
    if (!payroll.pay_period_start || !payroll.pay_period_end) {
      const year = payroll.period.year;
      const month = payroll.period.month;
      payroll.pay_period_start = new Date(year, month - 1, 1);
      payroll.pay_period_end = new Date(year, month, 0); // Last day of month
    }

    const postingResult = await postPayrollAccrualJournals(
      companyId,
      req.user._id,
      payroll,
    );

    if (postingResult.allocation) {
      payroll.laborAllocation = {
        directAmount: postingResult.allocation.directAmount,
        indirectAmount: postingResult.allocation.indirectAmount,
        directPercentage: postingResult.allocation.directPct,
        indirectPercentage: postingResult.allocation.indirectPct,
        source: postingResult.allocation.source,
        timesheetId: postingResult.allocation.timesheetId,
      };
    }

    payroll.record_status = "finalised";
    await payroll.save();

    // ── IAS 19: Recognise payroll expense when the obligation is created ────────
    // Journal 1 — Payroll expense accrual (split by labor type):
    //   DR  5300  Direct Labor          (direct portion of grossSalary)
    //   DR  5400  Salaries & Wages      (indirect portion of grossSalary)
    //   CR  2230  PAYE Tax Payable        (paye)
    //   CR  2240  RSSB Employee Payable   (rssbEmployeePension + rssbEmployeeMaternity)
    //   CR  2600  Accrued Payroll         (netPay  — salary owed but not yet paid)
    //
    // Journal 2 — Employer contribution accrual:
    //   DR  6150  RSSB Employer Cost      (rssbEmployerPension + rssbEmployerMaternity + occupationalHazard)
    //   CR  2240  RSSB Payable            (same amount)
    try {
      const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");

      const grossSalary = payroll.salary?.grossSalary || 0;
      const paye = payroll.deductions?.paye || 0;
      const rssbEmployee =
        (payroll.deductions?.rssbEmployeePension || 0) +
        (payroll.deductions?.rssbEmployeeMaternity || 0);
      const netPay = payroll.netPay || 0;
      const rssbEmployerPensionMaternity =
        (payroll.contributions?.rssbEmployerPension || 0) +
        (payroll.contributions?.rssbEmployerMaternity || 0);
      const occupationalHazard = payroll.contributions?.occupationalHazard || 0;
      const rssbEmployer = rssbEmployerPensionMaternity + occupationalHazard;

      const employeeName =
        `${payroll.employee?.firstName || ""} ${payroll.employee?.lastName || ""}`.trim();
      const periodLabel =
        `${payroll.period?.monthName || ""} ${payroll.period?.year || ""}`.trim();

      // ── Labor Cost Allocation for this employee ──────────────────────────────
      const allocation = await LaborAllocationService.allocateForEmployee(
        payroll.employee_id,
        grossSalary,
        payroll.period?.month,
        payroll.period?.year,
        companyId
      );

      // Store allocation on payroll record
      payroll.laborAllocation = {
        directAmount: allocation.directAmount,
        indirectAmount: allocation.indirectAmount,
        directPercentage: allocation.directPct,
        indirectPercentage: allocation.indirectPct,
        source: allocation.source,
        timesheetId: allocation.timesheetId
      };
      await payroll.save();

      // Journal 1: payroll expense + liabilities (split 5300/5400)
      if (grossSalary > 0) {
        const lines1 = [];

        // DR 5300 Direct Labor (direct portion)
        if (allocation.directAmount > 0) {
          lines1.push(
            JournalService.createDebitLine(
              DEFAULT_ACCOUNTS.directLabor || "5300",
              allocation.directAmount,
              `Direct labor accrual — ${employeeName} — ${periodLabel}`,
            ),
          );
        }

        // DR 5400 Salaries & Wages (indirect portion)
        if (allocation.indirectAmount > 0) {
          lines1.push(
            JournalService.createDebitLine(
              DEFAULT_ACCOUNTS.salariesWages || "5400",
              allocation.indirectAmount,
              `Salary accrual — ${employeeName} — ${periodLabel}`,
            ),
          );
        }

        if (paye > 0) {
          lines1.push(
            JournalService.createCreditLine(
              DEFAULT_ACCOUNTS.payePayable ||
                DEFAULT_ACCOUNTS.payePayable ||
                "2230",
              paye,
              `PAYE withheld — ${employeeName}`,
            ),
          );
        }

        if (rssbEmployee > 0) {
          lines1.push(
            JournalService.createCreditLine(
              DEFAULT_ACCOUNTS.rssbPayable ||
                DEFAULT_ACCOUNTS.rssbPayable ||
                "2240",
              rssbEmployee,
              `RSSB employee deduction — ${employeeName}`,
            ),
          );
        }

        // Occupational Hazard — employer contribution posted in same journal
        if (occupationalHazard > 0) {
          lines1.push(
            JournalService.createDebitLine(
              DEFAULT_ACCOUNTS.rssbEmployerCost || "6150",
              occupationalHazard,
              `Occupational hazard — ${employeeName}`,
            ),
          );
          lines1.push(
            JournalService.createCreditLine(
              DEFAULT_ACCOUNTS.employerContributionPayable || "2310",
              occupationalHazard,
              `Occupational hazard payable — ${employeeName}`,
            ),
          );
        }

        // Credit other employee deductions (health insurance, loans, other)
        const healthInsurance = payroll.deductions?.healthInsurance || 0;
        const loanDeductions = payroll.deductions?.loanDeductions || 0;
        const otherDeductions = payroll.deductions?.otherDeductions || 0;

        if (healthInsurance > 0) {
          lines1.push(
            JournalService.createCreditLine(
              DEFAULT_ACCOUNTS.accruedExpenses || "2600",
              healthInsurance,
              `Health Insurance Payable — ${employeeName}`,
            ),
          );
        }

        if (loanDeductions > 0) {
          lines1.push(
            JournalService.createCreditLine(
              DEFAULT_ACCOUNTS.accruedExpenses || "2600",
              loanDeductions,
              `Loan Deductions Payable — ${employeeName}`,
            ),
          );
        }

        if (otherDeductions > 0) {
          lines1.push(
            JournalService.createCreditLine(
              DEFAULT_ACCOUNTS.accruedExpenses || "2600",
              otherDeductions,
              `Other Deductions Payable — ${employeeName}`,
            ),
          );
        }

        if (netPay > 0) {
          lines1.push(
            JournalService.createCreditLine(
              DEFAULT_ACCOUNTS.accruedExpenses || "2600",
              netPay,
              `Net salary payable — ${employeeName}`,
            ),
          );
        }

        if (lines1.length >= 2) {
          await JournalService.createEntry(companyId, req.user._id, {
            date: new Date(),
            description: `Payroll Accrual — ${employeeName} — ${periodLabel}`,
            sourceType: "payroll_salary",
            sourceId: payroll._id,
            lines: lines1,
            isAutoGenerated: true,
          });
        }
      }

      // Journal 2: employer RSSB contribution (pension/maternity only — hazard in Journal 1)
      if (rssbEmployerPensionMaternity > 0) {
        await JournalService.createEntry(companyId, req.user._id, {
          date: new Date(),
          description: `Employer RSSB Contribution — ${employeeName} — ${periodLabel}`,
          sourceType: "payroll_employer",
          sourceId: payroll._id,
          lines: [
            JournalService.createDebitLine(
              DEFAULT_ACCOUNTS.rssbEmployerCost || "6150",
              rssbEmployerPensionMaternity,
              `Employer RSSB — ${employeeName}`,
            ),
            JournalService.createCreditLine(
              DEFAULT_ACCOUNTS.rssbPayable || "2240",
              rssbEmployerPensionMaternity,
              `Employer RSSB pension/maternity — ${employeeName}`,
            ),
          ],
          isAutoGenerated: true,
        });
      }
    } catch (journalError) {
      // Non-fatal — finalisation succeeds even if journal posting fails
      console.error(
        "[finalisePayroll] Journal entry creation failed:",
        journalError.message,
      );
    }

    res.json({
      success: true,
      data: payroll,
      message: "Payroll record finalised and journal entries posted",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get the signed-in employee's own payroll profile and finalized payslips
// @route   GET /api/payroll/me
// @access  Private, employee-owned data only
exports.getMyPayroll = async (req, res, next) => {
  try {
    const companyId = String(req.user.company?._id || req.user.companyId || "");
    const employee = await findSelfServiceEmployee(companyId, req.user.email);
    if (!employee) {
      return res.status(404).json({
        success: false,
        code: "PAYROLL_EMPLOYEE_LINK_NOT_FOUND",
        message: "No employee profile is linked to this login email. Ask payroll administration to link your employee profile.",
      });
    }

    const records = await dbClient().payroll.findMany({
      where: {
        companyId,
        recordStatus: { in: ["finalised", "paid"] },
        OR: [
          { employeeRefId: employee.id },
          { employee: { path: ["employeeId"], equals: employee.employeeId } },
        ],
      },
      orderBy: [{ payPeriodEnd: "desc" }, { createdAt: "desc" }],
      take: 120,
    });

    const currentSalary = employee.currentSalary && typeof employee.currentSalary === "object"
      ? employee.currentSalary
      : {};
    const payslips = records.map((record) => ({
      id: record.id,
      period: record.period || {},
      payPeriodStart: record.payPeriodStart,
      payPeriodEnd: record.payPeriodEnd,
      status: record.recordStatus,
      payment: {
        status: record.payment?.status || "pending",
        paymentDate: record.payment?.paymentDate || null,
        paymentMethod: record.payment?.paymentMethod || null,
        reference: record.payment?.reference || null,
      },
      earnings: {
        basicSalary: Number(record.salary?.basicSalary || 0),
        transportAllowance: Number(record.salary?.transportAllowance || 0),
        housingAllowance: Number(record.salary?.housingAllowance || 0),
        otherAllowances: Number(record.salary?.otherAllowances || 0),
        overtime: Number(record.salary?.overtime || 0),
        bonuses: Number(record.salary?.bonuses || 0),
        commissions: Number(record.salary?.commissions || 0),
        benefitsInKind: Number(record.salary?.benefitsInKind || 0),
        grossSalary: Number(record.salary?.grossSalary || 0),
        taxableBase: Number(record.salary?.taxableBase ?? record.salary?.grossRemuneration ?? record.salary?.grossSalary ?? 0),
      },
      deductions: {
        paye: Number(record.deductions?.paye || 0),
        rssbEmployeePension: Number(record.deductions?.rssbEmployeePension || 0),
        rssbEmployeeMaternity: Number(record.deductions?.rssbEmployeeMaternity || 0),
        healthInsurance: Number(record.deductions?.healthInsurance || 0),
        loanDeductions: Number(record.deductions?.loanDeductions || 0),
        otherDeductions: Number(record.deductions?.otherDeductions || 0),
        totalDeductions: Number(record.deductions?.totalDeductions || 0),
      },
      employerContributions: {
        rssbEmployerPension: Number(record.contributions?.rssbEmployerPension || 0),
        rssbEmployerMaternity: Number(record.contributions?.rssbEmployerMaternity || 0),
        occupationalHazard: Number(record.contributions?.occupationalHazard || 0),
      },
      netPay: Number(record.netPay || 0),
    }));

    return res.json({
      success: true,
      data: {
        employee: {
          employeeId: employee.employeeId,
          firstName: employee.firstName,
          lastName: employee.lastName,
          email: employee.email,
          phone: employee.phone,
          department: employee.department,
          position: employee.position,
          employmentType: employee.employmentType,
          hireDate: employee.hireDate,
          taxStatus: employee.taxStatus,
          nationalIdMasked: maskPersonalIdentifier(employee.nationalId),
          tinMasked: maskPersonalIdentifier(employee.tinNumber),
          rssbRegistrationMasked: maskPersonalIdentifier(employee.rssbRegistrationNumber),
          bankName: employee.bankName,
          bankAccountMasked: maskPersonalIdentifier(employee.bankAccount),
          currentPay: {
            currency: currentSalary.currency || "RWF",
            basicSalary: Number(currentSalary.basicSalary || 0),
            transportAllowance: Number(currentSalary.transportAllowance || 0),
            housingAllowance: Number(currentSalary.housingAllowance || 0),
            otherAllowances: Number(currentSalary.otherAllowances || 0),
          },
        },
        payslips,
        count: payslips.length,
      },
    });
  } catch (error) {
    return next(error);
  }
};

// @desc    Get payslip for payroll record
// @route   GET /api/payroll/:id/payslip
// @access  Private
exports.getPayslip = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const payroll = await Payroll.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!payroll) {
      return res
        .status(404)
        .json({ success: false, message: "Payroll record not found" });
    }

    const roles = await resolveUserRoles(req.user);
    const canReadAllPayroll = roles.some((role) => PermissionService.check(role, "payroll", "read"));
    if (!canReadAllPayroll) {
      const employee = await findSelfServiceEmployee(String(companyId), req.user.email);
      const ownsRecord = employee && (
        String(payroll.employee_id || "") === String(employee.id)
        || String(payroll.employee?.employeeId || "") === String(employee.employeeId)
      );
      if (!ownsRecord || !["finalised", "paid"].includes(payroll.record_status)) {
        return res.status(404).json({ success: false, message: "Payslip not found" });
      }
    }

    // Build payslip data
    const payslip = {
      employee: payroll.employee,
      period: payroll.period,
      earnings: {
        basicSalary: payroll.salary.basicSalary,
        transportAllowance: payroll.salary.transportAllowance,
        housingAllowance: payroll.salary.housingAllowance,
        otherAllowances: payroll.salary.otherAllowances,
        overtime: payroll.salary.overtime || payroll.additionalIncome?.overtime || 0,
        bonuses: payroll.salary.bonuses || payroll.additionalIncome?.bonuses || 0,
        commissions: payroll.salary.commissions || payroll.additionalIncome?.commissions || 0,
        benefitsInKind: payroll.salary.benefitsInKind || payroll.additionalIncome?.benefitsInKind || 0,
        grossSalary: payroll.salary.grossSalary,
      },
      deductions: {
        paye: payroll.deductions.paye,
        rssbPension: payroll.deductions.rssbEmployeePension,
        rssbMaternity: payroll.deductions.rssbEmployeeMaternity,
        healthInsurance: payroll.deductions.healthInsurance || 0,
        loanDeductions: payroll.deductions.loanDeductions || 0,
        otherDeductions: payroll.deductions.otherDeductions || 0,
        totalDeductions: payroll.deductions.totalDeductions,
      },
      netPay: payroll.netPay,
      employerContributions: payroll.contributions,
      status: payroll.record_status,
      payrollRunId: payroll.payroll_run_id,
    };

    res.json({
      success: true,
      data: payslip,
    });
  } catch (error) {
    next(error);
  }
};

exports.getPayrollAuditHistory = async (req, res, next) => {
  try {
    const companyId = String(req.user.company._id);
    const events = await dbClient().payrollAuditEvent.findMany({
      where: { companyId, entityType: "payroll", entityId: String(req.params.id) },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return res.json({ success: true, data: events });
  } catch (error) { return next(error); }
};

exports.getPayrollPeriodInputAuditHistory = async (req, res, next) => {
  try {
    const companyId = String(req.user.company._id);
    const input = await dbClient().payrollPeriodInput.findFirst({ where: { id: String(req.params.inputId), companyId } });
    if (!input) return res.status(404).json({ success: false, message: "Payroll period input not found" });
    const events = await dbClient().payrollAuditEvent.findMany({
      where: { companyId, entityType: "payroll_period_input", entityId: input.id },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return res.json({ success: true, data: events });
  } catch (error) { return next(error); }
};

// @desc    Backfill missing payroll journal entries for all finalised/paid records
// @route   POST /api/payroll/backfill-journals
// @access  Private (admin only)
exports.backfillPayrollJournals = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const dryRun = req.query.dry_run === "true";
    const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");

    function round2(n) {
      return Math.round((n || 0) * 100) / 100;
    }

    // Find all finalised or paid records for this company
    const payrollRecords = await Payroll.find({
      company: companyId,
      record_status: { $in: ["finalised", "paid"] },
    })
      .select(
        "employee employee_id salary deductions contributions netPay period record_status pay_period_end createdBy",
      )
      .lean();

    const results = {
      total: payrollRecords.length,
      alreadyHaveJournal: 0,
      backfilled: 0,
      skippedZero: 0,
      errors: [],
    };

    for (const payroll of payrollRecords) {
      try {
        // Skip if journal already exists
        const existingJournal = await JournalEntry.findOne({
          company: companyId,
          sourceType: "payroll_salary",
          sourceId: payroll._id,
          status: "posted",
        }).lean();

        if (existingJournal) {
          results.alreadyHaveJournal++;
          continue;
        }

        const grossSalary = round2(payroll.salary?.grossSalary);
        const paye = round2(payroll.deductions?.paye);
        const rssbEmployeePension = round2(payroll.deductions?.rssbEmployeePension);
        const rssbEmployeeMaternity = round2(payroll.deductions?.rssbEmployeeMaternity);
        const netPay = round2(payroll.netPay);
        const rssbEmployerPensionMaternity = round2(
          (payroll.contributions?.rssbEmployerPension || 0) +
            (payroll.contributions?.rssbEmployerMaternity || 0),
        );
        const occupationalHazard = round2(payroll.contributions?.occupationalHazard || 0);
        const rssbEmployer = rssbEmployerPensionMaternity + occupationalHazard;

        if (grossSalary <= 0) {
          results.skippedZero++;
          continue;
        }

        const employeeName =
          `${payroll.employee?.firstName || ""} ${payroll.employee?.lastName || ""}`.trim() ||
          "Unknown Employee";
        const periodLabel =
          `${payroll.period?.monthName || ""} ${payroll.period?.year || ""}`.trim();
        const entryDate = payroll.pay_period_end
          ? new Date(payroll.pay_period_end)
          : new Date();
        const allocation = await LaborAllocationService.allocateForEmployee(
          payroll.employee_id,
          grossSalary,
          payroll.period?.month,
          payroll.period?.year,
          companyId,
        );

        // Build Journal 1: payroll expense accrual
        const lines1 = [
          {
            accountCode: DEFAULT_ACCOUNTS.salariesWages || "5400",
            accountName: "Salaries & Wages",
            description: `Salary accrual — ${employeeName} — ${periodLabel} [backfill]`,
            debit: allocation.indirectAmount,
            credit: 0,
          },
        ];

        if (allocation.directAmount > 0) {
          lines1.unshift({
            accountCode: DEFAULT_ACCOUNTS.directLabor || "5300",
            accountName: "Direct Labor",
            description: `Direct labor accrual - ${employeeName} - ${periodLabel} [backfill]`,
            debit: allocation.directAmount,
            credit: 0,
          });
        }

        if (allocation.indirectAmount <= 0) {
          const indirectIndex = lines1.findIndex(
            (line) => line.accountCode === (DEFAULT_ACCOUNTS.salariesWages || "5400"),
          );
          if (indirectIndex >= 0) lines1.splice(indirectIndex, 1);
        }

        if (paye > 0) {
          lines1.push({
            accountCode: PAYROLL_ACCOUNTS.payePayable,
            accountName: "PAYE Tax Payable",
            description: `PAYE withheld — ${employeeName} [backfill]`,
            debit: 0,
            credit: paye,
          });
        }

        if (rssbEmployeePension > 0) {
          lines1.push({
            accountCode: PAYROLL_ACCOUNTS.employeePensionPayable,
            accountName: "RSSB Employee Pension Payable",
            description: `RSSB employee pension deduction — ${employeeName} [backfill]`,
            debit: 0,
            credit: rssbEmployeePension,
          });
        }
        if (rssbEmployeeMaternity > 0) lines1.push({
          accountCode: PAYROLL_ACCOUNTS.employeeMaternityPayable,
          accountName: "RSSB Employee Maternity Payable",
          description: `RSSB employee maternity deduction — ${employeeName} [backfill]`,
          debit: 0,
          credit: rssbEmployeeMaternity,
        });

        if (occupationalHazard > 0) {
          lines1.push({
            accountCode: DEFAULT_ACCOUNTS.rssbEmployerCost || "6150",
            accountName: "RSSB Employer Cost",
            description: `Occupational hazard — ${employeeName} [backfill]`,
            debit: occupationalHazard,
            credit: 0,
          });
          lines1.push({
            accountCode: PAYROLL_ACCOUNTS.occupationalHazardPayable,
            accountName: "Occupational Hazard Payable",
            description: `Occupational hazard payable — ${employeeName} [backfill]`,
            debit: 0,
            credit: occupationalHazard,
          });
        }

        const healthInsurance = payroll.deductions?.healthInsurance || 0;
        const loanDeductions = payroll.deductions?.loanDeductions || 0;
        const otherDeductions = payroll.deductions?.otherDeductions || 0;

        if (healthInsurance > 0) {
          lines1.push({
            accountCode: PAYROLL_ACCOUNTS.otherDeductionsPayable,
            accountName: "Other Payroll Deductions Payable",
            description: `Health Insurance Payable — ${employeeName} [backfill]`,
            debit: 0,
            credit: healthInsurance,
          });
        }

        if (loanDeductions > 0) {
          lines1.push({
            accountCode: PAYROLL_ACCOUNTS.otherDeductionsPayable,
            accountName: "Other Payroll Deductions Payable",
            description: `Loan Deductions Payable — ${employeeName} [backfill]`,
            debit: 0,
            credit: loanDeductions,
          });
        }

        if (otherDeductions > 0) {
          lines1.push({
            accountCode: PAYROLL_ACCOUNTS.otherDeductionsPayable,
            accountName: "Other Payroll Deductions Payable",
            description: `Other Deductions Payable — ${employeeName} [backfill]`,
            debit: 0,
            credit: otherDeductions,
          });
        }

        if (netPay > 0) {
          lines1.push({
            accountCode: PAYROLL_ACCOUNTS.salaryPayable,
            accountName: "Salaries Payable",
            description: `Net salary payable — ${employeeName} [backfill]`,
            debit: 0,
            credit: netPay,
          });
        }

        const totalDr1 = lines1.reduce((s, l) => s + (l.debit || 0), 0);
        const totalCr1 = lines1.reduce((s, l) => s + (l.credit || 0), 0);

        if (Math.abs(totalDr1 - totalCr1) > 0.02) {
          results.errors.push({
            payrollId: payroll._id,
            employee: employeeName,
            reason: `Journal 1 out of balance: DR ${totalDr1} ≠ CR ${totalCr1}`,
          });
          continue;
        }

        if (!dryRun) {
          await JournalService.createEntry(companyId, req.user._id, {
            date: entryDate,
            description: `Payroll Accrual — ${employeeName} — ${periodLabel} [backfill]`,
            sourceType: "payroll_salary",
            sourceId: payroll._id,
            sourceReference: periodLabel,
            lines: lines1,
            isAutoGenerated: true,
          });

          // Journal 2: employer RSSB contribution (pension/maternity only — hazard in Journal 1)
          if (rssbEmployerPensionMaternity > 0) {
            await JournalService.createEntry(companyId, req.user._id, {
              date: entryDate,
              description: `Employer RSSB Contribution — ${employeeName} — ${periodLabel} [backfill]`,
              sourceType: "payroll_employer",
              sourceId: payroll._id,
              sourceReference: periodLabel,
              lines: [
                {
                  accountCode: PAYROLL_ACCOUNTS.employerContributionExpense,
                  accountName: "RSSB Employer Cost",
                  description: `Employer RSSB — ${employeeName} [backfill]`,
                  debit: rssbEmployerPensionMaternity,
                  credit: 0,
                },
                ...(payroll.contributions?.rssbEmployerPension > 0 ? [{ accountCode: PAYROLL_ACCOUNTS.employerPensionPayable, accountName: "RSSB Employer Pension Payable", description: `Employer pension — ${employeeName} [backfill]`, debit: 0, credit: payroll.contributions.rssbEmployerPension }] : []),
                ...(payroll.contributions?.rssbEmployerMaternity > 0 ? [{ accountCode: PAYROLL_ACCOUNTS.employerMaternityPayable, accountName: "RSSB Employer Maternity Payable", description: `Employer maternity — ${employeeName} [backfill]`, debit: 0, credit: payroll.contributions.rssbEmployerMaternity }] : []),
              ],
              isAutoGenerated: true,
            });
          }
        }

        results.backfilled++;
      } catch (err) {
        results.errors.push({
          payrollId: payroll._id,
          employee:
            `${payroll.employee?.firstName || ""} ${payroll.employee?.lastName || ""}`.trim(),
          reason: err.message,
        });
      }
    }

    res.json({
      success: true,
      dry_run: dryRun,
      message: dryRun
        ? `Dry run complete: ${results.backfilled} journal entries would be created`
        : `Backfill complete: ${results.backfilled} journal entries created`,
      data: results,
    });
  } catch (error) {
    next(error);
  }
};

// Transactional implementations override the legacy handlers above. Status is
// only persisted after all required journal and bank writes succeed.
exports.finalisePayroll = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    const payroll = await runInPrismaTransaction(async () => {
      const record = await Payroll.findOne({ _id: req.params.id, company: companyId });
      if (!record) {
        const error = new Error("Payroll record not found");
        error.statusCode = 404;
        throw error;
      }
      if (record.record_status === "paid") throw new Error("Payroll record already paid");
      if (record.record_status !== "draft") throw Object.assign(new Error("Only draft payroll records can be finalised"), { statusCode: 409 });
      if (sameActor(record.createdBy, userId)) throw Object.assign(new Error("Payroll must be finalised by a user other than its preparer"), { statusCode: 403, code: "PAYROLL_APPROVAL_SEPARATION_REQUIRED" });
      const before = payrollSnapshot(record);
      if (!record.pay_period_start || !record.pay_period_end) {
        const year = Number(record.period?.year);
        const month = Number(record.period?.month);
        if (!year || !month) throw new Error("PAYROLL_PERIOD_REQUIRED");
        record.pay_period_start = new Date(year, month - 1, 1);
        record.pay_period_end = new Date(year, month, 0);
      }
      const posting = await postPayrollAccrualJournals(companyId, userId, record);
      if (posting.allocation) {
        record.laborAllocation = {
          directAmount: posting.allocation.directAmount,
          indirectAmount: posting.allocation.indirectAmount,
          directPercentage: posting.allocation.directPct,
          indirectPercentage: posting.allocation.indirectPct,
          source: posting.allocation.source,
          timesheetId: posting.allocation.timesheetId,
        };
      }
      record.record_status = "finalised";
      await record.save();
      await recordPayrollAudit({ companyId, userId, action: "payroll.record.finalised", entityType: "payroll", entityId: record._id, before, after: payrollSnapshot(record), req });
      return record;
    });
    return res.json({ success: true, data: payroll, message: "Payroll record finalised and journal entries posted" });
  } catch (error) {
    return next(error);
  }
};

exports.processPayment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    const { paymentMethod = "bank_transfer", reference, notes, bankAccountId } = req.body;
    const payroll = await runInPrismaTransaction(async () => {
      const record = await Payroll.findOne({ _id: req.params.id, company: companyId });
      if (!record) {
        const error = new Error("Payroll record not found");
        error.statusCode = 404;
        throw error;
      }
      if (record.payment?.status === "paid") throw new Error("Payment already processed");
      if (record.record_status !== "finalised") throw new Error("PAYROLL_NOT_FINALISED");
      if (record.payroll_run_id) throw Object.assign(new Error("This record belongs to a payroll run and must be paid through that run"), { statusCode: 409 });
      if (sameActor(record.createdBy, userId)) throw Object.assign(new Error("Payroll payment must be processed by a user other than its preparer"), { statusCode: 403, code: "PAYROLL_APPROVAL_SEPARATION_REQUIRED" });
      const before = payrollSnapshot(record);
      const netPay = round2(record.netPay);
      if (netPay <= 0) throw new Error("PAYROLL_NET_PAY_MUST_BE_POSITIVE");

      const usesBank = ["bank_transfer", "bank", "cheque", "mobile_money"].includes(paymentMethod);
      let bankAccount = null;
      if (usesBank) {
        if (!bankAccountId) throw new Error("PAYROLL_BANK_ACCOUNT_REQUIRED");
        const { BankAccount: BankAccountModel } = require("../models/BankAccount");
        bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, company: companyId, isActive: true });
        if (!bankAccount) throw new Error("PAYROLL_BANK_ACCOUNT_NOT_FOUND");
      }

      const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");
      const employeeName = `${record.employee?.firstName || ""} ${record.employee?.lastName || ""}`.trim() || "Employee";
      const periodLabel = `${record.period?.monthName || ""} ${record.period?.year || ""}`.trim();
      const cashAccountCode = bankAccount?.ledgerAccountId || (paymentMethod === "bank" ? DEFAULT_ACCOUNTS.cashAtBank : DEFAULT_ACCOUNTS.cashInHand);
      const journalEntry = await JournalService.createEntry(companyId, userId, {
        date: new Date(),
        description: `Payroll payment - ${employeeName} - ${periodLabel}`,
        sourceType: "payroll_payment",
        sourceId: String(record._id),
        sourceReference: reference || String(record._id),
        lines: [
          JournalService.createDebitLine(PAYROLL_ACCOUNTS.salaryPayable, netPay, `Clear accrued salary - ${employeeName}`),
          JournalService.createCreditLine(cashAccountCode, netPay, `Net salary paid - ${employeeName}`),
        ],
        isAutoGenerated: true,
        skipBankTransactions: true,
      });

      if (bankAccount) {
        await bankAccount.addTransaction({
          type: "withdrawal",
          amount: netPay,
          description: `Salary payment - ${employeeName} - ${periodLabel}`,
          date: new Date(),
          referenceNumber: reference || String(record._id),
          paymentMethod: paymentMethod === "bank" ? "bank_transfer" : paymentMethod,
          status: "completed",
          reference: record._id,
          referenceType: "Payment",
          createdBy: userId,
          notes: notes || "Payroll payment",
          journalEntryId: journalEntry._id,
        });
      }

      record.payment = { status: "paid", paymentDate: new Date(), paymentMethod, reference: reference || null, bankAccountId: bankAccount?._id || null, journalEntryId: journalEntry._id };
      await record.save();
      await recordPayrollAudit({ companyId, userId, action: "payroll.record.paid", entityType: "payroll", entityId: record._id, before, after: payrollSnapshot(record), req });
      return record;
    });
    return res.json({ success: true, data: payroll, message: "Payment processed successfully" });
  } catch (error) {
    return next(error);
  }
};
