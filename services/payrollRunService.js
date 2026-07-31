const mongoose = require("mongoose");
const PayrollRun = require("../models/PayrollRun");
const Payroll = require("../models/Payroll");
const Employee = require("../models/Employee");
const JournalEntry = require("../models/JournalEntry");
const ChartOfAccount = require("../models/ChartOfAccount");
const { BankAccount } = require("../models/BankAccount");
const { nextSequence } = require("./sequenceService");
const PeriodService = require("./periodService");
const LaborAllocationService = require("./laborAllocationService");

const { applyJournalLinesToAccountBalances } = require('../utils/accountBalanceSync');

class PayrollRunService {
  static async voidJournalEntriesForRepost(companyId, sourceType, sourceId, voidedSourceType, entryIds = null) {
    const originalSourceId = sourceId.toString();
    const query = {
      company: companyId,
      sourceType,
      sourceId: originalSourceId,
    };

    if (entryIds?.length) {
      query._id = { $in: entryIds };
    }

    const entries = await JournalEntry.find(query);

    for (const entry of entries) {
      if (entry.status === 'posted' && Array.isArray(entry.lines)) {
        await applyJournalLinesToAccountBalances(companyId, entry.lines, -1);
      }

      await JournalEntry.updateOne(
        { _id: entry._id, sourceType },
        {
          $set: {
            sourceType: voidedSourceType,
            sourceId: `${originalSourceId}:voided:${entry._id.toString()}`,
            sourceReference: entry.sourceReference || originalSourceId,
            status: "voided",
            reversed: true,
          },
        },
      );
    }
  }

