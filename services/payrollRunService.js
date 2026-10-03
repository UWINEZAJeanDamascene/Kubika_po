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
const { runInPrismaTransaction } = require("./transactionService");
const { PAYROLL_ACCOUNTS, assertJournalBalanced } = require("../constants/payrollAccounts");
const { recordPayrollAudit, runSnapshot } = require("./payrollAuditService");
const { monthlyStatutoryDeadline, buildPayrollDeadlines } = require("../utils/payrollCompliance");

const { applyJournalLinesToAccountBalances } = require('../utils/accountBalanceSync');

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const nearMoney = (actual, expected) => Math.abs(money(actual) - money(expected)) <= 0.01;
const sameActor = (left, right) => String(left?._id || left?.id || left || "") === String(right?._id || right?.id || right || "");
function validatedEvidenceUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value).trim());
    if (parsed.protocol !== "https:") throw new Error();
    return parsed.toString();
  } catch {
    throw Object.assign(new Error("Evidence links must be valid HTTPS URLs"), { statusCode: 400, code: "PAYROLL_EVIDENCE_URL_INVALID" });
  }
}

function journalAccountTotal(entry, accountCode, side) {
  return (entry?.lines || []).reduce((sum, line) =>
    String(line.accountCode) === String(accountCode) ? sum + Number(line[side] || 0) : sum, 0);
}

function assertJournalAccount(entry, accountCode, debit, credit, label) {
  if (!nearMoney(journalAccountTotal(entry, accountCode, "debit"), debit)
    || !nearMoney(journalAccountTotal(entry, accountCode, "credit"), credit)) {
    const error = new Error(`${label}: expected account ${accountCode} debit ${money(debit).toFixed(2)} and credit ${money(credit).toFixed(2)}`);
    error.code = "PAYROLL_ACCRUAL_ACCOUNT_MISMATCH";
    error.statusCode = 409;
    throw error;
  }
}

function payrollRunLineMatches(line, payroll) {
  const values = [
    [line.gross_salary, payroll.salary?.grossSalary],
    [line.tax_deduction, payroll.deductions?.paye],
    [line.rssb_employee_pension, payroll.deductions?.rssbEmployeePension],
    [line.rssb_employee_maternity, payroll.deductions?.rssbEmployeeMaternity],
    [line.rssb_employer_pension, payroll.contributions?.rssbEmployerPension],
    [line.rssb_employer_maternity, payroll.contributions?.rssbEmployerMaternity],
    [line.occupational_hazard, payroll.contributions?.occupationalHazard],
    [line.health_insurance, payroll.deductions?.healthInsurance],
    [line.loan_deductions, payroll.deductions?.loanDeductions],
    [line.other_deductions, payroll.deductions?.otherDeductions],
    [line.net_pay, payroll.netPay],
  ];
  return values.every(([actual, expected]) => nearMoney(actual, expected));
}

function validateEmployeeAccrual(payroll, salaryEntry, employerEntry) {
  const id = String(payroll._id);
  if (!salaryEntry || salaryEntry.status !== "posted") {
    const error = new Error(`Payroll employee ${id} is missing its posted salary accrual`);
    error.code = "PAYROLL_EMPLOYEE_ACCRUAL_MISSING";
    error.statusCode = 409;
    throw error;
  }
  assertJournalBalanced(salaryEntry.lines, `Salary accrual for payroll ${id}`);
  const gross = money(payroll.salary?.grossSalary);
  const paye = money(payroll.deductions?.paye);
  const employeePension = money(payroll.deductions?.rssbEmployeePension);
  const employeeMaternity = money(payroll.deductions?.rssbEmployeeMaternity);
  const hazard = money(payroll.contributions?.occupationalHazard);
  const otherDeductions = money((payroll.deductions?.healthInsurance || 0)
    + (payroll.deductions?.loanDeductions || 0)
    + (payroll.deductions?.otherDeductions || 0));
  const net = money(payroll.netPay);
  const salaryDebits = journalAccountTotal(salaryEntry, PAYROLL_ACCOUNTS.directLaborExpense, "debit")
    + journalAccountTotal(salaryEntry, PAYROLL_ACCOUNTS.salaryExpense, "debit");
  if (!nearMoney(salaryDebits, gross)) {
    const error = new Error(`Payroll employee ${id} salary accrual does not match gross pay`);
    error.code = "PAYROLL_EMPLOYEE_ACCRUAL_MISMATCH";
    error.statusCode = 409;
    throw error;
  }
  assertJournalAccount(salaryEntry, PAYROLL_ACCOUNTS.payePayable, 0, paye, `Salary accrual ${id}`);
  assertJournalAccount(salaryEntry, PAYROLL_ACCOUNTS.employeePensionPayable, 0, employeePension, `Salary accrual ${id}`);
  assertJournalAccount(salaryEntry, PAYROLL_ACCOUNTS.employeeMaternityPayable, 0, employeeMaternity, `Salary accrual ${id}`);
  assertJournalAccount(salaryEntry, PAYROLL_ACCOUNTS.occupationalHazardPayable, 0, hazard, `Salary accrual ${id}`);
  assertJournalAccount(salaryEntry, PAYROLL_ACCOUNTS.otherDeductionsPayable, 0, otherDeductions, `Salary accrual ${id}`);
  assertJournalAccount(salaryEntry, PAYROLL_ACCOUNTS.salaryPayable, 0, net, `Salary accrual ${id}`);
  assertJournalAccount(salaryEntry, PAYROLL_ACCOUNTS.employerContributionExpense, hazard, 0, `Salary accrual ${id}`);

  const employerCost = money((payroll.contributions?.rssbEmployerPension || 0)
    + (payroll.contributions?.rssbEmployerMaternity || 0));
  if (employerCost > 0) {
    if (!employerEntry || employerEntry.status !== "posted") {
      const error = new Error(`Payroll employee ${id} is missing its posted employer RSSB accrual`);
      error.code = "PAYROLL_EMPLOYER_ACCRUAL_MISSING";
      error.statusCode = 409;
      throw error;
    }
    assertJournalBalanced(employerEntry.lines, `Employer RSSB accrual for payroll ${id}`);
    assertJournalAccount(employerEntry, PAYROLL_ACCOUNTS.employerContributionExpense, employerCost, 0, `Employer RSSB accrual ${id}`);
    assertJournalAccount(employerEntry, PAYROLL_ACCOUNTS.employerPensionPayable, 0, payroll.contributions?.rssbEmployerPension || 0, `Employer RSSB accrual ${id}`);
    assertJournalAccount(employerEntry, PAYROLL_ACCOUNTS.employerMaternityPayable, 0, payroll.contributions?.rssbEmployerMaternity || 0, `Employer RSSB accrual ${id}`);
  }
}

