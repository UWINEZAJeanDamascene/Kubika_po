const Payroll = require("../models/Payroll");
const Employee = require("../models/Employee");
const SalaryHistory = require("../models/SalaryHistory");
const User = require("../models/User");
const JournalService = require("../services/journalService");
const TaxAutomationService = require("../services/taxAutomationService");
const LaborAllocationService = require('../services/laborAllocationService');
const { parsePagination, paginationMeta } = require("../utils/pagination");
const JournalEntry = require("../models/JournalEntry");

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
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
        DEFAULT_ACCOUNTS.payePayable || "2230",
        paye,
        `PAYE withheld - ${employeeName}${suffix}`,
      ),
    );
  }

  if (rssbEmployee > 0) {
    lines.push(
      JournalService.createCreditLine(
        DEFAULT_ACCOUNTS.rssbPayable || "2240",
        rssbEmployee,
        `RSSB employee deduction - ${employeeName}${suffix}`,
      ),
    );
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
        DEFAULT_ACCOUNTS.employerContributionPayable || "2310",
        occupationalHazard,
        `Occupational hazard payable - ${employeeName}${suffix}`,
      ),
    );
  }

  if (healthInsurance > 0) {
    lines.push(
      JournalService.createCreditLine(
        DEFAULT_ACCOUNTS.accruedExpenses || "2600",
        healthInsurance,
        `Health Insurance Payable - ${employeeName}${suffix}`,
      ),
    );
  }

  if (loanDeductions > 0) {
    lines.push(
      JournalService.createCreditLine(
        DEFAULT_ACCOUNTS.accruedExpenses || "2600",
        loanDeductions,
        `Loan Deductions Payable - ${employeeName}${suffix}`,
      ),
    );
  }

  if (otherDeductions > 0) {
    lines.push(
      JournalService.createCreditLine(
        DEFAULT_ACCOUNTS.accruedExpenses || "2600",
        otherDeductions,
        `Other Deductions Payable - ${employeeName}${suffix}`,
      ),
    );
  }

  if (netPay > 0) {
    lines.push(
      JournalService.createCreditLine(
        DEFAULT_ACCOUNTS.accruedExpenses || "2600",
        netPay,
        `Net salary payable - ${employeeName}${suffix}`,
      ),
    );
  }

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
    await JournalService.createEntry(companyId, userId, {
      date: entryDate,
      description: `Employer RSSB Contribution - ${employeeName} - ${periodLabel}${suffix}`,
      sourceType: "payroll_employer",
      sourceId: payroll._id,
      sourceReference: periodLabel,
      lines: [
        JournalService.createDebitLine(
          DEFAULT_ACCOUNTS.rssbEmployerCost || "6150",
          rssbEmployerPensionMaternity,
          `Employer RSSB - ${employeeName}${suffix}`,
        ),
        JournalService.createCreditLine(
          DEFAULT_ACCOUNTS.rssbPayable || "2240",
          rssbEmployerPensionMaternity,
          `Employer RSSB pension/maternity - ${employeeName}${suffix}`,
        ),
      ],
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

    const { employee_id, employee, salary, salaryOverrides, period, notes } = req.body;

    let employeeSnapshot = employee;
    let salaryData = salary;
    let linkedEmployeeId = null;

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

      // Build from master
      const fromMaster = Payroll.fromEmployeeMaster(emp, effectiveSalary, period);
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
      }
    }

    // ── Path B: Legacy manual entry (backward compat) ────────────────
    if (!employeeSnapshot || !salaryData || !salaryData.basicSalary) {
      return res.status(400).json({
        success: false,
        message: "Employee information and salary are required",
      });
    }

    // Calculate payroll using Rwanda tax rules
    const calculated = Payroll.calculatePayroll(salaryData);

    const payroll = new Payroll({
      company: companyId,
      employee_id: linkedEmployeeId,
      employee: {
        ...employeeSnapshot,
        isActive: employeeSnapshot.isActive !== undefined ? employeeSnapshot.isActive : true,
      },
      salary: {
        basicSalary: salaryData.basicSalary,
        transportAllowance: salaryData.transportAllowance || 0,
        housingAllowance: salaryData.housingAllowance || 0,
        otherAllowances: salaryData.otherAllowances || 0,
        grossSalary: calculated.grossSalary,
      },
      deductions: {
        paye: calculated.deductions.paye,
        rssbEmployeePension: calculated.deductions.rssbEmployeePension,
        rssbEmployeeMaternity: calculated.deductions.rssbEmployeeMaternity,
        totalDeductions: calculated.deductions.totalDeductions,
      },
      netPay: calculated.netPay,
      contributions: {
        rssbEmployerPension: calculated.contributions.rssbEmployerPension,
        rssbEmployerMaternity: calculated.contributions.rssbEmployerMaternity,
        occupationalHazard: calculated.contributions.occupationalHazard,
      },
      period: {
        month: period.month,
        year: period.year,
        monthName: Payroll.getMonthName(period.month),
      },
      notes,
      createdBy: userId,
    });

    await payroll.save();

    res.status(201).json({
      success: true,
      data: payroll,
    });
  } catch (error) {
    next(error);
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

    // Check if already paid
    if (payroll.payment.status === "paid") {
      return res.status(400).json({
        success: false,
        message: "Cannot update a paid payroll record",
      });
    }

    const { employee, salary, period, notes } = req.body;

    // Recalculate if salary changed
    let calculated = null;
    if (salary) {
      calculated = Payroll.calculatePayroll(salary);
    }

    if (employee) {
      payroll.employee = { ...payroll.employee.toObject(), ...employee };
    }

    if (salary) {
      payroll.salary = {
        basicSalary: salary.basicSalary,
        transportAllowance: salary.transportAllowance || 0,
        housingAllowance: salary.housingAllowance || 0,
        otherAllowances: salary.otherAllowances || 0,
        grossSalary: calculated.grossSalary,
      };
      payroll.deductions = {
        paye: calculated.deductions.paye,
        rssbEmployeePension: calculated.deductions.rssbEmployeePension,
        rssbEmployeeMaternity: calculated.deductions.rssbEmployeeMaternity,
        totalDeductions: calculated.deductions.totalDeductions,
      };
      payroll.netPay = calculated.netPay;
      payroll.contributions = {
        rssbEmployerPension: calculated.contributions.rssbEmployerPension,
        rssbEmployerMaternity: calculated.contributions.rssbEmployerMaternity,
        occupationalHazard: calculated.contributions.occupationalHazard,
      };
    }

    if (period) {
      payroll.period = {
        month: period.month,
        year: period.year,
        monthName: Payroll.getMonthName(period.month),
      };
    }

    if (notes !== undefined) {
      payroll.notes = notes;
    }

    payroll.updatedAt = new Date();
    await payroll.save();

    res.json({
      success: true,
      data: payroll,
    });
  } catch (error) {
    next(error);
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

    await payroll.deleteOne();

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
    const { salary } = req.body;

    if (!salary || !salary.basicSalary) {
      return res.status(400).json({
        success: false,
        message: "Basic salary is required",
      });
    }

    const calculated = Payroll.calculatePayroll(salary);

    // Get tax brackets for display - Updated 2025
    const grossSalary =
      salary.basicSalary +
      (salary.transportAllowance || 0) +
      (salary.housingAllowance || 0) +
      (salary.otherAllowances || 0);
    const taxBrackets = [
      { range: "0 - 60,000", rate: "0%", tax: 0 },
      {
        range: "60,001 - 100,000",
        rate: "10%",
        tax: Math.max(0, (Math.min(grossSalary, 100000) - 60000) * 0.1),
      },
      {
        range: "100,001 - 200,000",
        rate: "20%",
        tax:
          grossSalary > 100000
            ? 4000 + Math.max(0, (Math.min(grossSalary, 200000) - 100000) * 0.2)
            : 0,
      },
      {
        range: "Above 200,000",
        rate: "30%",
        tax: grossSalary > 200000 ? 24000 + (grossSalary - 200000) * 0.3 : 0,
      },
    ];

    res.json({
      success: true,
      data: {
        ...calculated,
        taxBrackets: taxBrackets.map((t) => ({
          ...t,
          tax: Math.round(t.tax * 100) / 100,
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

    const createdPayroll = [];

    for (const emp of employees) {
      const calculated = Payroll.calculatePayroll(emp.salary);

      const payroll = new Payroll({
        company: companyId,
        employee: {
          ...emp.employee,
          isActive: true,
        },
        salary: {
          basicSalary: emp.salary.basicSalary,
          transportAllowance: emp.salary.transportAllowance || 0,
          housingAllowance: emp.salary.housingAllowance || 0,
          otherAllowances: emp.salary.otherAllowances || 0,
          grossSalary: calculated.grossSalary,
        },
        deductions: {
          paye: calculated.deductions.paye,
          rssbEmployeePension: calculated.deductions.rssbEmployeePension,
          rssbEmployeeMaternity: calculated.deductions.rssbEmployeeMaternity,
          totalDeductions: calculated.deductions.totalDeductions,
        },
        netPay: calculated.netPay,
        contributions: {
          rssbEmployerPension: calculated.contributions.rssbEmployerPension,
          rssbEmployerMaternity: calculated.contributions.rssbEmployerMaternity,
          occupationalHazard: calculated.contributions.occupationalHazard,
        },
        period: {
          month: period.month,
          year: period.year,
          monthName: Payroll.getMonthName(period.month),
        },
        notes,
        createdBy: userId,
      });

      await payroll.save();
      createdPayroll.push(payroll);
    }

    res.status(201).json({
      success: true,
      count: createdPayroll.length,
      data: createdPayroll,
    });
  } catch (error) {
    next(error);
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
        const fromMaster = Payroll.fromEmployeeMaster(emp, effectiveSalary, period);

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
        await payroll.save();
        createdRecords.push(payroll);
      } catch (err) {
        // Catch duplicate key (employee already has payroll for this period)
        if (err.code === 11000) {
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

    // Build payslip data
    const payslip = {
      employee: payroll.employee,
      period: payroll.period,
      earnings: {
        basicSalary: payroll.salary.basicSalary,
        transportAllowance: payroll.salary.transportAllowance,
        housingAllowance: payroll.salary.housingAllowance,
        otherAllowances: payroll.salary.otherAllowances,
        grossSalary: payroll.salary.grossSalary,
      },
      deductions: {
        paye: payroll.deductions.paye,
        rssbPension: payroll.deductions.rssbEmployeePension,
        rssbMaternity: payroll.deductions.rssbEmployeeMaternity,
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
        const rssbEmployee = round2(
          (payroll.deductions?.rssbEmployeePension || 0) +
            (payroll.deductions?.rssbEmployeeMaternity || 0),
        );
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
            accountCode:
              DEFAULT_ACCOUNTS.payePayable ||
              DEFAULT_ACCOUNTS.payePayable ||
              "2230",
            accountName: "PAYE Tax Payable",
            description: `PAYE withheld — ${employeeName} [backfill]`,
            debit: 0,
            credit: paye,
          });
        }

        if (rssbEmployee > 0) {
          lines1.push({
            accountCode:
              DEFAULT_ACCOUNTS.rssbPayable ||
              DEFAULT_ACCOUNTS.rssbPayable ||
              "2240",
            accountName: "RSSB Payable",
            description: `RSSB employee deduction — ${employeeName} [backfill]`,
            debit: 0,
            credit: rssbEmployee,
          });
        }

        if (occupationalHazard > 0) {
          lines1.push({
            accountCode: DEFAULT_ACCOUNTS.rssbEmployerCost || "6150",
            accountName: "RSSB Employer Cost",
            description: `Occupational hazard — ${employeeName} [backfill]`,
            debit: occupationalHazard,
            credit: 0,
          });
          lines1.push({
            accountCode: DEFAULT_ACCOUNTS.employerContributionPayable || "2310",
            accountName: "Employer Contribution Payable",
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
            accountCode: DEFAULT_ACCOUNTS.accruedExpenses || "2600",
            accountName: "Accrued Payroll",
            description: `Health Insurance Payable — ${employeeName} [backfill]`,
            debit: 0,
            credit: healthInsurance,
          });
        }

        if (loanDeductions > 0) {
          lines1.push({
            accountCode: DEFAULT_ACCOUNTS.accruedExpenses || "2600",
            accountName: "Accrued Payroll",
            description: `Loan Deductions Payable — ${employeeName} [backfill]`,
            debit: 0,
            credit: loanDeductions,
          });
        }

        if (otherDeductions > 0) {
          lines1.push({
            accountCode: DEFAULT_ACCOUNTS.accruedExpenses || "2600",
            accountName: "Accrued Payroll",
            description: `Other Deductions Payable — ${employeeName} [backfill]`,
            debit: 0,
            credit: otherDeductions,
          });
        }

        if (netPay > 0) {
          lines1.push({
            accountCode: DEFAULT_ACCOUNTS.accruedExpenses || "2600",
            accountName: "Accrued Payroll",
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
                  accountCode: DEFAULT_ACCOUNTS.rssbEmployerCost || "6150",
                  accountName: "RSSB Employer Cost",
                  description: `Employer RSSB — ${employeeName} [backfill]`,
                  debit: rssbEmployerPensionMaternity,
                  credit: 0,
                },
                {
                  accountCode: DEFAULT_ACCOUNTS.rssbPayable || "2240",
                  accountName: "RSSB Payable",
                  description: `Employer RSSB pension/maternity — ${employeeName} [backfill]`,
                  debit: 0,
                  credit: rssbEmployerPensionMaternity,
                },
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