  static roundMoney(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  static sumRunComponents(payrollRun) {
    const lines = payrollRun.lines || [];
    const totals = lines.reduce(
      (acc, line) => {
        acc.gross += line.gross_salary || 0;
        acc.paye += line.tax_deduction || 0;
        acc.rssbEmployeePension += line.rssb_employee_pension || 0;
        acc.rssbEmployeeMaternity += line.rssb_employee_maternity || 0;
        acc.rssbEmployerPension += line.rssb_employer_pension || 0;
        acc.rssbEmployerMaternity += line.rssb_employer_maternity || 0;
        acc.occupationalHazard += line.occupational_hazard || 0;
        acc.healthInsurance += line.health_insurance || 0;
        acc.loanDeductions += line.loan_deductions || 0;
        acc.otherDeductions += line.other_deductions || 0;
        acc.net += line.net_pay || 0;
        acc.direct += line.direct_amount || 0;
        acc.indirect += line.indirect_amount || 0;
        return acc;
      },
      {
        gross: 0,
        paye: 0,
        rssbEmployeePension: 0,
        rssbEmployeeMaternity: 0,
        rssbEmployerPension: 0,
        rssbEmployerMaternity: 0,
        occupationalHazard: 0,
        healthInsurance: 0,
        loanDeductions: 0,
        otherDeductions: 0,
        net: 0,
        direct: 0,
        indirect: 0,
      },
    );

    totals.gross = totals.gross || payrollRun.total_gross || 0;
    totals.paye = totals.paye || payrollRun.total_tax || 0;
    totals.net = totals.net || payrollRun.total_net || 0;
    totals.employeeRssb =
      totals.rssbEmployeePension + totals.rssbEmployeeMaternity;
    totals.employerRssb =
      totals.rssbEmployerPension +
      totals.rssbEmployerMaternity +
      totals.occupationalHazard;
    totals.statutoryPayable =
      totals.paye + totals.employeeRssb + totals.employerRssb;
    totals.employeeDeductions =
      totals.paye +
      totals.employeeRssb +
      totals.healthInsurance +
      totals.loanDeductions +
      totals.otherDeductions;
    totals.employerCost = totals.gross + totals.employerRssb;

    Object.keys(totals).forEach((key) => {
      totals[key] = PayrollRunService.roundMoney(totals[key]);
    });

    return totals;
  }

  static accountLine(accountCode, accountName, description, debit, credit) {
    return {
      accountCode,
      accountName,
      description,
      debit: PayrollRunService.roundMoney(debit),
      credit: PayrollRunService.roundMoney(credit),
    };
  }

  static buildPayrollAccrualLines(payrollRun, accounts, useDetailedPayables = true) {
    const totals = PayrollRunService.sumRunComponents(payrollRun);
    const periodLabel = `${payrollRun.pay_period_start.toISOString().split("T")[0]} to ${payrollRun.pay_period_end.toISOString().split("T")[0]}`;
    const salaryExpenseCode = accounts.salaryAccount?.code || "5400";
    const salaryExpenseName = accounts.salaryAccount?.name || "Salaries & Wages";
    const payeCode = useDetailedPayables
      ? "2310"
      : accounts.taxPayableAccount?.code || "2230";
    const payeName = useDetailedPayables
      ? "PAYE Payable - RRA"
      : accounts.taxPayableAccount?.name || "PAYE Tax Payable";
    const rssbCode = accounts.otherDedAccount?.code || "2240";
    const rssbName = accounts.otherDedAccount?.name || "RSSB Payable";
    const lines = [];

    if (totals.direct > 0) {
      lines.push(
        PayrollRunService.accountLine(
          "5300",
          "Direct Labor",
          `Direct labor accrual ${periodLabel}`,
          totals.direct,
          0,
        ),
      );
    }

    const indirectGross =
      totals.direct > 0 || totals.indirect > 0 ? totals.indirect : totals.gross;
    if (indirectGross > 0) {
      lines.push(
        PayrollRunService.accountLine(
          salaryExpenseCode,
          salaryExpenseName,
          `Salary expense accrual ${periodLabel}`,
          indirectGross,
          0,
        ),
      );
    }

    const employerExpense =
      totals.rssbEmployerPension +
      totals.rssbEmployerMaternity +
      totals.occupationalHazard;
    if (employerExpense > 0) {
      lines.push(
        PayrollRunService.accountLine(
          "6150",
          "RSSB Employer Cost",
          `Employer RSSB charges ${periodLabel}`,
          employerExpense,
          0,
        ),
      );
    }

    if (totals.paye > 0) {
      lines.push(
        PayrollRunService.accountLine(
          payeCode,
          payeName,
          "PAYE withheld",
          0,
          totals.paye,
        ),
      );
    }

    const rssbPayableLines = useDetailedPayables
      ? [
          ["2320", "RSSB Employee Pension Payable - 6%", totals.rssbEmployeePension],
          ["2321", "RSSB Employee Maternity Payable - 0.3%", totals.rssbEmployeeMaternity],
          ["2330", "RSSB Employer Pension Payable - 6%", totals.rssbEmployerPension],
          ["2331", "RSSB Employer Maternity Payable - 0.3%", totals.rssbEmployerMaternity],
          ["2332", "Occupational Hazard Payable", totals.occupationalHazard],
        ]
      : [[rssbCode, rssbName, totals.employeeRssb + employerExpense]];

    rssbPayableLines.forEach(([code, name, amount]) => {
      if (amount > 0) {
        lines.push(
          PayrollRunService.accountLine(
            code,
            name,
            name,
            0,
            amount,
          ),
        );
      }
    });

    const otherEmployeeDeductions =
      totals.healthInsurance + totals.loanDeductions + totals.otherDeductions;
    if (otherEmployeeDeductions > 0) {
      lines.push(
        PayrollRunService.accountLine(
          "2600",
          "Accrued Expenses",
          "Other employee deductions payable",
          0,
          otherEmployeeDeductions,
        ),
      );
    }

    if (totals.net > 0) {
      lines.push(
        PayrollRunService.accountLine(
          "2300",
          "Salaries Payable",
          "Net salaries payable",
          0,
          totals.net,
        ),
      );
    }

    return { lines, totals };
  }

  static buildNetPayLines(payrollRun, bankAccount) {
    const periodLabel = `${payrollRun.pay_period_start.toISOString().split("T")[0]} to ${payrollRun.pay_period_end.toISOString().split("T")[0]}`;
    const amount = PayrollRunService.roundMoney(payrollRun.total_net);
    return [
      PayrollRunService.accountLine(
        "2300",
        "Salaries Payable",
        `Clear net salaries payable ${periodLabel}`,
        amount,
        0,
      ),
      PayrollRunService.accountLine(
        bankAccount?.ledgerAccountId || "1100",
        bankAccount?.name || "Cash at Bank",
        "Net salary payments disbursed",
        0,
        amount,
      ),
    ];
  }

  // ── PREVIEW JOURNAL ENTRY ─────────────────────────────────────────────
  static async preview(companyId, data) {
    const payPeriodStart = data.pay_period_start;
    const payPeriodEnd = new Date(payPeriodStart.getFullYear(), payPeriodStart.getMonth() + 1, 0);
    const payrollRecords = await Payroll.find({
      company: companyId,
      record_status: "finalised",
      pay_period_start: { gte: payPeriodStart, lte: payPeriodEnd },
    });

    if (payrollRecords.length === 0) {
      throw new Error("NO_FINALISED_RECORDS");
    }

    const salaryAccount = await ChartOfAccount.findById(data.salary_account_id);
    const taxPayableAccount = await ChartOfAccount.findById(
      data.tax_payable_account_id,
    );
    const bankAccount = await BankAccount.findById(data.bank_account_id);
    const otherDedAccount = data.other_deductions_account_id
      ? await ChartOfAccount.findById(data.other_deductions_account_id)
      : null;

    const previewRun = {
      pay_period_start: data.pay_period_start,
      pay_period_end: data.pay_period_end,
      total_gross: payrollRecords.reduce((s, p) => s + (p.salary?.grossSalary || 0), 0),
      total_tax: payrollRecords.reduce((s, p) => s + (p.deductions?.paye || 0), 0),
      total_net: payrollRecords.reduce((s, p) => s + (p.netPay || 0), 0),
      lines: payrollRecords.map((p) => ({
        gross_salary: p.salary?.grossSalary || 0,
        tax_deduction: p.deductions?.paye || 0,
        rssb_employee_pension: p.deductions?.rssbEmployeePension || 0,
        rssb_employee_maternity: p.deductions?.rssbEmployeeMaternity || 0,
        rssb_employer_pension: p.contributions?.rssbEmployerPension || 0,
        rssb_employer_maternity: p.contributions?.rssbEmployerMaternity || 0,
        occupational_hazard: p.contributions?.occupationalHazard || 0,
        health_insurance: p.deductions?.healthInsurance || 0,
        loan_deductions: p.deductions?.loanDeductions || 0,
        other_deductions: p.deductions?.otherDeductions || 0,
        net_pay: p.netPay || 0,
      })),
    };
    const { lines: accrualLines, totals } =
      PayrollRunService.buildPayrollAccrualLines(
        previewRun,
        { salaryAccount, taxPayableAccount, otherDedAccount },
        true,
      );
    const netPayLines = PayrollRunService.buildNetPayLines(previewRun, bankAccount);

    return {
      employeeCount: payrollRecords.length,
      totals: {
        gross: totals.gross,
        tax: totals.paye,
        rssbEmployee: totals.employeeRssb,
        rssbEmployer: totals.employerRssb,
        statutoryPayable: totals.statutoryPayable,
        net: totals.net,
      },
      workflow: [
        {
          step: "accrual",
          title: "Entry 1 - Recognise payroll expense and liabilities",
          lines: accrualLines,
        },
        {
          step: "net_pay",
          title: "Entry 2 - Disburse net salary via bank",
          lines: netPayLines,
        },
      ],
      lines: accrualLines,
      isBalanced:
        Math.abs(
          accrualLines.reduce((s, l) => s + l.debit, 0) -
            accrualLines.reduce((s, l) => s + l.credit, 0),
        ) < 0.01,
    };
  }

  // ── GET AVAILABLE PERIODS (months with finalised, unprocessed records) ──
  /**
   * Returns an array of { month, year, count, totalGross, totalNet } for every
   * calendar month that has at least one finalised, unassigned Payroll record.
   * Used by the UI to populate the month/year picker before creating a run.
   */
static async getAvailablePeriods(companyId) {
    const records = await Payroll.find({
      company: companyId,
      record_status: "finalised",
      payroll_run_id: null,
    });

    const periodMap = new Map();
    for (const p of records) {
      const month = p.period?.month;
      const year = p.period?.year;
      if (!month || !year) continue;
      const key = `${year}-${String(month).padStart(2, "0")}`;
      const existing = periodMap.get(key);
      const gross = p.salary?.grossSalary || 0;
      const net = p.netPay || 0;
      if (existing) {
        existing.count += 1;
        existing.totalGross += gross;
        existing.totalNet += net;
      } else {
        periodMap.set(key, { month, year, count: 1, totalGross: gross, totalNet: net });
      }
    }

    return Array.from(periodMap.values()).sort((a, b) => b.year - a.year || b.month - a.month);
  }

  // ── CREATE FROM FINALISED RECORDS ─────────────────────────────────────
  static async createFromRecords(companyId, data, userId) {
    // ── Determine which period to process ────────────────────────────────────
    // If the caller supplies explicit period_month/period_year, use those.
    // Otherwise fall back to deriving from pay_period_start (legacy path).
    let filterMonth, filterYear;

    if (data.period_month && data.period_year) {
      filterMonth = parseInt(data.period_month, 10);
      filterYear = parseInt(data.period_year, 10);
    } else if (data.pay_period_start) {
      filterMonth = data.pay_period_start.getMonth() + 1;
      filterYear = data.pay_period_start.getFullYear();
    } else {
      throw new Error(
        "PERIOD_REQUIRED: Please provide period_month and period_year.",
      );
    }

    // Find runs that are already posted — their records should be blocked
    const postedRunIds = await PayrollRun.find({
      company: companyId,
      status: "posted",
    }).select("_id").lean();
    const blockedIds = postedRunIds.map((r) => r._id.toString());

    const payPeriodStart = new Date(filterYear, filterMonth - 1, 1);
    const payPeriodEnd = new Date(filterYear, filterMonth, 0);

    const payrollRecords = await Payroll.find({
      company: companyId,
      record_status: "finalised",
      pay_period_start: { gte: payPeriodStart, lte: payPeriodEnd },
      $or: [
        { payroll_run_id: null },
        { payroll_run_id: { $exists: false } },
        { payroll_run_id: { $nin: blockedIds } },
      ],
    });

    if (payrollRecords.length === 0) {
      const err = new Error(
        `NO_FINALISED_RECORDS: No finalised payroll records found for ${filterMonth}/${filterYear}. ` +
          `Please go to Payroll, create and finalise employee records for that month first.`,
      );
      err.statusCode = 422;
      throw err;
    }

    // ── Validate labor types for direct/mixed employees ─────────────────────
    const employeeIds = payrollRecords.map((p) => p.employee_id);
    const laborValidation = await LaborAllocationService.validateLaborTypes(companyId, employeeIds);
    if (!laborValidation.valid) {
      const err = new Error(
        `LABOR_TYPE_MISSING: ${laborValidation.errors.join('; ')}`
      );
      err.statusCode = 422;
      throw err;
    }

    // ── Flag timesheet variance (>30 points from default) ───────────────────
    const flagged = await LaborAllocationService.flagTimesheetVariance(
      companyId, employeeIds, filterMonth, filterYear
    );
    const warnings = flagged.map(
      (f) => `Timesheet variance: ${f.name} — default ${f.defaultPct}% vs timesheet ${f.timesheetPct}% (diff ${f.difference})`
    );

    let totalGross = 0;
    let totalTax = 0;
    let totalRssbEmployee = 0;
    let totalRssbEmployer = 0;
    let totalNet = 0;
    let totalDirectAmount = 0;
    let totalIndirectAmount = 0;
    let totalDirectEmployerRSSB = 0;
    let totalIndirectEmployerRSSB = 0;
    const lines = [];

    for (const p of payrollRecords) {
      totalGross += p.salary?.grossSalary || 0;
      totalTax += p.deductions?.paye || 0;
      const rssbEmployeePension = p.deductions?.rssbEmployeePension || 0;
      const rssbEmployeeMaternity = p.deductions?.rssbEmployeeMaternity || 0;
      const rssbEmployerPension = p.contributions?.rssbEmployerPension || 0;
      const rssbEmployerMaternity = p.contributions?.rssbEmployerMaternity || 0;
      const occupationalHazard = p.contributions?.occupationalHazard || 0;
      const occupationalHazardRate = p.contributions?.occupationalHazardRate || 2.0;
      totalRssbEmployee += rssbEmployeePension + rssbEmployeeMaternity;
      totalRssbEmployer += rssbEmployerPension + rssbEmployerMaternity + occupationalHazard;
      totalNet += p.netPay || 0;

      // ── Labor Cost Allocation ───────────────────────────────────────────
      const grossSalary = p.salary?.grossSalary || 0;
      const allocation = await LaborAllocationService.allocateForEmployee(
        p.employee_id,
        grossSalary,
        filterMonth,
        filterYear,
        companyId
      );

      totalDirectAmount += allocation.directAmount;
      totalIndirectAmount += allocation.indirectAmount;

      // Split employer RSSB proportionally
      const totalEmpRSSB = rssbEmployerPension + rssbEmployerMaternity + occupationalHazard;
      if (totalEmpRSSB > 0 && grossSalary > 0) {
        const directRatio = allocation.directAmount / grossSalary;
        const directRSSB = Math.round(totalEmpRSSB * directRatio * 100) / 100;
        totalDirectEmployerRSSB += directRSSB;
        totalIndirectEmployerRSSB += Math.round((totalEmpRSSB - directRSSB) * 100) / 100;
      } else if (totalEmpRSSB > 0) {
        totalIndirectEmployerRSSB += totalEmpRSSB;
      }

      // Update the individual Payroll record with allocation
      await Payroll.findByIdAndUpdate(p._id, {
        laborAllocation: {
          directAmount: allocation.directAmount,
          indirectAmount: allocation.indirectAmount,
          directPercentage: allocation.directPct,
          indirectPercentage: allocation.indirectPct,
          source: allocation.source,
          timesheetId: allocation.timesheetId
        }
      });

      lines.push({
        employee_name: `${p.employee?.firstName} ${p.employee?.lastName}`,
        employee_id: p.employee?.employeeId || "N/A",
        employee_ref_id: p.employee_id || null,
        employee_department: p.employee?.department || "Unassigned",
        // Income components
        basic_salary: p.salary?.basicSalary || 0,
        transport_allowance: p.salary?.transportAllowance || 0,
        housing_allowance: p.salary?.housingAllowance || 0,
        other_allowances: p.salary?.otherAllowances || 0,
        overtime: p.additionalIncome?.overtime || 0,
        bonuses: p.additionalIncome?.bonuses || 0,
        commissions: p.additionalIncome?.commissions || 0,
        benefits_in_kind: p.additionalIncome?.benefitsInKind || 0,
        gross_salary: p.salary?.grossSalary || 0,
        // PAYE
        tax_deduction: p.deductions?.paye || 0,
        // RSSB Employee deductions
        rssb_employee_pension: rssbEmployeePension,
        rssb_employee_maternity: rssbEmployeeMaternity,
        rssb_employee_total: rssbEmployeePension + rssbEmployeeMaternity,
        // RSSB Employer contributions
        rssb_employer_pension: rssbEmployerPension,
        rssb_employer_maternity: rssbEmployerMaternity,
        occupational_hazard: occupationalHazard,
        occupational_hazard_rate: occupationalHazardRate,
        rssb_employer_total: rssbEmployerPension + rssbEmployerMaternity + occupationalHazard,
        // Other deductions
        health_insurance: p.deductions?.healthInsurance || 0,
        loan_deductions: p.deductions?.loanDeductions || 0,
        other_deductions: p.deductions?.otherDeductions || 0,
        total_deductions: p.deductions?.totalDeductions || 0,
        net_pay: p.netPay || 0,
        payroll_id: p._id,
        // Labor cost allocation fields
        labor_type: allocation.laborType,
        direct_amount: allocation.directAmount,
        indirect_amount: allocation.indirectAmount,
        direct_percentage: allocation.directPct,
        indirect_percentage: allocation.indirectPct,
        allocation_source: allocation.source,
        timesheet_id: allocation.timesheetId
      });
    }

    // Include all deductions in net calculation
    const totalHealthInsurance = payrollRecords.reduce((s, p) => s + (p.deductions?.healthInsurance || 0), 0);
    const totalLoanDeductions = payrollRecords.reduce((s, p) => s + (p.deductions?.loanDeductions || 0), 0);
    const totalOtherDeductions = payrollRecords.reduce((s, p) => s + (p.deductions?.otherDeductions || 0), 0);
    const totalEmployeeDeductions = totalTax + totalRssbEmployee + totalHealthInsurance + totalLoanDeductions + totalOtherDeductions;
    const expectedNet = totalGross - totalEmployeeDeductions;
    if (Math.abs(expectedNet - totalNet) > 0.01) {
      throw new Error("PAYROLL_TOTALS_MISMATCH");
    }

    await ChartOfAccount.findOne({
      _id: data.salary_account_id,
      company: companyId,
    });
    await ChartOfAccount.findOne({
      _id: data.tax_payable_account_id,
      company: companyId,
    });
    await BankAccount.findOne({
      _id: data.bank_account_id,
      company: companyId,
    });

    const refNo = await nextSequence(companyId, "PYRL");

    const payrollRun = await PayrollRun.create({
      company: companyId,
      reference_no: refNo,
      pay_period_start: data.pay_period_start,
      pay_period_end: data.pay_period_end,
      payment_date: data.payment_date,
      status: "draft",
      total_gross: totalGross,
      total_tax: totalTax,
      total_other_deductions: totalRssbEmployee,
      total_net: totalNet,
      bank_account_id: data.bank_account_id,
      salary_account_id: data.salary_account_id,
      tax_payable_account_id: data.tax_payable_account_id,
      other_deductions_account_id: data.other_deductions_account_id,
      lines,
      employee_count: payrollRecords.length,
      notes: data.notes || null,
      warnings,
      posted_by: null,
    });

    await Payroll.updateMany(
      { _id: { $in: payrollRecords.map((p) => p._id) } },
      { payroll_run_id: payrollRun._id },
    );

    return payrollRun;
  }

  // ── CREATE DRAFT PAYROLL RUN ─────────────────────────────────────────────
  static async create(companyId, data, userId) {
    const salaryAccount = await ChartOfAccount.findOne({
      _id: data.salary_account_id,
      company: companyId,
    });
    if (!salaryAccount) {
      const error = new Error("NOT_FOUND");
      error.statusCode = 404;
      throw error;
    }

    const taxPayableAccount = await ChartOfAccount.findOne({
      _id: data.tax_payable_account_id,
      company: companyId,
    });
    if (!taxPayableAccount) {
      const error = new Error("NOT_FOUND");
      error.statusCode = 404;
      throw error;
    }

    if (data.total_other_deductions > 0 && !data.other_deductions_account_id) {
      throw new Error("OTHER_DEDUCTIONS_ACCOUNT_REQUIRED");
    }

    if (data.other_deductions_account_id) {
      const otherDedAccount = await ChartOfAccount.findOne({
        _id: data.other_deductions_account_id,
        company: companyId,
      });
      if (!otherDedAccount) {
        const error = new Error("NOT_FOUND");
        error.statusCode = 404;
        throw error;
      }
    }

    const bankAccount = await BankAccount.findOne({
      _id: data.bank_account_id,
      company: companyId,
    });
    if (!bankAccount) {
      const error = new Error("NOT_FOUND");
      error.statusCode = 404;
      throw error;
    }

    const expectedNet =
      data.total_gross - data.total_tax - data.total_other_deductions;
    if (Math.abs(expectedNet - data.total_net) > 0.01) {
      throw new Error("PAYROLL_TOTALS_MISMATCH");
    }

    const lineGross = data.lines.reduce(
      (sum, l) => sum + (l.gross_salary || 0),
      0,
    );
    const lineTax = data.lines.reduce(
      (sum, l) => sum + (l.tax_deduction || 0),
      0,
    );
    const lineOther = data.lines.reduce(
      (sum, l) => sum + (l.other_deductions || 0),
      0,
    );
    const lineNet = data.lines.reduce((sum, l) => sum + (l.net_pay || 0), 0);

    if (Math.abs(lineGross - data.total_gross) > 0.01)
      throw new Error("PAYROLL_LINE_GROSS_MISMATCH");
    if (Math.abs(lineTax - data.total_tax) > 0.01)
      throw new Error("PAYROLL_LINE_TAX_MISMATCH");
    if (Math.abs(lineNet - data.total_net) > 0.01)
      throw new Error("PAYROLL_LINE_NET_MISMATCH");

    const refNo = await nextSequence(companyId, "PYRL");

    const payrollRun = await PayrollRun.create({
      company: companyId,
      reference_no: refNo,
      pay_period_start: data.pay_period_start,
      pay_period_end: data.pay_period_end,
      payment_date: data.payment_date,
      status: "draft",
      total_gross: data.total_gross,
      total_tax: data.total_tax,
      total_other_deductions: data.total_other_deductions || 0,
      total_net: data.total_net,
      bank_account_id: data.bank_account_id,
      salary_account_id: data.salary_account_id,
      tax_payable_account_id: data.tax_payable_account_id,
      other_deductions_account_id: data.other_deductions_account_id || null,
      lines: data.lines,
      notes: data.notes || null,
      posted_by: null,
    });

    return payrollRun;
  }

  // ── POST PAYROLL RUN ────────────────────────────────────────────────────
  static async post(companyId, runId, userId) {
    const payrollRun = await PayrollRun.findOne({
      _id: runId,
      company: companyId,
    });

    if (!payrollRun) {
      const error = new Error("NOT_FOUND");
      error.statusCode = 404;
      throw error;
    }

    if (payrollRun.status !== "draft") {
      throw new Error("PAYROLL_ALREADY_POSTED");
    }

    const salaryAccount = await ChartOfAccount.findOne({
      _id: payrollRun.salary_account_id,
      company: companyId,
    });
    if (!salaryAccount) {
      const error = new Error("NOT_FOUND");
      error.statusCode = 404;
      throw error;
    }

    const taxPayableAccount = await ChartOfAccount.findOne({
      _id: payrollRun.tax_payable_account_id,
      company: companyId,
    });
    if (!taxPayableAccount) {
      const error = new Error("NOT_FOUND");
      error.statusCode = 404;
      throw error;
    }

    const bankAccount = await BankAccount.findOne({
      _id: payrollRun.bank_account_id,
      company: companyId,
    });
    if (!bankAccount) {
      const error = new Error("NOT_FOUND");
      error.statusCode = 404;
      throw error;
    }

    let otherDedAccount = null;
    if (
      payrollRun.total_other_deductions > 0 &&
      payrollRun.other_deductions_account_id
    ) {
      otherDedAccount = await ChartOfAccount.findOne({
        _id: payrollRun.other_deductions_account_id,
        company: companyId,
      });
    }

    const periodId = await PeriodService.getOpenPeriodId(
      companyId,
      payrollRun.payment_date,
    );

    try {

      // Calculate total RSSB employer contributions from all employee lines
      const employerContributions = payrollRun.lines.reduce((sum, l) => {
        return sum + (l.rssb_employer_total || 0);
      }, 0);

      // ── Determine whether the individual payroll records were already accrued ───
      // If finalisePayroll() was called for each record before creating this run,
      // each record already has:
      //   DR Salaries / CR PAYE / CR RSSB / CR Accrued Payroll (2600)
      //   DR RSSB Employer Cost / CR RSSB Payable
      //
      // In that case the PayrollRun only needs to post the CASH DISBURSEMENT:
      //   DR Accrued Payroll (2600)  [net_pay]
      //   CR Bank                    [net_pay]
      //
      // If the records were NOT individually accrued (legacy / shortcut path),
      // fall back to the full payroll journal so the GL is always complete.
      const JournalEntry = require("../models/JournalEntry");
      const payrollIds = payrollRun.lines
        .map((l) => l.payroll_id)
        .filter(Boolean);

      let accrualCount = 0;
      if (payrollIds.length > 0) {
        accrualCount = await JournalEntry.countDocuments({
          company: companyId,
          sourceType: "payroll_salary",
          sourceId: { $in: payrollIds },
          status: "posted",
        });
      }

      const accrualAlreadyPosted = accrualCount > 0;

      let lines = [];

      if (accrualAlreadyPosted) {
        // ── Path A: accruals exist → only post the cash disbursement ───────────
        // DR Accrued Payroll (2600) / CR Bank
        if (payrollRun.total_net > 0) {
          lines.push({
            accountCode: "2600",
            accountName: "Accrued Payroll",
            description: `Clear accrued salaries ${payrollRun.pay_period_start.toISOString().split("T")[0]} – ${payrollRun.pay_period_end.toISOString().split("T")[0]}`,
            debit: payrollRun.total_net,
            credit: 0,
          });
          lines.push({
            accountCode: bankAccount.ledgerAccountId || "1100",
            accountName: bankAccount.name || "Cash at Bank",
            description: "Net salary payments disbursed",
            debit: 0,
            credit: payrollRun.total_net,
          });
        }
      } else {
        // ── Path B: no prior accruals → post the full payroll journal ──────────
        // DR 5300 Direct Labor / DR 5400 Salaries & Wages / DR 6150 RSSB / CR PAYE / CR RSSB / CR Bank
        // Calculate totals from line allocations
        const runDirect = payrollRun.lines.reduce((s, l) => s + (l.direct_amount || 0), 0);
        const runIndirect = payrollRun.lines.reduce((s, l) => s + (l.indirect_amount || 0), 0);

        // DR 5300 Direct Labor (production/warehouse workers)
        if (runDirect > 0) {
          lines.push({
            accountCode: "5300",
            accountName: "Direct Labor",
            description: `Direct labor cost ${payrollRun.pay_period_start.toISOString().split("T")[0]} to ${payrollRun.pay_period_end.toISOString().split("T")[0]}`,
            debit: runDirect,
            credit: 0,
          });
        }

        // DR 5400 Salaries & Wages (admin, sales, indirect labor)
        if (runIndirect > 0) {
          lines.push({
            accountCode: salaryAccount.code,
            accountName: salaryAccount.name,
            description: `Salaries & wages (indirect labor) ${payrollRun.pay_period_start.toISOString().split("T")[0]} to ${payrollRun.pay_period_end.toISOString().split("T")[0]}`,
            debit: runIndirect,
            credit: 0,
          });
        }

        // DR RSSB Employer Contributions (6150 = RSSB Employer Cost)
        if (employerContributions > 0) {
          lines.push({
            accountCode: "6150",
            accountName: "RSSB Employer Cost",
            description: "RSSB employer contributions",
            debit: employerContributions,
            credit: 0,
          });
        }

        // CR Tax Payable — PAYE withheld
        if (payrollRun.total_tax > 0) {
          lines.push({
            accountCode: taxPayableAccount.code,
            accountName: taxPayableAccount.name,
            description: "PAYE tax withheld",
            debit: 0,
            credit: payrollRun.total_tax,
          });
        }

        // CR RSSB Payable — employee + employer contributions (2240)
        if (
          payrollRun.total_other_deductions > 0 ||
          employerContributions > 0
        ) {
          const rssbTotal =
            (payrollRun.total_other_deductions || 0) + employerContributions;
          lines.push({
            accountCode: otherDedAccount?.code || "2240",
            accountName: otherDedAccount?.name || "RSSB Payable",
            description: "RSSB employee & employer contributions",
            debit: 0,
            credit: rssbTotal,
          });
        }

        // CR Bank — net pay disbursed
        if (payrollRun.total_net > 0) {
          lines.push({
            accountCode: "2300",
            accountName: "Salaries Payable",
            description: "Net salaries payable",
            debit: 0,
            credit: payrollRun.total_net,
          });
        }
      }

      if (!accrualAlreadyPosted) {
        const built = PayrollRunService.buildPayrollAccrualLines(
          payrollRun,
          { salaryAccount, taxPayableAccount, otherDedAccount },
          true,
        );
        lines = built.lines;
      }

      const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
      const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);

      await PayrollRunService.voidJournalEntriesForRepost(
        companyId,
        "payroll_run",
        `${payrollRun._id}-accrual`,
        "payroll_run_voided",
      );
      await PayrollRunService.voidJournalEntriesForRepost(
        companyId,
        "payroll_reversal",
        `${payrollRun._id}-reversal`,
        "payroll_reversal_voided",
      );

      const journalEntry = await JournalEntry.create({
        company: companyId,
        date: accrualAlreadyPosted
          ? payrollRun.payment_date
          : payrollRun.pay_period_end || payrollRun.payment_date,
        description: `Payroll - ${payrollRun.pay_period_start.toISOString().split("T")[0]} to ${payrollRun.pay_period_end.toISOString().split("T")[0]} - PYRL#${payrollRun.reference_no}`,
        sourceType: "payroll_run",
        sourceId: `${payrollRun._id}-accrual`,
        sourceReference: payrollRun.reference_no,
        reference: payrollRun.reference_no,
        status: "posted",
        lines,
        postedBy: userId,
        createdBy: userId,
        period: periodId,
        isAutoGenerated: false,
      });

      let netPayJournalEntry = null;
      if (!accrualAlreadyPosted && payrollRun.total_net > 0) {
        const netPayLines = PayrollRunService.buildNetPayLines(payrollRun, bankAccount);

        await PayrollRunService.voidJournalEntriesForRepost(
          companyId,
          "payroll_net_pay",
          `${payrollRun._id}-net-pay`,
          "payroll_net_pay_voided",
        );

        netPayJournalEntry = await JournalEntry.create({
          company: companyId,
          date: payrollRun.payment_date,
          description: `Payroll Net Pay - ${payrollRun.pay_period_start.toISOString().split("T")[0]} to ${payrollRun.pay_period_end.toISOString().split("T")[0]} - PYRL#${payrollRun.reference_no}`,
          sourceType: "payroll_net_pay",
          sourceId: `${payrollRun._id}-net-pay`,
          sourceReference: payrollRun.reference_no,
          reference: payrollRun.reference_no,
          status: "posted",
          lines: netPayLines,
          postedBy: userId,
          createdBy: userId,
          period: periodId,
          isAutoGenerated: true,
          _skipAutoBankSync: true,
          bankAccountId: payrollRun.bank_account_id || undefined,
        });
      }

      // Update payroll run status
      payrollRun.status = "posted";
      payrollRun.journal_entry_id = journalEntry._id;
      payrollRun.net_pay_journal_id = netPayJournalEntry?._id || null;
      payrollRun.reversal_journal_entry_id = null;
      payrollRun.posted_by = userId;
      payrollRun.employee_count = payrollRun.lines?.length || 0;
      await payrollRun.save();

      // Update employee records to paid status
      await Payroll.updateMany(
        { payroll_run_id: payrollRun._id },
        { record_status: "paid" },
      );

      // Create BankTransaction to reduce bank balance (net salary disbursement)
      // Uses addTransaction() so cachedBalance is correctly updated and per-account
      // transaction history is populated.
      if (bankAccount && payrollRun.total_net > 0) {
        try {
          await bankAccount.addTransaction({
            type: "withdrawal",
            amount: payrollRun.total_net,
            description: `Payroll net pay — ${payrollRun.pay_period_start.toISOString().split("T")[0]} to ${payrollRun.pay_period_end.toISOString().split("T")[0]} — PYRL#${payrollRun.reference_no}`,
            date: payrollRun.payment_date || new Date(),
            referenceNumber: payrollRun.reference_no,
            referenceType: "Payment",
            reference: payrollRun._id,
            createdBy: userId,
            notes: `Payroll run ${payrollRun.reference_no}`,
            journalEntryId: (netPayJournalEntry || journalEntry)._id,
          });
        } catch (btErr) {
          console.error(
            "BankTransaction creation failed for payroll run post:",
            btErr.message,
          );
          // Non-fatal — journal entry already posted
        }
      }

      return payrollRun;
    } catch (err) {
      throw err;
    }
  }