async function assertPayrollRunAccruals(companyId, payrollRun) {
  const payrollIds = (payrollRun.lines || []).map((line) => line.payroll_id).filter(Boolean).map(String);
  if (!payrollIds.length || payrollIds.length !== payrollRun.lines.length
    || new Set(payrollIds).size !== payrollIds.length) {
    const error = new Error("Every payroll run line must reference one unique payroll record.");
    error.code = "PAYROLL_RUN_EMPLOYEES_INVALID";
    error.statusCode = 409;
    throw error;
  }
  const records = await Payroll.find({
    company: companyId,
    _id: { $in: payrollIds },
    payroll_run_id: payrollRun._id,
    record_status: { $in: ["finalised", "paid"] },
  });
  if (records.length !== payrollIds.length) {
    const error = new Error("Every run employee must have a linked payroll record and must not be assigned to another run.");
    error.code = "PAYROLL_RUN_EMPLOYEE_LINK_MISMATCH";
    error.statusCode = 409;
    throw error;
  }
  const entries = await JournalEntry.find({
    company: companyId,
    sourceType: { $in: ["payroll_salary", "payroll_employer"] },
    sourceId: { $in: payrollIds },
    status: "posted",
  });
  const salaryById = new Map();
  const employerById = new Map();
  for (const entry of entries) {
    const map = entry.sourceType === "payroll_employer" ? employerById : salaryById;
    const list = map.get(String(entry.sourceId)) || [];
    list.push(entry);
    map.set(String(entry.sourceId), list);
  }
  for (const id of payrollIds) {
    const record = records.find((row) => String(row._id) === id);
    const line = payrollRun.lines.find((row) => String(row.payroll_id) === id);
    if (!record || !line || !payrollRunLineMatches(line, record)) {
      const error = new Error(`Payroll run line does not match employee payroll record ${id}.`);
      error.code = "PAYROLL_RUN_LINE_MISMATCH";
      error.statusCode = 409;
      throw error;
    }
    let salaryEntry;
    for (const entry of salaryById.get(id) || []) {
      try { validateEmployeeAccrual(record, entry, null); salaryEntry = entry; break; } catch (_) { /* try the employee's other posted source entry */ }
    }
    let employerEntry;
    for (const entry of employerById.get(id) || []) {
      try {
        assertJournalBalanced(entry.lines, `Employer RSSB accrual for payroll ${id}`);
        const due = money((record.contributions?.rssbEmployerPension || 0) + (record.contributions?.rssbEmployerMaternity || 0));
        assertJournalAccount(entry, PAYROLL_ACCOUNTS.employerContributionExpense, due, 0, `Employer RSSB accrual ${id}`);
        assertJournalAccount(entry, PAYROLL_ACCOUNTS.employerPensionPayable, 0, record.contributions?.rssbEmployerPension || 0, `Employer RSSB accrual ${id}`);
        assertJournalAccount(entry, PAYROLL_ACCOUNTS.employerMaternityPayable, 0, record.contributions?.rssbEmployerMaternity || 0, `Employer RSSB accrual ${id}`);
        employerEntry = entry;
        break;
      } catch (_) { /* try the employee's other posted employer source entry */ }
    }
    validateEmployeeAccrual(record, salaryEntry, employerEntry);
  }
}

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
    const salaryExpenseCode = accounts.salaryAccount?.code || PAYROLL_ACCOUNTS.salaryExpense;
    const salaryExpenseName = accounts.salaryAccount?.name || "Salaries & Wages";
    const payeCode = PAYROLL_ACCOUNTS.payePayable;
    const payeName = useDetailedPayables
      ? "PAYE Payable - RRA"
      : accounts.taxPayableAccount?.name || "PAYE Tax Payable";
    const lines = [];

    if (totals.direct > 0) {
      lines.push(
        PayrollRunService.accountLine(
          PAYROLL_ACCOUNTS.directLaborExpense,
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
          [PAYROLL_ACCOUNTS.employeePensionPayable, "RSSB Employee Pension Payable", totals.rssbEmployeePension],
          [PAYROLL_ACCOUNTS.employeeMaternityPayable, "RSSB Employee Maternity Payable", totals.rssbEmployeeMaternity],
          [PAYROLL_ACCOUNTS.employerPensionPayable, "RSSB Employer Pension Payable", totals.rssbEmployerPension],
          [PAYROLL_ACCOUNTS.employerMaternityPayable, "RSSB Employer Maternity Payable", totals.rssbEmployerMaternity],
          [PAYROLL_ACCOUNTS.occupationalHazardPayable, "Occupational Hazard Payable", totals.occupationalHazard],
        ]
      : [
          [PAYROLL_ACCOUNTS.employeePensionPayable, "RSSB Employee Pension Payable", totals.rssbEmployeePension],
          [PAYROLL_ACCOUNTS.employeeMaternityPayable, "RSSB Employee Maternity Payable", totals.rssbEmployeeMaternity],
          [PAYROLL_ACCOUNTS.employerPensionPayable, "RSSB Employer Pension Payable", totals.rssbEmployerPension],
          [PAYROLL_ACCOUNTS.employerMaternityPayable, "RSSB Employer Maternity Payable", totals.rssbEmployerMaternity],
          [PAYROLL_ACCOUNTS.occupationalHazardPayable, "Occupational Hazard Payable", totals.occupationalHazard],
        ];

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
          PAYROLL_ACCOUNTS.otherDeductionsPayable,
          "Other Payroll Deductions Payable",
          "Other employee deductions payable",
          0,
          otherEmployeeDeductions,
        ),
      );
    }

    if (totals.net > 0) {
      lines.push(
        PayrollRunService.accountLine(
          PAYROLL_ACCOUNTS.salaryPayable,
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
        PAYROLL_ACCOUNTS.salaryPayable,
        "Salaries Payable",
        `Clear net salaries payable ${periodLabel}`,
        amount,
        0,
      ),
      PayrollRunService.accountLine(
        bankAccount?.ledgerAccountId || PAYROLL_ACCOUNTS.defaultBank,
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
    return runInPrismaTransaction(() => this.createFromRecordsInTransaction(companyId, data, userId));
  }

  static async createFromRecordsInTransaction(companyId, data, userId) {
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
    const payPeriodStart = new Date(filterYear, filterMonth - 1, 1);
    const payPeriodEnd = new Date(filterYear, filterMonth, 0);

    const payrollRecords = await Payroll.find({
      company: companyId,
      record_status: "finalised",
      payroll_run_id: null,
      pay_period_start: { gte: payPeriodStart, lte: payPeriodEnd },
    });

    if (payrollRecords.length === 0) {
      const err = new Error(
        `NO_FINALISED_RECORDS: No finalised payroll records found for ${filterMonth}/${filterYear}. ` +
          `Please go to Payroll, create and finalise employee records for that month first.`,
      );
      err.statusCode = 422;
      throw err;
    }

    const employeeKeys = payrollRecords.map((row) => String(row.employee_id || row.employee?.employeeId || "").trim().toLowerCase()).filter(Boolean);
    if (employeeKeys.length !== payrollRecords.length) {
      const err = new Error("PAYROLL_EMPLOYEE_ID_REQUIRED: Every payroll record must have an employee ID before it can join a run.");
      err.statusCode = 409;
      throw err;
    }
    if (new Set(employeeKeys).size !== employeeKeys.length) {
      const err = new Error("DUPLICATE_EMPLOYEE_PAYROLL_PERIOD: More than one payroll record exists for an employee in this period.");
      err.statusCode = 409;
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
        overtime: p.salary?.overtime || 0,
        bonuses: p.salary?.bonuses || 0,
        commissions: p.salary?.commissions || 0,
        benefits_in_kind: p.salary?.benefitsInKind || 0,
        taxable_base: p.salary?.taxableBase ?? p.salary?.grossRemuneration ?? p.salary?.grossSalary ?? 0,
        statutory_rates: p.contributions?.rates || p.salary?.rates || null,
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

    const salaryAccount = await ChartOfAccount.findOne({
      _id: data.salary_account_id,
      company: companyId,
    });
    const taxPayableAccount = await ChartOfAccount.findOne({
      _id: data.tax_payable_account_id,
      company: companyId,
    });
    const bankAccount = await BankAccount.findOne({
      _id: data.bank_account_id,
      company: companyId,
    });
    if (!salaryAccount || String(salaryAccount.code) !== PAYROLL_ACCOUNTS.salaryExpense) {
      throw new Error(`PAYROLL_ACCOUNT_MISMATCH: Payroll salary expense must use account ${PAYROLL_ACCOUNTS.salaryExpense}.`);
    }
    if (!taxPayableAccount || String(taxPayableAccount.code) !== PAYROLL_ACCOUNTS.payePayable) {
      throw new Error(`PAYROLL_ACCOUNT_MISMATCH: Payroll PAYE must use account ${PAYROLL_ACCOUNTS.payePayable}.`);
    }
    if (!bankAccount) throw new Error("PAYROLL_BANK_ACCOUNT_NOT_FOUND");

    const runPreview = { pay_period_start: data.pay_period_start, pay_period_end: data.pay_period_end, total_gross: totalGross, total_net: totalNet, lines };
    const accrualPreview = this.buildPayrollAccrualLines(runPreview, { salaryAccount, taxPayableAccount }, true).lines;
    assertJournalBalanced(accrualPreview, `Payroll run ${filterMonth}/${filterYear} accrual`);
    assertJournalBalanced(this.buildNetPayLines(runPreview, bankAccount), `Payroll run ${filterMonth}/${filterYear} payment`);

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
      created_by: userId,
    });

    const claimed = await Payroll.updateMany(
      { _id: { $in: payrollRecords.map((p) => p._id) }, payroll_run_id: null, record_status: "finalised" },
      { payroll_run_id: payrollRun._id },
    );
    if (claimed.count !== payrollRecords.length) {
      const error = new Error("PAYROLL_RECORD_ALREADY_ASSIGNED: One or more payroll records were assigned to another run; refresh and retry.");
      error.statusCode = 409;
      throw error;
    }
    await recordPayrollAudit({ companyId, userId, action: "payroll.run.created", entityType: "payroll_run", entityId: payrollRun._id, before: null, after: runSnapshot(payrollRun) });
    if (String(salaryAccount.code) !== PAYROLL_ACCOUNTS.salaryExpense
      || String(taxPayableAccount.code) !== PAYROLL_ACCOUNTS.payePayable) {
      const error = new Error("PAYROLL_ACCOUNT_MISMATCH: The run must use the configured payroll salary and PAYE accounts.");
      error.code = "PAYROLL_ACCOUNT_MISMATCH";
      error.statusCode = 409;
      throw error;
    }

    return payrollRun;
  }

  // ── CREATE DRAFT PAYROLL RUN ─────────────────────────────────────────────
  static async create(companyId, data, userId) {
    return runInPrismaTransaction(() => this.createInTransaction(companyId, data, userId));
  }

  static async createInTransaction(companyId, data, userId) {
    if (!Array.isArray(data.lines) || data.lines.length === 0) {
      throw new Error("PAYROLL_RUN_EMPLOYEES_REQUIRED");
    }
    const payrollIds = data.lines.map((line) => line.payroll_id).filter(Boolean).map(String);
    if (payrollIds.length !== data.lines.length || new Set(payrollIds).size !== payrollIds.length) {
      const error = new Error("Every payroll run line must reference one unique payroll record.");
      error.code = "PAYROLL_RUN_EMPLOYEES_INVALID";
      error.statusCode = 400;
      throw error;
    }
    const payrollRecords = await Payroll.find({
      company: companyId,
      _id: { $in: payrollIds },
      record_status: "finalised",
      payroll_run_id: null,
    });
    if (payrollRecords.length !== payrollIds.length) {
      const error = new Error("Every payroll run employee must be a finalised, unassigned payroll record.");
      error.code = "PAYROLL_RUN_EMPLOYEE_LINK_MISMATCH";
      error.statusCode = 409;
      throw error;
    }
    const periodKeys = new Set(payrollRecords.map((row) => `${Number(row.period?.year)}-${Number(row.period?.month)}`));
    const runDate = new Date(data.pay_period_start);
    const requestedPeriod = `${runDate.getFullYear()}-${runDate.getMonth() + 1}`;
    if (periodKeys.size !== 1 || periodKeys.has("NaN-NaN") || !Number.isFinite(runDate.getTime())
      || !periodKeys.has(requestedPeriod)) {
      const error = new Error("A payroll run can include records from only one employee pay period.");
      error.code = "PAYROLL_RUN_PERIOD_MISMATCH";
      error.statusCode = 409;
      throw error;
    }
    const employeeKeys = payrollRecords.map((row) => String(row.employee_id || row.employee?.employeeId || "").trim().toLowerCase());
    if (employeeKeys.some((key) => !key) || new Set(employeeKeys).size !== employeeKeys.length) {
      const error = new Error("Payroll run lines contain a missing or duplicate employee for this period.");
      error.code = "PAYROLL_RUN_EMPLOYEE_PERIOD_DUPLICATE";
      error.statusCode = 409;
      throw error;
    }
    for (const line of data.lines) {
      const record = payrollRecords.find((row) => String(row._id) === String(line.payroll_id));
      if (!record || !payrollRunLineMatches(line, record)) {
        const error = new Error(`Payroll run line does not match payroll record ${line.payroll_id}.`);
        error.code = "PAYROLL_RUN_LINE_MISMATCH";
        error.statusCode = 409;
        throw error;
      }
    }
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
    if (String(salaryAccount.code) !== PAYROLL_ACCOUNTS.salaryExpense
      || String(taxPayableAccount.code) !== PAYROLL_ACCOUNTS.payePayable) {
      const error = new Error("PAYROLL_ACCOUNT_MISMATCH: The run must use the configured payroll salary and PAYE accounts.");
      error.code = "PAYROLL_ACCOUNT_MISMATCH";
      error.statusCode = 409;
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

    const runPreview = { pay_period_start: data.pay_period_start, pay_period_end: data.pay_period_end, total_gross: data.total_gross, total_net: data.total_net, lines: data.lines };
    assertJournalBalanced(this.buildPayrollAccrualLines(runPreview, { salaryAccount, taxPayableAccount }, true).lines, "Payroll run accrual");
    assertJournalBalanced(this.buildNetPayLines(runPreview, bankAccount), "Payroll run payment");

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
      created_by: userId,
    });

    const claimed = await Payroll.updateMany(
      { _id: { $in: payrollIds }, company: companyId, record_status: "finalised", payroll_run_id: null },
      { payroll_run_id: payrollRun._id },
    );
    if (claimed.count !== payrollIds.length) {
      const error = new Error("One or more payroll records were assigned to another run; refresh and retry.");
      error.code = "PAYROLL_RECORD_ALREADY_ASSIGNED";
      error.statusCode = 409;
      throw error;
    }

    await recordPayrollAudit({ companyId, userId, action: "payroll.run.created", entityType: "payroll_run", entityId: payrollRun._id, before: null, after: runSnapshot(payrollRun) });

    return payrollRun;
  }

  // ── POST PAYROLL RUN ────────────────────────────────────────────────────
  static async post(companyId, runId, userId) {
    return runInPrismaTransaction(() => this.postInTransaction(companyId, runId, userId));
  }

  static async postInTransaction(companyId, runId, userId) {
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
    if (sameActor(payrollRun.created_by, userId)) {
      const error = new Error("A payroll run must be posted by a user other than its preparer");
      error.code = "PAYROLL_APPROVAL_SEPARATION_REQUIRED";
      error.statusCode = 403;
      throw error;
    }
    const beforeRunPost = runSnapshot(payrollRun);

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

      if (!payrollIds.length || payrollIds.length !== payrollRun.lines.length
        || new Set(payrollIds.map(String)).size !== payrollIds.length) {
        const error = new Error("PAYROLL_RUN_EMPLOYEES_INVALID: Every payroll run line must reference one unique payroll record.");
        error.code = "PAYROLL_RUN_EMPLOYEES_INVALID";
        error.statusCode = 409;
        throw error;
      }
      const payrollRecords = await Payroll.find({
        company: companyId,
        _id: { $in: payrollIds },
        payroll_run_id: payrollRun._id,
        record_status: "finalised",
      });
      if (payrollRecords.length !== payrollIds.length) {
        const error = new Error("PAYROLL_RUN_EMPLOYEE_LINK_MISMATCH: Every run employee must be a finalised payroll record assigned only to this run.");
        error.code = "PAYROLL_RUN_EMPLOYEE_LINK_MISMATCH";
        error.statusCode = 409;
        throw error;
      }
      if (String(salaryAccount.code) !== PAYROLL_ACCOUNTS.salaryExpense
        || String(taxPayableAccount.code) !== PAYROLL_ACCOUNTS.payePayable) {
        const error = new Error("PAYROLL_ACCOUNT_MISMATCH: The run must use the configured payroll salary and PAYE accounts.");
        error.code = "PAYROLL_ACCOUNT_MISMATCH";
        error.statusCode = 409;
        throw error;
      }
      const sourceIds = payrollIds.map(String);
      const accrualEntries = await JournalEntry.find({
        company: companyId,
        sourceType: { $in: ["payroll_salary", "payroll_employer"] },
        sourceId: { $in: sourceIds },
        status: "posted",
      });
      const salaryAccruals = new Map();
      const employerAccruals = new Map();
      for (const entry of accrualEntries) {
        const destination = entry.sourceType === "payroll_employer" ? employerAccruals : salaryAccruals;
        const group = destination.get(String(entry.sourceId)) || [];
        group.push(entry);
        destination.set(String(entry.sourceId), group);
      }
      for (const id of sourceIds) {
        const record = payrollRecords.find((row) => String(row._id) === id);
        const runLine = payrollRun.lines.find((row) => String(row.payroll_id) === id);
        if (!record || !runLine || !payrollRunLineMatches(runLine, record)) {
          const error = new Error(`PAYROLL_RUN_LINE_MISMATCH: Run line does not match payroll record ${id}.`);
          error.code = "PAYROLL_RUN_LINE_MISMATCH";
          error.statusCode = 409;
          throw error;
        }
        let matchedSalary;
        for (const entry of salaryAccruals.get(id) || []) {
          try { validateEmployeeAccrual(record, entry, null); matchedSalary = entry; break; } catch (_) { /* reject stale or mis-mapped historical postings */ }
        }
        let matchedEmployer;
        for (const entry of employerAccruals.get(id) || []) {
          try {
            assertJournalBalanced(entry.lines, `Employer RSSB accrual for payroll ${id}`);
            const due = money((record.contributions?.rssbEmployerPension || 0) + (record.contributions?.rssbEmployerMaternity || 0));
            assertJournalAccount(entry, PAYROLL_ACCOUNTS.employerContributionExpense, due, 0, `Employer RSSB accrual ${id}`);
            assertJournalAccount(entry, PAYROLL_ACCOUNTS.employerPensionPayable, 0, record.contributions?.rssbEmployerPension || 0, `Employer RSSB accrual ${id}`);
            assertJournalAccount(entry, PAYROLL_ACCOUNTS.employerMaternityPayable, 0, record.contributions?.rssbEmployerMaternity || 0, `Employer RSSB accrual ${id}`);
            matchedEmployer = entry;
            break;
          } catch (_) { /* reject stale or mis-mapped historical postings */ }
        }
        validateEmployeeAccrual(record, matchedSalary, matchedEmployer);
      }

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
        // DR Salaries Payable (2300) / CR Bank
        if (payrollRun.total_net > 0) {
          lines.push({
            accountCode: PAYROLL_ACCOUNTS.salaryPayable,
            accountName: "Salaries Payable",
            description: `Clear accrued salaries ${payrollRun.pay_period_start.toISOString().split("T")[0]} – ${payrollRun.pay_period_end.toISOString().split("T")[0]}`,
            debit: payrollRun.total_net,
            credit: 0,
          });
          lines.push({
            accountCode: bankAccount.ledgerAccountId || PAYROLL_ACCOUNTS.defaultBank,
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

      assertJournalBalanced(lines, `Payroll run ${payrollRun.reference_no} posting`);

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
          throw btErr;
        }
      }

      await recordPayrollAudit({ companyId, userId, action: "payroll.run.posted", entityType: "payroll_run", entityId: payrollRun._id, before: beforeRunPost, after: runSnapshot(payrollRun) });

      return payrollRun;
    } catch (err) {
      throw err;
    }
  }

  // ── REVERSE PAYROLL RUN ─────────────────────────────────────────────────
  static async reverse(companyId, runId, data, userId) {
    return runInPrismaTransaction(() => this.reverseInTransaction(companyId, runId, data, userId));
  }

  static async reverseInTransaction(companyId, runId, data, userId) {
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
    if (sameActor(payrollRun.posted_by, userId)) {
      const error = new Error("A payroll run must be reversed by a user other than its poster");
      error.code = "PAYROLL_APPROVAL_SEPARATION_REQUIRED";
      error.statusCode = 403;
      throw error;
    }
    const beforeRunReverse = runSnapshot(payrollRun);

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
      assertJournalBalanced(reversalLines, `Payroll reversal ${payrollRun.reference_no}`);

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
            assertJournalBalanced(payeReversalLines, `PAYE remittance reversal ${payrollRun.reference_no}`);
            await JournalEntry.create({ company: companyId, date: data.reversal_date || new Date(), description: `PAYE Remittance Reversal — ${payrollRun.reference_no}`, sourceType: "payroll_remit_paye_reversal", sourceId: `${payrollRun._id}-paye-reversal`, sourceReference: payrollRun.reference_no, reference: payrollRun.reference_no, status: "posted", lines: payeReversalLines, postedBy: userId, createdBy: userId, period: periodId, isAutoGenerated: true, _skipAutoBankSync: Boolean(payrollRun.bank_account_id), bankAccountId: payrollRun.bank_account_id || undefined });
            await PayrollRunService.voidJournalEntriesForRepost(
              companyId,
              "payroll_remit_paye",
              `${payrollRun._id}-paye`,
              "payroll_remit_paye_voided",
              [payeEntry._id],
            );
          }
        } catch (e) { throw e; }
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
            assertJournalBalanced(rssbReversalLines, `RSSB remittance reversal ${payrollRun.reference_no}`);
            await JournalEntry.create({ company: companyId, date: data.reversal_date || new Date(), description: `RSSB Remittance Reversal — ${payrollRun.reference_no}`, sourceType: "payroll_remit_rssb_reversal", sourceId: `${payrollRun._id}-rssb-reversal`, sourceReference: payrollRun.reference_no, reference: payrollRun.reference_no, status: "posted", lines: rssbReversalLines, postedBy: userId, createdBy: userId, period: periodId, isAutoGenerated: true, _skipAutoBankSync: Boolean(payrollRun.bank_account_id), bankAccountId: payrollRun.bank_account_id || undefined });
            await PayrollRunService.voidJournalEntriesForRepost(
              companyId,
              "payroll_remit_rssb",
              `${payrollRun._id}-rssb`,
              "payroll_remit_rssb_voided",
              [rssbEntry._id],
            );
          }
        } catch (e) { throw e; }
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

      // Keep the payroll records linked to this reversed run. Reusing them in
      // another run would break the audit trail and could pay the same record twice.
      await Payroll.updateMany(
        { payroll_run_id: payrollRun._id },
        { record_status: "finalised" },
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
        } catch (btErr) { throw btErr; }
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
        } catch (btErr) { throw btErr; }
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
        } catch (btErr) { throw btErr; }
      }

      await recordPayrollAudit({ companyId, userId, action: "payroll.run.reversed", entityType: "payroll_run", entityId: payrollRun._id, before: beforeRunReverse, after: runSnapshot(payrollRun) });

      return payrollRun;
    } catch (err) {
      throw err;
    }
  }

  // ── REMIT PAYE ──────────────────────────────────────────────────────────
  static async remitPaye(companyId, runId, data, userId) {
    return runInPrismaTransaction(() => this.remitPayeInTransaction(companyId, runId, data, userId));
  }

  static async remitPayeInTransaction(companyId, runId, data, userId) {
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
    if (payrollRun.total_tax > 0 && payrollRun.compliance?.filings?.paye?.status !== "submitted") {
      const error = new Error("Submit and record the PAYE declaration evidence before confirming its payment");
      error.code = "PAYROLL_FILING_EVIDENCE_REQUIRED";
      error.statusCode = 409;
      throw error;
    }
    if (!data.reference_no || !data.evidence_reference) {
      const error = new Error("PAYE payment confirmation requires a bank or authority reference and evidence reference");
      error.code = "PAYROLL_PAYMENT_EVIDENCE_REQUIRED";
      error.statusCode = 400;
      throw error;
    }
    const remittedAt = data.remitted_date ? new Date(data.remitted_date) : new Date();
    if (!Number.isFinite(remittedAt.getTime()) || remittedAt.getTime() > Date.now() + 60000) throw Object.assign(new Error("PAYE remittance date must be valid and cannot be in the future"), { statusCode: 400 });
    const payeEvidenceUrl = validatedEvidenceUrl(data.evidence_url);
    if (sameActor(payrollRun.created_by, userId)) {
      const error = new Error("Payroll remittance must be recorded by a user other than the run preparer");
      error.code = "PAYROLL_APPROVAL_SEPARATION_REQUIRED";
      error.statusCode = 403;
      throw error;
    }
    const beforePayeRemittance = runSnapshot(payrollRun);

    await assertPayrollRunAccruals(companyId, payrollRun);
    const postedRunJournal = payrollRun.journal_entry_id ? await JournalEntry.findById(payrollRun.journal_entry_id) : null;
    if (!postedRunJournal || postedRunJournal.status !== "posted") throw new Error("PAYROLL_RUN_POSTING_JOURNAL_MISSING");
    assertJournalBalanced(postedRunJournal.lines, `Payroll run ${payrollRun.reference_no} posting`);
    const postingBankAccount = await BankAccount.findOne({ _id: payrollRun.bank_account_id, company: companyId });
    if (!postingBankAccount) throw new Error("PAYROLL_BANK_ACCOUNT_NOT_FOUND");
    assertJournalAccount(postedRunJournal, PAYROLL_ACCOUNTS.salaryPayable, payrollRun.total_net, 0, `Payroll run ${payrollRun.reference_no} payment`);
    assertJournalAccount(postedRunJournal, postingBankAccount.ledgerAccountId || PAYROLL_ACCOUNTS.defaultBank, 0, payrollRun.total_net, `Payroll run ${payrollRun.reference_no} payment`);

    if (payrollRun.remittance?.paye?.remitted) {
      throw new Error("PAYE_ALREADY_REMITTED");
    }

    if (data.amount && Math.abs(Number(data.amount) - payrollRun.total_tax) > 0.01) {
      throw new Error("PAYE_REMITTANCE_AMOUNT_MISMATCH");
    }

    if (!payrollRun.remittance) payrollRun.remittance = {};
    payrollRun.remittance.paye = {
      remitted: true,
      remitted_date: remittedAt,
      reference_no: data.reference_no || null,
      amount: data.amount || payrollRun.total_tax,
      payment_confirmed: true,
      evidence_reference: data.evidence_reference,
      evidence_url: payeEvidenceUrl,
      confirmed_by: String(userId),
    };
    payrollRun.markModified('remittance.paye');
    await payrollRun.save();

    try {
      const bankAccount = await BankAccount.findOne({ _id: payrollRun.bank_account_id, company: companyId });
      if (!bankAccount) throw new Error("PAYROLL_BANK_ACCOUNT_NOT_FOUND");
      const periodId = await PeriodService.getOpenPeriodId(companyId, data.remitted_date || new Date());
      const amount = data.amount || payrollRun.total_tax;

      await PayrollRunService.voidJournalEntriesForRepost(
        companyId,
        "payroll_remit_paye",
        `${payrollRun._id}-paye`,
        "payroll_remit_paye_voided",
      );
      const lines = [
        { accountCode: PAYROLL_ACCOUNTS.payePayable, accountName: "PAYE Tax Payable", description: "PAYE remitted to RRA", debit: amount, credit: 0 },
        { accountCode: bankAccount?.ledgerAccountId || PAYROLL_ACCOUNTS.defaultBank, accountName: bankAccount?.name || "Cash at Bank", description: "PAYE remittance payment", debit: 0, credit: amount },
      ];
      assertJournalBalanced(lines, `PAYE remittance ${payrollRun.reference_no}`);
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
        } catch (btErr) { throw btErr; }
      }
    } catch (je) { throw je; }

    await recordPayrollAudit({ companyId, userId, action: "payroll.run.paye_remitted", entityType: "payroll_run", entityId: payrollRun._id, before: beforePayeRemittance, after: runSnapshot(payrollRun) });
    return payrollRun;
  }

  // ── REMIT RSSB ──────────────────────────────────────────────────────────
  static async remitRssb(companyId, runId, data, userId) {
    return runInPrismaTransaction(() => this.remitRssbInTransaction(companyId, runId, data, userId));
  }

  static async remitRssbInTransaction(companyId, runId, data, userId) {
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
    if (payrollRun.compliance?.filings?.rssb?.status !== "submitted") {
      const error = new Error("Submit and record the RSSB declaration evidence before confirming its payment");
      error.code = "PAYROLL_FILING_EVIDENCE_REQUIRED";
      error.statusCode = 409;
      throw error;
    }
    if (!data.reference_no || !data.evidence_reference) {
      const error = new Error("RSSB payment confirmation requires a bank or authority reference and evidence reference");
      error.code = "PAYROLL_PAYMENT_EVIDENCE_REQUIRED";
      error.statusCode = 400;
      throw error;
    }
    const remittedAt = data.remitted_date ? new Date(data.remitted_date) : new Date();
    if (!Number.isFinite(remittedAt.getTime()) || remittedAt.getTime() > Date.now() + 60000) throw Object.assign(new Error("RSSB remittance date must be valid and cannot be in the future"), { statusCode: 400 });
    const rssbEvidenceUrl = validatedEvidenceUrl(data.evidence_url);
    if (sameActor(payrollRun.created_by, userId)) {
      const error = new Error("Payroll remittance must be recorded by a user other than the run preparer");
      error.code = "PAYROLL_APPROVAL_SEPARATION_REQUIRED";
      error.statusCode = 403;
      throw error;
    }
    const beforeRssbRemittance = runSnapshot(payrollRun);

    await assertPayrollRunAccruals(companyId, payrollRun);
    const postedRunJournal = payrollRun.journal_entry_id ? await JournalEntry.findById(payrollRun.journal_entry_id) : null;
    if (!postedRunJournal || postedRunJournal.status !== "posted") throw new Error("PAYROLL_RUN_POSTING_JOURNAL_MISSING");
    assertJournalBalanced(postedRunJournal.lines, `Payroll run ${payrollRun.reference_no} posting`);
    const postingBankAccount = await BankAccount.findOne({ _id: payrollRun.bank_account_id, company: companyId });
    if (!postingBankAccount) throw new Error("PAYROLL_BANK_ACCOUNT_NOT_FOUND");
    assertJournalAccount(postedRunJournal, PAYROLL_ACCOUNTS.salaryPayable, payrollRun.total_net, 0, `Payroll run ${payrollRun.reference_no} payment`);
    assertJournalAccount(postedRunJournal, postingBankAccount.ledgerAccountId || PAYROLL_ACCOUNTS.defaultBank, 0, payrollRun.total_net, `Payroll run ${payrollRun.reference_no} payment`);

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
      remitted_date: remittedAt,
      reference_no: data.reference_no || null,
      amount: data.amount || totalRssb,
      payment_confirmed: true,
      evidence_reference: data.evidence_reference,
      evidence_url: rssbEvidenceUrl,
      confirmed_by: String(userId),
    };
    payrollRun.markModified('remittance.rssb');
    await payrollRun.save();

    try {
      const bankAccount = await BankAccount.findOne({ _id: payrollRun.bank_account_id, company: companyId });
      if (!bankAccount) throw new Error("PAYROLL_BANK_ACCOUNT_NOT_FOUND");
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
        [PAYROLL_ACCOUNTS.employeePensionPayable, "RSSB Employee Pension Payable", rssbEmployeePension],
        [PAYROLL_ACCOUNTS.employeeMaternityPayable, "RSSB Employee Maternity Payable", rssbEmployeeMaternity],
        [PAYROLL_ACCOUNTS.employerPensionPayable, "RSSB Employer Pension Payable", rssbEmployerPension],
        [PAYROLL_ACCOUNTS.employerMaternityPayable, "RSSB Employer Maternity Payable", rssbEmployerMaternity],
        [PAYROLL_ACCOUNTS.occupationalHazardPayable, "Occupational Hazard Payable", totalOccupationalHazard],
      ].forEach(([accountCode, accountName, amount]) => {
        if (amount > 0) {
          lines.push({ accountCode, accountName, description: "RSSB remitted", debit: amount, credit: 0 });
        }
      });
      lines.push({ accountCode: bankAccount?.ledgerAccountId || PAYROLL_ACCOUNTS.defaultBank, accountName: bankAccount?.name || "Cash at Bank", description: "RSSB remittance payment", debit: 0, credit: bankCredit });
      assertJournalBalanced(lines, `RSSB remittance ${payrollRun.reference_no}`);
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
        } catch (btErr) { throw btErr; }
      }
    } catch (je) { throw je; }

    await recordPayrollAudit({ companyId, userId, action: "payroll.run.rssb_remitted", entityType: "payroll_run", entityId: payrollRun._id, before: beforeRssbRemittance, after: runSnapshot(payrollRun) });
    return payrollRun;
  }

  static async confirmBankTransfer(companyId, runId, data, userId) {
    return runInPrismaTransaction(async () => {
      const run = await PayrollRun.findOne({ _id: runId, company: companyId });
      if (!run) throw Object.assign(new Error("NOT_FOUND"), { statusCode: 404 });
      if (run.status !== "posted") throw Object.assign(new Error("PAYROLL_NOT_POSTED"), { statusCode: 409 });
      if (sameActor(run.created_by, userId) || sameActor(run.posted_by, userId)) throw Object.assign(new Error("Salary payment confirmation must be recorded by someone other than the run preparer and poster"), { statusCode: 403, code: "PAYROLL_APPROVAL_SEPARATION_REQUIRED" });
      if (run.bank_transfer?.status === "confirmed") throw Object.assign(new Error("PAYROLL_BANK_PAYMENT_ALREADY_CONFIRMED"), { statusCode: 409 });
      const amount = money(data.amount);
      if (!nearMoney(amount, run.total_net)) throw Object.assign(new Error("PAYROLL_BANK_PAYMENT_AMOUNT_MISMATCH"), { statusCode: 400 });
      if (!String(data.transfer_reference || "").trim() || !String(data.evidence_reference || "").trim()) {
        throw Object.assign(new Error("Bank payment confirmation requires the bank transfer reference and evidence reference"), { statusCode: 400, code: "PAYROLL_PAYMENT_EVIDENCE_REQUIRED" });
      }
      const confirmedAt = data.confirmed_at ? new Date(data.confirmed_at) : new Date();
      if (!Number.isFinite(confirmedAt.getTime()) || confirmedAt.getTime() > Date.now() + 60000) {
        throw Object.assign(new Error("Bank confirmation date must be valid and cannot be in the future"), { statusCode: 400 });
      }
      const evidenceUrl = validatedEvidenceUrl(data.evidence_url);
      const before = runSnapshot(run);
      run.bank_transfer = {
        ...(run.bank_transfer || {}),
        status: "confirmed",
        confirmed_at: confirmedAt,
        confirmed_by: String(userId),
        confirmed_amount: amount,
        transfer_reference: String(data.transfer_reference).trim(),
        bank_statement_reference: String(data.bank_statement_reference || "").trim() || null,
        evidence_reference: String(data.evidence_reference).trim(),
        evidence_url: evidenceUrl,
        notes: String(data.notes || "").trim() || null,
      };
      await run.save();
      await recordPayrollAudit({ companyId, userId, action: "payroll.run.bank_payment_confirmed", entityType: "payroll_run", entityId: run._id, before, after: runSnapshot(run) });
      return run;
    });
  }

  static async generateStatutoryFilingCsv(companyId, runId, type) {
    const filingType = String(type || "").toLowerCase();
    if (!["paye", "rssb"].includes(filingType)) throw Object.assign(new Error("Filing type must be PAYE or RSSB"), { statusCode: 400 });
    const run = await PayrollRun.findOne({ _id: runId, company: companyId });
    if (!run) throw Object.assign(new Error("NOT_FOUND"), { statusCode: 404 });
    if (run.status !== "posted") throw Object.assign(new Error("Only posted payroll runs can be exported for statutory filing"), { statusCode: 409 });
    const payrollIds = (run.lines || []).map((line) => String(line.payroll_id || ""));
    if (!payrollIds.length || payrollIds.some((id) => !id) || new Set(payrollIds).size !== payrollIds.length) {
      throw Object.assign(new Error("Payroll run lines do not contain unique employee payroll records"), { statusCode: 409 });
    }
    const records = await Payroll.find({ company: companyId, _id: { $in: payrollIds }, payroll_run_id: run._id, record_status: { $in: ["paid", "finalised"] } });
    if (records.length !== payrollIds.length) throw Object.assign(new Error("Payroll run employee records are incomplete"), { statusCode: 409 });
    const employeeIds = records.map((record) => record.employee_id).filter(Boolean).map(String);
    const employees = employeeIds.length ? await Employee.find({ company: companyId, _id: { $in: employeeIds } }) : [];
    const employeeById = new Map(employees.map((employee) => [String(employee._id), employee]));
    const missingRegistration = records.filter((record) => {
      const employee = employeeById.get(String(record.employee_id));
      return filingType === "paye" ? !employee?.tinNumber : !employee?.rssbRegistrationNumber;
    });
    if (missingRegistration.length) {
      throw Object.assign(new Error(`${filingType.toUpperCase()} export requires every included employee to have a registered ${filingType === "paye" ? "TIN" : "RSSB number"}; ${missingRegistration.length} record(s) are missing it`), { statusCode: 409, code: "PAYROLL_STATUTORY_ID_MISSING" });
    }
    const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const columns = filingType === "paye"
      ? ["Tax Identification Number", "Employee Number", "Employee Name", "Period Start", "Period End", "Gross Remuneration RWF", "Taxable Income RWF", "PAYE Withheld RWF"]
      : ["RSSB Registration Number", "Employee Number", "Employee Name", "Period Start", "Period End", "Pension Contribution Base RWF", "Employee Pension RWF", "Employee Maternity RWF", "Employer Pension RWF", "Employer Maternity RWF", "Occupational Hazard RWF"];
    const rows = records.map((record) => {
      const employee = employeeById.get(String(record.employee_id)) || {};
      const name = `${record.employee?.firstName || employee.firstName || ""} ${record.employee?.lastName || employee.lastName || ""}`.trim();
      const common = [employee.tinNumber || "", record.employee?.employeeId || employee.employeeId || "", name, run.pay_period_start.toISOString().slice(0, 10), run.pay_period_end.toISOString().slice(0, 10)];
      const values = filingType === "paye"
        ? [...common, money(record.salary?.grossRemuneration ?? record.salary?.grossSalary), money(record.salary?.taxableBase ?? record.salary?.grossRemuneration ?? record.salary?.grossSalary), money(record.deductions?.paye)]
        : [employee.rssbRegistrationNumber || "", ...common.slice(1), money(record.salary?.rssbBases?.pension), money(record.deductions?.rssbEmployeePension), money(record.deductions?.rssbEmployeeMaternity), money(record.contributions?.rssbEmployerPension), money(record.contributions?.rssbEmployerMaternity), money(record.contributions?.occupationalHazard)];
      return values.map(escape).join(",");
    });
    const total = filingType === "paye"
      ? money(records.reduce((sum, record) => sum + Number(record.deductions?.paye || 0), 0))
      : money(records.reduce((sum, record) => sum + Number(record.deductions?.rssbEmployeePension || 0) + Number(record.deductions?.rssbEmployeeMaternity || 0) + Number(record.contributions?.rssbEmployerPension || 0) + Number(record.contributions?.rssbEmployerMaternity || 0) + Number(record.contributions?.occupationalHazard || 0), 0));
    return {
      filename: `${filingType.toUpperCase()}-${run.reference_no}-${new Date(run.pay_period_end).toISOString().slice(0, 7)}.csv`,
      total,
      currency: "RWF",
      due_date: run.compliance?.deadlines?.[filingType] || monthlyStatutoryDeadline(run.pay_period_end),
      csv: `\uFEFF${[columns.map(escape).join(","), ...rows].join("\r\n")}\r\n`,
    };
  }

  static async submitStatutoryFiling(companyId, runId, type, data, userId) {
    return runInPrismaTransaction(async () => {
      const filingType = String(type || "").toLowerCase();
      if (!["paye", "rssb"].includes(filingType)) throw Object.assign(new Error("Filing type must be PAYE or RSSB"), { statusCode: 400 });
      const run = await PayrollRun.findOne({ _id: runId, company: companyId });
      if (!run) throw Object.assign(new Error("NOT_FOUND"), { statusCode: 404 });
      if (run.status !== "posted") throw Object.assign(new Error("Only posted payroll runs can be filed"), { statusCode: 409 });
      const existing = run.compliance?.filings?.[filingType];
      if (existing?.status === "submitted") throw Object.assign(new Error(`${filingType.toUpperCase()} filing is already recorded; reverse or correct it through an amended filing`), { statusCode: 409 });
      if (!String(data.declaration_reference || "").trim() || !String(data.evidence_reference || "").trim()) {
        throw Object.assign(new Error("A declaration reference and evidence reference are required"), { statusCode: 400, code: "PAYROLL_FILING_EVIDENCE_REQUIRED" });
      }
      const submittedAt = data.submitted_at ? new Date(data.submitted_at) : new Date();
      if (!Number.isFinite(submittedAt.getTime()) || submittedAt.getTime() > Date.now() + 60000) throw Object.assign(new Error("Filing date must be valid and cannot be in the future"), { statusCode: 400 });
      const evidenceUrl = validatedEvidenceUrl(data.evidence_url);
      const filingAmount = filingType === "paye" ? money(run.total_tax) : money(run.lines.reduce((sum, line) => sum + (line.rssb_employee_pension || 0) + (line.rssb_employee_maternity || 0) + (line.rssb_employer_pension || 0) + (line.rssb_employer_maternity || 0) + (line.occupational_hazard || 0), 0));
      if (data.amount != null && !nearMoney(data.amount, filingAmount)) throw Object.assign(new Error("Statutory declaration amount does not match payroll run total"), { statusCode: 400 });
      const before = runSnapshot(run);
      run.compliance = {
        ...(run.compliance || {}),
        filings: {
          ...(run.compliance?.filings || {}),
          [filingType]: {
            status: "submitted",
            declaration_reference: String(data.declaration_reference).trim(),
            submitted_at: submittedAt,
            amount: filingAmount,
            evidence_reference: String(data.evidence_reference).trim(),
            evidence_url: evidenceUrl,
            notes: String(data.notes || "").trim() || null,
            submitted_by: String(userId),
          },
        },
      };
      await run.save();
      await recordPayrollAudit({ companyId, userId, action: `payroll.run.${filingType}_filing_submitted`, entityType: "payroll_run", entityId: run._id, before, after: runSnapshot(run) });
      return run;
    });
  }

  static async getComplianceDeadlines(companyId, filters = {}) {
    const runs = await PayrollRun.find({ company: companyId, status: "posted" }).sort({ pay_period_end: -1 }).limit(500);
    const items = [];
    for (const run of runs) {
      const deadlines = buildPayrollDeadlines(run);
      for (const type of ["paye", "rssb"]) {
        for (const stage of ["filing", "payment"]) {
          const entry = deadlines[type];
          const status = stage === "filing" ? entry.filing_status : entry.payment_status;
          items.push({ run_id: String(run._id), reference_no: run.reference_no, type, stage, due_date: entry.due_date, status, amount: type === "paye" ? run.total_tax : money(run.lines.reduce((sum, line) => sum + (line.rssb_employee_total || 0) + (line.rssb_employer_total || 0), 0)) });
        }
      }
      items.push({ run_id: String(run._id), reference_no: run.reference_no, type: "salary", stage: "payment", due_date: deadlines.salary_payment.due_date, status: deadlines.salary_payment.payment_status, amount: run.total_net });
    }
    return items.filter((entry) => (!filters.status || entry.status === filters.status)
      && (!filters.from || entry.due_date >= filters.from)
      && (!filters.to || entry.due_date <= filters.to))
      .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  }

  static async getOperationalExceptions(companyId, filters = {}) {
    const [runs, records] = await Promise.all([
      PayrollRun.find({ company: companyId })
        .sort({ pay_period_end: -1 })
        .limit(500),
      Payroll.find({ company: companyId, record_status: { $in: ["finalised", "paid"] } })
        .sort({ pay_period_end: -1, createdAt: -1 })
        // Prisma HTTP-backed reads enforce a hard 500-row ceiling.
        .limit(500),
    ]);
    const exceptions = [];
    const today = new Date().toISOString().slice(0, 10);
    const dateOnly = (value) => {
      if (!value) return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
    };
    const add = (item) => exceptions.push({
      id: `${item.type}:${item.run_id || item.payroll_id || item.reference_no || exceptions.length}`,
      status: "open",
      ...item,
    });

    for (const run of runs) {
      const runId = String(run._id);
      const reference = run.reference_no || runId;
      const runLines = Array.isArray(run.lines) ? run.lines : [];
      const lineGross = money(runLines.reduce((sum, line) => sum + Number(line.gross_salary || 0), 0));
      const lineNet = money(runLines.reduce((sum, line) => sum + Number(line.net_pay || 0), 0));
      if (run.status === "posted" && !run.journal_entry_id) {
        add({ type: "run_journal_missing", severity: "critical", title: "Posted payroll has no linked journal", description: `${reference} is posted but has no payroll journal reference.`, run_id: runId, reference_no: reference, amount: money(run.total_gross) });
      }
      if (run.status === "posted" && (!nearMoney(run.total_gross, lineGross) || !nearMoney(run.total_net, lineNet))) {
        add({ type: "run_total_mismatch", severity: "critical", title: "Payroll run totals do not match its employee lines", description: `${reference} header totals differ from the sum of its payroll lines.`, run_id: runId, reference_no: reference, amount: money(run.total_net) });
      }
      for (const warning of (Array.isArray(run.warnings) ? run.warnings : [])) {
        add({ type: "run_warning", severity: "warning", title: "Payroll run needs review", description: String(warning), run_id: runId, reference_no: reference, amount: null });
      }
      const paymentDate = dateOnly(run.payment_date);
      if (run.status === "draft" && paymentDate && paymentDate < today) {
        add({ type: "draft_run_past_payment_date", severity: "critical", title: "Draft payroll is past its payment date", description: `${reference} has not been posted and its payment date has passed.`, run_id: runId, reference_no: reference, due_date: paymentDate, amount: money(run.total_net) });
      }
      if (run.status === "posted" && run.bank_transfer?.status !== "confirmed" && paymentDate && paymentDate < today) {
        add({ type: "salary_payment_unconfirmed", severity: "critical", title: "Salary payment is past due and unconfirmed", description: `${reference} has no recorded bank payment confirmation.`, run_id: runId, reference_no: reference, due_date: paymentDate, amount: money(run.total_net) });
      }
    }

    const payrollIds = records.map((record) => String(record._id));
    const salaryEntries = payrollIds.length ? await JournalEntry.find({
      company: companyId,
      sourceType: "payroll_salary",
      sourceId: { $in: payrollIds },
      status: "posted",
    }) : [];
    const accruedPayrollIds = new Set(salaryEntries.map((entry) => String(entry.sourceId)));
    for (const record of records) {
      const id = String(record._id);
      const name = `${record.employee?.firstName || ""} ${record.employee?.lastName || ""}`.trim() || record.employee?.employeeId || id;
      if (!record.employee_id) {
        add({ type: "employee_master_link_missing", severity: "warning", title: "Payroll record is not linked to an employee profile", description: `${name} (${record.period?.monthName || record.period?.month || ""} ${record.period?.year || ""}) has no employee master link.`, payroll_id: id, employee_name: name, amount: money(record.salary?.grossSalary) });
      }
      if (money(record.salary?.grossSalary) > 0 && !accruedPayrollIds.has(id)) {
        add({ type: "employee_accrual_missing", severity: "critical", title: "Finalized payroll is missing its posted accrual", description: `${name} has no posted payroll salary accrual journal.`, payroll_id: id, employee_name: name, run_id: record.payroll_run_id ? String(record.payroll_run_id) : null, amount: money(record.salary?.grossSalary) });
      }
    }

    const overdue = await this.getComplianceDeadlines(companyId, { status: "overdue" });
    for (const item of overdue) {
      add({
        type: `${item.type}_${item.stage}_overdue`,
        severity: "critical",
        title: `${item.type.toUpperCase()} ${item.stage} is overdue`,
        description: `${item.reference_no} ${item.type.toUpperCase()} ${item.stage} deadline passed without a recorded completion.`,
        run_id: item.run_id,
        reference_no: item.reference_no,
        due_date: item.due_date,
        amount: money(item.amount),
      });
    }

    const filtered = exceptions.filter((item) =>
      (!filters.severity || item.severity === String(filters.severity))
      && (!filters.type || item.type === String(filters.type))
      && (!filters.from || !item.due_date || item.due_date >= String(filters.from))
      && (!filters.to || !item.due_date || item.due_date <= String(filters.to))
    ).sort((a, b) => {
      const rank = { critical: 0, warning: 1, info: 2 };
      return (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3)
        || String(a.due_date || "9999-12-31").localeCompare(String(b.due_date || "9999-12-31"));
    });
    const requestedLimit = Number.parseInt(filters.limit, 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, requestedLimit)) : 200;
    const items = filtered.slice(0, limit);
    return {
      generated_at: new Date().toISOString(),
      total: filtered.length,
      summary: {
        critical: filtered.filter((item) => item.severity === "critical").length,
        warning: filtered.filter((item) => item.severity === "warning").length,
        overdue: filtered.filter((item) => item.type.endsWith("_overdue") || item.type === "salary_payment_unconfirmed").length,
      },
      items,
    };
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