  // ── REVERSE PAYROLL RUN ─────────────────────────────────────────────────
  static async reverse(companyId, runId, data, userId) {
    const payrollRun = await PayrollRun.findOne({
      _id: runId,
      company: companyId,
    });

    if (!payrollRun) {
      const error = new Error("NOT_FOUND");
      error.statusCode = 404;
      throw error;
    }

    if (payrollRun.status === "reversed") {
      throw new Error("PAYROLL_ALREADY_REVERSED");
    }

    if (payrollRun.status !== "posted") {
      throw new Error("PAYROLL_NOT_POSTED");
    }

    if (!payrollRun.journal_entry_id) {
      throw new Error("NO_JOURNAL_ENTRY");
    }

    try {
      const originalEntry = await JournalEntry.findById(
        payrollRun.journal_entry_id,
      );
      if (!originalEntry) {
        throw new Error("JOURNAL_ENTRY_NOT_FOUND");
      }

      const periodId = await PeriodService.getOpenPeriodId(
        companyId,
        data.reversal_date || new Date(),
      );

      const reversalLines = originalEntry.lines.map((line) => ({
        accountCode: line.accountCode,
        accountName: line.accountName,
        description: `REVERSAL: ${line.description}`,
        debit: line.credit || 0,
        credit: line.debit || 0,
      }));

      const reversalEntry = await JournalEntry.create({
        company: companyId,
        date: data.reversal_date || new Date(),
        description: `Payroll Reversal - ${payrollRun.reference_no}`,
        sourceType: "payroll_reversal",
        sourceId: `${payrollRun._id}-reversal`,
        sourceReference: payrollRun.reference_no,
        reference: payrollRun.reference_no,
        status: "posted",
        lines: reversalLines,
        postedBy: userId,
        createdBy: userId,
        period: periodId,
        isAutoGenerated: false,
        _skipAutoBankSync: Boolean(payrollRun.bank_account_id),
        bankAccountId: payrollRun.bank_account_id || undefined,
      });

      payrollRun.status = "draft";
      payrollRun.reversal_journal_entry_id = reversalEntry._id;

      // Reverse PAYE remittance journal if exists
      if (payrollRun.paye_remit_journal_id) {
        try {
          const payeEntry = await JournalEntry.findById(payrollRun.paye_remit_journal_id);
          if (payeEntry) {
            const payeReversalLines = payeEntry.lines.map((line) => ({
              accountCode: line.accountCode,
              accountName: line.accountName,
              description: `REVERSAL: ${line.description}`,
              debit: line.credit || 0,
              credit: line.debit || 0,
            }));
            await JournalEntry.create({ company: companyId, date: data.reversal_date || new Date(), description: `PAYE Remittance Reversal — ${payrollRun.reference_no}`, sourceType: "payroll_remit_paye_reversal", sourceId: `${payrollRun._id}-paye-reversal`, sourceReference: payrollRun.reference_no, reference: payrollRun.reference_no, status: "posted", lines: payeReversalLines, postedBy: userId, createdBy: userId, period: periodId, isAutoGenerated: true, _skipAutoBankSync: Boolean(payrollRun.bank_account_id), bankAccountId: payrollRun.bank_account_id || undefined });
            await PayrollRunService.voidJournalEntriesForRepost(
              companyId,
              "payroll_remit_paye",
              `${payrollRun._id}-paye`,
              "payroll_remit_paye_voided",
              [payeEntry._id],
            );
          }
        } catch (e) { console.error("[reverse] PAYE remittance reversal failed:", e.message); }
      }

      // Reverse RSSB remittance journal if exists
      if (payrollRun.rssb_remit_journal_id) {
        try {
          const rssbEntry = await JournalEntry.findById(payrollRun.rssb_remit_journal_id);
          if (rssbEntry) {
            const rssbReversalLines = rssbEntry.lines.map((line) => ({
              accountCode: line.accountCode,
              accountName: line.accountName,
              description: `REVERSAL: ${line.description}`,
              debit: line.credit || 0,
              credit: line.debit || 0,
            }));
            await JournalEntry.create({ company: companyId, date: data.reversal_date || new Date(), description: `RSSB Remittance Reversal — ${payrollRun.reference_no}`, sourceType: "payroll_remit_rssb_reversal", sourceId: `${payrollRun._id}-rssb-reversal`, sourceReference: payrollRun.reference_no, reference: payrollRun.reference_no, status: "posted", lines: rssbReversalLines, postedBy: userId, createdBy: userId, period: periodId, isAutoGenerated: true, _skipAutoBankSync: Boolean(payrollRun.bank_account_id), bankAccountId: payrollRun.bank_account_id || undefined });
            await PayrollRunService.voidJournalEntriesForRepost(
              companyId,
              "payroll_remit_rssb",
              `${payrollRun._id}-rssb`,
              "payroll_remit_rssb_voided",
              [rssbEntry._id],
            );
          }
        } catch (e) { console.error("[reverse] RSSB remittance reversal failed:", e.message); }
      }

      // Clear remittance flags so the run can be re-remitted after re-posting
      if (payrollRun.remittance) {
        if (payrollRun.remittance.paye) payrollRun.remittance.paye.remitted = false;
        if (payrollRun.remittance.rssb) payrollRun.remittance.rssb.remitted = false;
        payrollRun.markModified('remittance');
      }
      payrollRun.paye_remit_journal_id = null;
      payrollRun.rssb_remit_journal_id = null;
      await payrollRun.save();

      // Set employee records back to finalised and clear payroll_run_id so they can be reused
      await Payroll.updateMany(
        { payroll_run_id: payrollRun._id },
        { record_status: "finalised", payroll_run_id: null },
      );

      // Create BankTransaction to restore bank balance on reversal
      const bankAccountForReversal = await BankAccount.findOne({
        _id: payrollRun.bank_account_id,
        company: companyId,
      });
      if (bankAccountForReversal && payrollRun.total_net > 0) {
        try {
          await bankAccountForReversal.addTransaction({
            type: "deposit",
            amount: payrollRun.total_net,
            description: `Payroll reversal — PYRL#${payrollRun.reference_no}`,
            date: data.reversal_date || new Date(),
            referenceNumber: payrollRun.reference_no,
            referenceType: "Payment",
            reference: payrollRun._id,
            createdBy: userId,
            notes: `Reversal of payroll run ${payrollRun.reference_no}`,
            journalEntryId: reversalEntry._id,
          });
        } catch (btErr) {
          console.error(
            "BankTransaction creation failed for payroll run reversal:",
            btErr.message,
          );
          // Non-fatal — journal entry already posted
        }
      }

      // Restore bank balance for PAYE remittance reversal
      if (bankAccountForReversal && payrollRun.remittance?.paye?.amount > 0) {
        try {
          await bankAccountForReversal.addTransaction({
            type: "deposit",
            amount: payrollRun.remittance.paye.amount,
            description: `PAYE remittance reversal — PYRL#${payrollRun.reference_no}`,
            date: data.reversal_date || new Date(),
            referenceNumber: payrollRun.reference_no,
            referenceType: "Payment",
            reference: payrollRun._id,
            createdBy: userId,
            notes: `Reversal of PAYE remittance for payroll run ${payrollRun.reference_no}`,
          });
        } catch (btErr) { console.error("[reverse] PAYE bank deposit failed:", btErr.message); }
      }

      // Restore bank balance for RSSB remittance reversal
      if (bankAccountForReversal && payrollRun.remittance?.rssb?.amount > 0) {
        try {
          await bankAccountForReversal.addTransaction({
            type: "deposit",
            amount: payrollRun.remittance.rssb.amount,
            description: `RSSB remittance reversal — PYRL#${payrollRun.reference_no}`,
            date: data.reversal_date || new Date(),
            referenceNumber: payrollRun.reference_no,
            referenceType: "Payment",
            reference: payrollRun._id,
            createdBy: userId,
            notes: `Reversal of RSSB remittance for payroll run ${payrollRun.reference_no}`,
          });
        } catch (btErr) { console.error("[reverse] RSSB bank deposit failed:", btErr.message); }
      }

      return payrollRun;
    } catch (err) {
      throw err;
    }
  }

  // ── REMIT PAYE ──────────────────────────────────────────────────────────
  static async remitPaye(companyId, runId, data, userId) {
    const payrollRun = await PayrollRun.findOne({
      _id: runId,
      company: companyId,
    });

    if (!payrollRun) {
      const error = new Error("NOT_FOUND");
      error.statusCode = 404;
      throw error;
    }

    if (payrollRun.status !== "posted") {
      throw new Error("PAYROLL_NOT_POSTED");
    }

    if (payrollRun.remittance?.paye?.remitted) {
      throw new Error("PAYE_ALREADY_REMITTED");
    }

    if (data.amount && Math.abs(Number(data.amount) - payrollRun.total_tax) > 0.01) {
      throw new Error("PAYE_REMITTANCE_AMOUNT_MISMATCH");
    }

    if (!payrollRun.remittance) payrollRun.remittance = {};
    payrollRun.remittance.paye = {
      remitted: true,
      remitted_date: data.remitted_date ? new Date(data.remitted_date) : new Date(),
      reference_no: data.reference_no || null,
      amount: data.amount || payrollRun.total_tax,
    };
    payrollRun.markModified('remittance.paye');
    await payrollRun.save();

    try {
      const bankAccount = await BankAccount.findOne({ _id: payrollRun.bank_account_id, company: companyId });
      const periodId = await PeriodService.getOpenPeriodId(companyId, data.remitted_date || new Date());
      const amount = data.amount || payrollRun.total_tax;

      await PayrollRunService.voidJournalEntriesForRepost(
        companyId,
        "payroll_remit_paye",
        `${payrollRun._id}-paye`,
        "payroll_remit_paye_voided",
      );
      const lines = [
        { accountCode: "2310", accountName: "PAYE Payable - RRA", description: "PAYE remitted to RRA", debit: amount, credit: 0 },
        { accountCode: bankAccount?.ledgerAccountId || "1100", accountName: bankAccount?.name || "Cash at Bank", description: "PAYE remittance payment", debit: 0, credit: amount },
      ];
      const journalEntry = await JournalEntry.create({ company: companyId, date: data.remitted_date ? new Date(data.remitted_date) : new Date(), description: `PAYE Remittance — ${payrollRun.reference_no}`, sourceType: "payroll_remit_paye", sourceId: `${payrollRun._id}-paye`, sourceReference: payrollRun.reference_no, reference: payrollRun.reference_no, status: "posted", lines, postedBy: userId, createdBy: userId, period: periodId, isAutoGenerated: true, _skipAutoBankSync: true, bankAccountId: payrollRun.bank_account_id || undefined });
      payrollRun.paye_remit_journal_id = journalEntry._id;
      await payrollRun.save();

      // Create BankTransaction to reduce bank balance for PAYE remittance
      if (bankAccount && amount > 0) {
        try {
          await bankAccount.addTransaction({
            type: "withdrawal",
            amount: amount,
            description: `PAYE remittance — PYRL#${payrollRun.reference_no}${data.reference_no ? ` — Ref: ${data.reference_no}` : ""}`,
            date: data.remitted_date ? new Date(data.remitted_date) : new Date(),
            referenceNumber: data.reference_no || payrollRun.reference_no,
            referenceType: "Payment",
            reference: payrollRun._id,
            createdBy: userId,
            notes: `PAYE remittance for payroll run ${payrollRun.reference_no}`,
            journalEntryId: journalEntry._id,
          });
        } catch (btErr) { console.error("[remitPaye] BankTransaction failed:", btErr.message); }
      }
    } catch (je) { console.error("[remitPaye] Journal entry failed:", je.message); }

    return payrollRun;
  }

  // ── REMIT RSSB ──────────────────────────────────────────────────────────
  static async remitRssb(companyId, runId, data, userId) {
    const payrollRun = await PayrollRun.findOne({
      _id: runId,
      company: companyId,
    });

    if (!payrollRun) {
      const error = new Error("NOT_FOUND");
      error.statusCode = 404;
      throw error;
    }

    if (payrollRun.status !== "posted") {
      throw new Error("PAYROLL_NOT_POSTED");
    }

    if (payrollRun.remittance?.rssb?.remitted) {
      throw new Error("RSSB_ALREADY_REMITTED");
    }

    const rssbEmployeePension = payrollRun.lines.reduce((sum, l) => sum + (l.rssb_employee_pension || 0), 0);
    const rssbEmployeeMaternity = payrollRun.lines.reduce((sum, l) => sum + (l.rssb_employee_maternity || 0), 0);
    const rssbEmployerPension = payrollRun.lines.reduce((sum, l) => sum + (l.rssb_employer_pension || 0), 0);
    const rssbEmployerMaternity = payrollRun.lines.reduce((sum, l) => sum + (l.rssb_employer_maternity || 0), 0);
    const totalOccupationalHazard = payrollRun.lines.reduce((sum, l) => sum + (l.occupational_hazard || 0), 0);
    const totalRssb =
      rssbEmployeePension +
      rssbEmployeeMaternity +
      rssbEmployerPension +
      rssbEmployerMaternity +
      totalOccupationalHazard;

    if (data.amount && Math.abs(Number(data.amount) - totalRssb) > 0.01) {
      throw new Error("RSSB_REMITTANCE_AMOUNT_MISMATCH");
    }

    if (!payrollRun.remittance) payrollRun.remittance = {};
    payrollRun.remittance.rssb = {
      remitted: true,
      remitted_date: data.remitted_date ? new Date(data.remitted_date) : new Date(),
      reference_no: data.reference_no || null,
      amount: data.amount || totalRssb,
    };
    payrollRun.markModified('remittance.rssb');
    await payrollRun.save();

    try {
      const bankAccount = await BankAccount.findOne({ _id: payrollRun.bank_account_id, company: companyId });
      const periodId = await PeriodService.getOpenPeriodId(companyId, data.remitted_date || new Date());
      const rssbAmount = data.amount || totalRssb;

      await PayrollRunService.voidJournalEntriesForRepost(
        companyId,
        "payroll_remit_rssb",
        `${payrollRun._id}-rssb`,
        "payroll_remit_rssb_voided",
      );
      const bankCredit = rssbAmount;
      const lines = [];
      [
        ["2320", "RSSB Employee Pension Payable - 6%", rssbEmployeePension],
        ["2321", "RSSB Employee Maternity Payable - 0.3%", rssbEmployeeMaternity],
        ["2330", "RSSB Employer Pension Payable - 6%", rssbEmployerPension],
        ["2331", "RSSB Employer Maternity Payable - 0.3%", rssbEmployerMaternity],
        ["2332", "Occupational Hazard Payable", totalOccupationalHazard],
      ].forEach(([accountCode, accountName, amount]) => {
        if (amount > 0) {
          lines.push({ accountCode, accountName, description: "RSSB remitted", debit: amount, credit: 0 });
        }
      });
      lines.push({ accountCode: bankAccount?.ledgerAccountId || "1100", accountName: bankAccount?.name || "Cash at Bank", description: "RSSB remittance payment", debit: 0, credit: bankCredit });
      const journalEntry = await JournalEntry.create({ company: companyId, date: data.remitted_date ? new Date(data.remitted_date) : new Date(), description: `RSSB Remittance — ${payrollRun.reference_no}`, sourceType: "payroll_remit_rssb", sourceId: `${payrollRun._id}-rssb`, sourceReference: payrollRun.reference_no, reference: payrollRun.reference_no, status: "posted", lines, postedBy: userId, createdBy: userId, period: periodId, isAutoGenerated: true, _skipAutoBankSync: true, bankAccountId: payrollRun.bank_account_id || undefined });
      payrollRun.rssb_remit_journal_id = journalEntry._id;
      await payrollRun.save();

      // Create BankTransaction to reduce bank balance for RSSB remittance
      if (bankAccount && bankCredit > 0) {
        try {
          await bankAccount.addTransaction({
            type: "withdrawal",
            amount: bankCredit,
            description: `RSSB remittance — PYRL#${payrollRun.reference_no}${data.reference_no ? ` — Ref: ${data.reference_no}` : ""}`,
            date: data.remitted_date ? new Date(data.remitted_date) : new Date(),
            referenceNumber: data.reference_no || payrollRun.reference_no,
            referenceType: "Payment",
            reference: payrollRun._id,
            createdBy: userId,
            notes: `RSSB remittance for payroll run ${payrollRun.reference_no}`,
            journalEntryId: journalEntry._id,
          });
        } catch (btErr) { console.error("[remitRssb] BankTransaction failed:", btErr.message); }
      }
    } catch (je) { console.error("[remitRssb] Journal entry failed:", je.message); }

    return payrollRun;
  }

  // ── GENERATE BANK TRANSFER DATA ─────────────────────────────────────────
  static async generateBankTransferData(companyId, runId) {
    const payrollRun = await PayrollRun.findOne({
      _id: runId,
      company: companyId,
    });

    if (!payrollRun) {
      const error = new Error("NOT_FOUND");
      error.statusCode = 404;
      throw error;
    }

    const bankAccount = await BankAccount.findById(payrollRun.bank_account_id);

    const records = payrollRun.lines.map((l) => ({
      employee_name: l.employee_name,
      employee_id: l.employee_id,
      bank_name: l.bank_name || "",
      bank_account: l.bank_account || "",
      net_pay: l.net_pay,
      currency: "RWF",
    }));

    return {
      reference_no: payrollRun.reference_no,
      payment_date: payrollRun.payment_date,
      period_start: payrollRun.pay_period_start,
      period_end: payrollRun.pay_period_end,
      total_net: payrollRun.total_net,
      bank_name: bankAccount?.bankName || "",
      bank_account: bankAccount?.accountNumber || "",
      records,
    };
  }
}

module.exports = PayrollRunService;
