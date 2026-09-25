/**
 * Annual Reports Service
 *
 * All ten annual reports read directly from the PostgreSQL Prisma schema. The
 * report layer deliberately does not import the legacy model facades: report
 * queries need the real column names, relations, JSON fields, and database-side
 * aggregation semantics rather than a Mongo-shaped compatibility surface.
 */

const { dbClient } = require('../lib/prisma');
const { toIdString } = require('../utils/objectId');

const REPORT_BATCH_SIZE = Math.min(2000, Math.max(100, Number(process.env.REPORT_BATCH_SIZE) || 500));

const REVENUE_STATUSES = ['fully_paid', 'partially_paid', 'confirmed', 'sent'];
const RECEIVABLE_STATUSES = ['confirmed', 'sent', 'partially_paid', 'overdue'];
const PURCHASE_STATUSES = ['received', 'partially_received', 'confirmed', 'partial', 'paid'];
const PAYROLL_STATUSES = ['processed', 'paid', 'approved', 'posted'];
const CREDIT_NOTE_STATUSES = ['confirmed', 'issued', 'applied', 'partially_refunded', 'refunded'];
const STOCK_OUT_REASONS = ['sale', 'dispatch'];

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === 'object') {
    if (value.$numberDecimal !== undefined) return toNumber(value.$numberDecimal);
    if (typeof value.toString === 'function') {
      const parsed = Number(value.toString());
      return Number.isFinite(parsed) ? parsed : 0;
    }
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function jsonObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function getYearRange(year) {
  const start = new Date(year, 0, 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(year, 11, 31);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function getPriorYearRange(year) {
  const priorYear = year - 1;
  const { start, end } = getYearRange(priorYear);
  return { start, end, year: priorYear };
}

function getMonthName(month) {
  return [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ][month - 1];
}

function getMonthsInYear(year) {
  return Array.from({ length: 12 }, (_, index) => ({ year, month: index + 1 }));
}

/**
 * Page a direct Prisma delegate. Every page has a deterministic order and an
 * explicit take, so report inputs remain bounded without falling back to a
 * Mongoose-compatible query executor.
 */
async function findAllPaged(delegate, args = {}) {
  const { take: _ignoredTake, skip: _ignoredSkip, ...baseArgs } = args;
  const rows = [];
  let skip = 0;

  for (;;) {
    const page = await delegate.findMany({
      ...baseArgs,
      orderBy: baseArgs.orderBy || { id: 'asc' },
      skip,
      take: REPORT_BATCH_SIZE,
    });
    rows.push(...page);
    if (page.length < REPORT_BATCH_SIZE) return rows;
    skip += page.length;
  }
}

async function getCompany(companyId) {
  return dbClient().company.findUnique({
    where: { id: toIdString(companyId) },
    select: {
      id: true,
      name: true,
      taxIdentificationNumber: true,
      address: true,
    },
  });
}

function companyTin(company) {
  return company?.taxIdentificationNumber || company?.tin || 'N/A';
}

function formatAddress(address) {
  if (!address) return 'N/A';
  if (typeof address === 'string') return address;
  const parts = ['street', 'city', 'state', 'postcode', 'country']
    .map((key) => address[key])
    .filter(Boolean);
  return parts.length ? parts.join(', ') : 'N/A';
}

function sumLines(lines, selector) {
  return lines.reduce((sum, line) => sum + toNumber(selector(line)), 0);
}

/** Direct Prisma equivalent of journal_entry_lines grouped by a safe column. */
async function journalLineTotals(companyId, options = {}) {
  const cid = toIdString(companyId);
  if (!cid) return [];

  const {
    dateFrom = null,
    dateTo = null,
    status = null,
    statuses = null,
    accountCodes = null,
    accountIds = null,
    groupBy = 'accountCode',
    withCount = false,
  } = options;

  const where = {
    companyId: cid,
    journalEntry: {
      companyId: cid,
      ...(status ? { status } : {}),
      ...(statuses ? { status: { in: statuses } } : {}),
      ...(dateFrom || dateTo
        ? { date: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } }
        : {}),
    },
    ...(accountCodes ? { accountCode: { in: accountCodes.map(String) } } : {}),
    ...(accountIds ? { accountId: { in: accountIds.map(String) } } : {}),
  };

  if (groupBy) {
    const rows = await dbClient().journalEntryLine.groupBy({
      by: [groupBy],
      where,
      _sum: { debit: true, credit: true },
      ...(withCount ? { _count: { _all: true } } : {}),
    });
    return rows.map((row) => ({
      _id: row[groupBy] ?? null,
      accountCode: row.accountCode ?? null,
      accountName: row.accountName ?? null,
      accountId: row.accountId ?? null,
      debit: toNumber(row._sum?.debit),
      credit: toNumber(row._sum?.credit),
      count: withCount ? Number(row._count?._all || 0) : undefined,
    }));
  }

  const row = await dbClient().journalEntryLine.aggregate({
    where,
    _sum: { debit: true, credit: true },
    _count: { _all: true },
  });
  const debit = toNumber(row._sum?.debit);
  const credit = toNumber(row._sum?.credit);
  if (!debit && !credit && !row._count?._all) return [];
  return [{ debit, credit, count: Number(row._count?._all || 0), _id: null }];
}

async function accountTotalsForPatterns(companyId, start, end, patterns) {
  const cid = toIdString(companyId);
  const or = patterns.flatMap((pattern) => [
    { name: { contains: pattern, mode: 'insensitive' } },
    { code: { contains: pattern, mode: 'insensitive' } },
  ]);
  const accounts = await dbClient().chartOfAccount.findMany({
    where: { companyId: cid, OR: or },
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  });
  if (!accounts.length) return 0;

  const rows = await journalLineTotals(cid, {
    dateFrom: start,
    dateTo: end,
    status: 'posted',
    accountCodes: accounts.map((account) => account.code),
    groupBy: null,
  });
  return toNumber(rows[0]?.debit);
}

async function productQuantitiesAtDate(companyId, date) {
  const rows = await dbClient().$queryRaw`
    SELECT product_id AS "productId",
           COALESCE(SUM(CASE WHEN type = 'in' THEN quantity ELSE -quantity END), 0)::float AS "netQty"
    FROM stock_movements
    WHERE company_id = ${toIdString(companyId)}
      AND movement_date <= ${date}
      AND product_id IS NOT NULL
    GROUP BY product_id
  `;
  return new Map(rows.map((row) => [String(row.productId), toNumber(row.netQty)]));
}

async function productPurchaseAggregates(companyId, start, end) {
  const rows = await dbClient().$queryRaw`
    SELECT pl.product_id AS "productId",
           COALESCE(SUM(pl.qty), 0)::float AS "totalQty",
           COALESCE(SUM(pl.qty * pl.unit_cost), 0)::float AS "totalCost"
    FROM purchase_lines pl
    INNER JOIN purchases p ON p.id = pl.purchase_id
    WHERE p.company_id = ${toIdString(companyId)}
      AND p.purchase_date >= ${start}
      AND p.purchase_date <= ${end}
      AND p.status IN ('received', 'partially_received', 'confirmed', 'partial', 'paid')
    GROUP BY pl.product_id
  `;
  return new Map(rows.map((row) => [String(row.productId), row]));
}

async function productCogsAggregates(companyId, start, end) {
  const rows = await dbClient().$queryRaw`
    SELECT product_id AS "productId",
           COALESCE(SUM(quantity), 0)::float AS "totalQty",
           COALESCE(SUM(quantity * unit_cost), 0)::float AS "totalCost"
    FROM stock_movements
    WHERE company_id = ${toIdString(companyId)}
      AND movement_date >= ${start}
      AND movement_date <= ${end}
      AND type = 'out'
      AND reason IN ('sale', 'dispatch')
      AND product_id IS NOT NULL
    GROUP BY product_id
  `;
  return new Map(rows.map((row) => [String(row.productId), row]));
}

function payrollComponents(payroll) {
  const salary = jsonObject(payroll?.salary);
  const deductions = jsonObject(payroll?.deductions);
  const contributions = jsonObject(payroll?.contributions);
  const grossSalary = toNumber(
    salary.grossSalary
      ?? salary.grossPay
      ?? (toNumber(salary.basicSalary)
        + toNumber(salary.transportAllowance)
        + toNumber(salary.housingAllowance)
        + toNumber(salary.otherAllowances)),
  );
  const employeeRSSB = toNumber(deductions.rssbEmployeePension) + toNumber(deductions.rssbEmployeeMaternity);
  const employerRSSB = toNumber(contributions.rssbEmployerPension)
    + toNumber(contributions.rssbEmployerMaternity)
    + toNumber(contributions.occupationalHazard);
  const otherBenefits = toNumber(salary.transportAllowance)
    + toNumber(salary.housingAllowance)
    + toNumber(salary.otherAllowances);

  return {
    grossSalary,
    paye: toNumber(deductions.paye),
    employeeRSSB,
    employerRSSB,
    otherBenefits,
    netPay: toNumber(payroll?.netPay),
    totalDeductions: toNumber(deductions.totalDeductions),
    employee: jsonObject(payroll?.employee),
    salary,
    deductions,
    contributions,
    directAmount: toNumber(jsonObject(payroll?.laborAllocation).directAmount),
    indirectAmount: toNumber(jsonObject(payroll?.laborAllocation).indirectAmount),
  };
}

function payrollRunLineComponents(run) {
  const lines = jsonArray(run?.lines);
  return lines.reduce((totals, line) => {
    totals.grossSalary += toNumber(line.gross_salary ?? line.grossSalary);
    totals.paye += toNumber(line.tax_deduction ?? line.taxDeduction);
    totals.employeeRSSB += toNumber(line.rssb_employee_total)
      || (toNumber(line.rssb_employee_pension) + toNumber(line.rssb_employee_maternity));
    totals.employerRSSB += toNumber(line.rssb_employer_total)
      || (toNumber(line.rssb_employer_pension) + toNumber(line.rssb_employer_maternity) + toNumber(line.occupational_hazard));
    totals.netPay += toNumber(line.net_pay ?? line.netPay);
    return totals;
  }, { grossSalary: 0, paye: 0, employeeRSSB: 0, employerRSSB: 0, netPay: 0 });
}

function payrollRunTotals(run, records) {
  const recordTotals = records.reduce((totals, payroll) => {
    const values = payrollComponents(payroll);
    totals.grossSalary += values.grossSalary;
    totals.paye += values.paye;
    totals.employeeRSSB += values.employeeRSSB;
    totals.employerRSSB += values.employerRSSB;
    totals.netPay += values.netPay;
    return totals;
  }, { grossSalary: 0, paye: 0, employeeRSSB: 0, employerRSSB: 0, netPay: 0 });
  const lineTotals = payrollRunLineComponents(run);
  const useLines = records.length === 0;
  return {
    grossSalary: useLines ? (lineTotals.grossSalary || toNumber(run.totalGross)) : recordTotals.grossSalary,
    paye: useLines ? (lineTotals.paye || toNumber(run.totalTax)) : (recordTotals.paye || toNumber(run.totalTax)),
    employeeRSSB: useLines ? lineTotals.employeeRSSB : recordTotals.employeeRSSB,
    employerRSSB: useLines ? lineTotals.employerRSSB : recordTotals.employerRSSB,
    netPay: useLines ? (lineTotals.netPay || toNumber(run.totalNet)) : (recordTotals.netPay || toNumber(run.totalNet)),
  };
}

async function loadPayrollPeriod(companyId, start, end) {
  const cid = toIdString(companyId);
  const payrollRuns = await findAllPaged(dbClient().payrollRun, {
    where: {
      companyId: cid,
      // These are the actual PostgreSQL columns. The previous report used the
      // removed Mongo aliases periodStart/periodEnd and returned no rows.
      payPeriodStart: { gte: start },
      payPeriodEnd: { lte: end },
      status: { in: PAYROLL_STATUSES },
    },
    select: {
      id: true,
      referenceNo: true,
      payPeriodStart: true,
      payPeriodEnd: true,
      paymentDate: true,
      status: true,
      totalGross: true,
      totalTax: true,
      totalNet: true,
      employeeCount: true,
      lines: true,
    },
    orderBy: [{ payPeriodStart: 'asc' }, { id: 'asc' }],
  });

  const runIds = payrollRuns.map((run) => run.id);
  const payrolls = runIds.length
    ? await findAllPaged(dbClient().payroll, {
        where: { companyId: cid, payrollRunId: { in: runIds } },
        include: {
          employeeMaster: {
            select: { id: true, employeeId: true, firstName: true, lastName: true, department: true },
          },
        },
        orderBy: [{ payPeriodStart: 'asc' }, { id: 'asc' }],
      })
    : [];

  const byRun = new Map();
  for (const payroll of payrolls) {
    const list = byRun.get(payroll.payrollRunId) || [];
    list.push(payroll);
    byRun.set(payroll.payrollRunId, list);
  }
  return { payrollRuns, payrolls, byRun };
}

class AnnualReportsService {
  /** 1. Annual Financial Statements. */
  static async getFinancialStatements(companyId, year) {
    const { start, end } = getYearRange(year);
    const prior = getPriorYearRange(year);
    const company = await getCompany(companyId);
    const cid = toIdString(companyId);

    const [revenueCurrent, revenuePrior, fixedAssetsCurrent] = await Promise.all([
      dbClient().invoice.aggregate({
        where: { companyId: cid, invoiceDate: { gte: start, lte: end }, status: { in: REVENUE_STATUSES } },
        _sum: { subtotal: true },
      }),
      dbClient().invoice.aggregate({
        where: { companyId: cid, invoiceDate: { gte: prior.start, lte: prior.end }, status: { in: REVENUE_STATUSES } },
        _sum: { subtotal: true },
      }),
      dbClient().fixedAsset.aggregate({
        where: { companyId: cid, status: { in: ['active', 'in_use'] } },
        _sum: { purchaseCost: true, accumulatedDepreciation: true },
      }),
    ]);

    const [cogsCurrent, cogsPrior, expensesCurrent, expensesPrior,
      depreciationCurrent, depreciationPrior, interestCurrent, interestPrior,
      taxCurrent, taxPrior] = await Promise.all([
      this._calculateAnnualCOGS(cid, start, end),
      this._calculateAnnualCOGS(cid, prior.start, prior.end),
      this._getAnnualExpensesByCategory(cid, start, end),
      this._getAnnualExpensesByCategory(cid, prior.start, prior.end),
      this._getAnnualAccountTotal(cid, start, end, ['depreciation', 'accumulated_depreciation']),
      this._getAnnualAccountTotal(cid, prior.start, prior.end, ['depreciation', 'accumulated_depreciation']),
      this._getAnnualAccountTotal(cid, start, end, ['interest', 'interest_expense']),
      this._getAnnualAccountTotal(cid, prior.start, prior.end, ['interest', 'interest_expense']),
      this._getAnnualAccountTotal(cid, start, end, ['tax', 'income_tax', 'tax_expense']),
      this._getAnnualAccountTotal(cid, prior.start, prior.end, ['tax', 'income_tax', 'tax_expense']),
    ]);

    const revCurrent = toNumber(revenueCurrent._sum?.subtotal);
    const revPrior = toNumber(revenuePrior._sum?.subtotal);
    const grossProfitCurrent = revCurrent - cogsCurrent;
    const grossProfitPrior = revPrior - cogsPrior;
    const totalOpExCurrent = sumLines(expensesCurrent, (expense) => expense.amount) + depreciationCurrent;
    const totalOpExPrior = sumLines(expensesPrior, (expense) => expense.amount) + depreciationPrior;
    const operatingProfitCurrent = grossProfitCurrent - totalOpExCurrent;
    const operatingProfitPrior = grossProfitPrior - totalOpExPrior;
    const profitBeforeTaxCurrent = operatingProfitCurrent - interestCurrent;
    const profitBeforeTaxPrior = operatingProfitPrior - interestPrior;
    const netProfitCurrent = profitBeforeTaxCurrent - taxCurrent;
    const netProfitPrior = profitBeforeTaxPrior - taxPrior;

    const [inventoryValue, arValue, bankBalance, apValue, loansPayable,
      priorInventoryValue, priorARValue, priorBankBalance, priorAPValue, cashFlow] = await Promise.all([
      this._getInventoryValue(cid, end),
      this._getAccountsReceivable(cid, end),
      this._getBankBalance(cid, end),
      this._getAccountsPayable(cid, end),
      this._getLoansPayable(cid, end),
      this._getInventoryValue(cid, prior.end),
      this._getAccountsReceivable(cid, prior.end),
      this._getBankBalance(cid, prior.end),
      this._getAccountsPayable(cid, prior.end),
      this._calculateCashFlow(cid, year, start, end),
    ]);

    const fixedAssetCost = toNumber(fixedAssetsCurrent._sum?.purchaseCost);
    const fixedAssetDepreciation = toNumber(fixedAssetsCurrent._sum?.accumulatedDepreciation);
    const totalAssets = fixedAssetCost - fixedAssetDepreciation + inventoryValue + arValue + bankBalance;
    const totalLiabilities = apValue + loansPayable;
    const equity = totalAssets - totalLiabilities;
    // Keep these explicit so callers can inspect the comparative calculation in
    // a debugger without changing the established response shape.
    void priorInventoryValue;
    void priorARValue;
    void priorBankBalance;
    void priorAPValue;

    return {
      reportName: 'Annual Financial Statements',
      company: { name: company?.name || 'Company', tin: companyTin(company), address: formatAddress(company?.address) },
      year,
      priorYear: prior.year,
      period: `Year Ended December 31, ${year}`,
      generatedAt: new Date().toISOString(),
      incomeStatement: {
        revenue: { current: revCurrent, prior: revPrior },
        costOfGoodsSold: { current: cogsCurrent, prior: cogsPrior },
        grossProfit: { current: grossProfitCurrent, prior: grossProfitPrior },
        operatingExpenses: {
          categories: expensesCurrent.map((expense) => ({
            name: expense.category,
            current: expense.amount,
            prior: expensesPrior.find((item) => item.category === expense.category)?.amount || 0,
          })),
          depreciation: { current: depreciationCurrent, prior: depreciationPrior },
          total: { current: totalOpExCurrent, prior: totalOpExPrior },
        },
        operatingProfit: { current: operatingProfitCurrent, prior: operatingProfitPrior },
        interestExpense: { current: interestCurrent, prior: interestPrior },
        profitBeforeTax: { current: profitBeforeTaxCurrent, prior: profitBeforeTaxPrior },
        taxExpense: { current: taxCurrent, prior: taxPrior },
        netProfit: { current: netProfitCurrent, prior: netProfitPrior },
      },
      balanceSheet: {
        assets: {
          nonCurrent: { propertyPlantEquipment: fixedAssetCost - fixedAssetDepreciation, totalNonCurrent: fixedAssetCost - fixedAssetDepreciation },
          current: { inventory: inventoryValue, accountsReceivable: arValue, cashAndBank: bankBalance, totalCurrent: inventoryValue + arValue + bankBalance },
          totalAssets,
        },
        liabilities: {
          current: { accountsPayable: apValue, shortTermLoans: loansPayable * 0.3, totalCurrent: apValue + loansPayable * 0.3 },
          nonCurrent: { longTermLoans: loansPayable * 0.7, totalNonCurrent: loansPayable * 0.7 },
          totalLiabilities,
        },
        equity: { shareCapital: equity > 0 ? equity * 0.3 : 0, retainedEarnings: equity > 0 ? equity * 0.7 : 0, totalEquity: equity },
        totalLiabilitiesAndEquity: totalLiabilities + equity,
      },
      cashFlow: {
        operating: cashFlow.operating,
        investing: cashFlow.investing,
        financing: cashFlow.financing,
        netIncrease: cashFlow.netIncrease,
        beginningCash: cashFlow.beginningCash,
        endingCash: cashFlow.endingCash,
      },
    };
  }

  /** 2. Annual General Ledger. */
  static async getGeneralLedger(companyId, year) {
    const { start, end } = getYearRange(year);
    const cid = toIdString(companyId);
    const [accounts, lines] = await Promise.all([
      findAllPaged(dbClient().chartOfAccount, {
        where: { companyId: cid },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
      }),
      findAllPaged(dbClient().journalEntryLine, {
        where: {
          companyId: cid,
          journalEntry: {
            companyId: cid,
            date: { gte: start, lte: end },
            status: { in: ['posted'] },
          },
        },
        include: {
          journalEntry: {
            select: { id: true, entryNumber: true, date: true, description: true, reference: true },
          },
        },
        orderBy: [{ journalEntryId: 'asc' }, { lineOrder: 'asc' }, { id: 'asc' }],
      }),
    ]);

    const accountById = new Map(accounts.map((account) => [String(account.id), account]));
    const accountByCode = new Map(accounts.map((account) => [String(account.code).trim(), account]));
    const ledgerByAccount = {};

    for (const account of accounts) {
      ledgerByAccount[account.id] = {
        accountId: account.id,
        accountCode: account.code,
        accountName: account.name,
        accountType: account.type,
        openingBalance: 0,
        entries: [],
        closingBalance: 0,
      };
    }

    for (const line of lines) {
      // Journal lines are keyed by accountCode/accountName. accountId is
      // optional on migrated rows, so code is the required fallback.
      const account = (line.accountId && accountById.get(String(line.accountId)))
        || accountByCode.get(String(line.accountCode).trim());
      if (!account || !line.journalEntry) continue;
      const bucket = ledgerByAccount[account.id];
      bucket.entries.push({
        date: line.journalEntry.date,
        entryNumber: line.journalEntry.entryNumber,
        description: line.journalEntry.description,
        reference: line.journalEntry.reference,
        debit: toNumber(line.debit),
        credit: toNumber(line.credit),
        balance: 0,
        lineOrder: line.lineOrder,
        journalEntryId: line.journalEntryId,
      });
    }

    for (const account of Object.values(ledgerByAccount)) {
      account.entries.sort((a, b) => (
        new Date(a.date) - new Date(b.date)
        || String(a.entryNumber).localeCompare(String(b.entryNumber))
        || a.lineOrder - b.lineOrder
        || String(a.journalEntryId).localeCompare(String(b.journalEntryId))
      ));
      let runningBalance = 0;
      for (const entry of account.entries) {
        runningBalance += ['asset', 'expense', 'cogs'].includes(account.accountType)
          ? entry.debit - entry.credit
          : entry.credit - entry.debit;
        entry.balance = runningBalance;
      }
      account.closingBalance = runningBalance;
      account.totalDebits = sumLines(account.entries, (entry) => entry.debit);
      account.totalCredits = sumLines(account.entries, (entry) => entry.credit);
    }

    const allTransactions = Object.values(ledgerByAccount).flatMap((account) => account.entries.map((entry) => ({
      date: entry.date,
      accountCode: account.accountCode,
      accountName: account.accountName,
      accountType: account.accountType,
      entryNumber: entry.entryNumber,
      description: entry.description,
      reference: entry.reference,
      debit: entry.debit,
      credit: entry.credit,
      balance: entry.balance,
    })));

    return {
      reportName: 'Annual General Ledger',
      period: `Year Ended December 31, ${year}`,
      year,
      companyId,
      accounts: Object.values(ledgerByAccount),
      transactions: allTransactions,
      summary: {
        totalAccounts: accounts.length,
        totalTransactions: allTransactions.length,
        totalDebits: sumLines(allTransactions, (entry) => entry.debit),
        totalCredits: sumLines(allTransactions, (entry) => entry.credit),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /** 3. Annual Fixed Asset Schedule. */
  static async getFixedAssetSchedule(companyId, year) {
    const { start, end } = getYearRange(year);
    const priorYearEnd = new Date(year - 1, 11, 31, 23, 59, 59, 999);
    const cid = toIdString(companyId);
    const [categories, assets] = await Promise.all([
      findAllPaged(dbClient().assetCategory, { where: { companyId: cid }, orderBy: { name: 'asc' } }),
      findAllPaged(dbClient().fixedAsset, {
        where: { companyId: cid },
        include: { category: { select: { id: true, name: true, categoryCode: true } } },
        orderBy: [{ purchaseDate: 'asc' }, { id: 'asc' }],
      }),
    ]);

    const scheduleByCategory = categories.map((category) => {
      const categoryAssets = assets.filter((asset) => String(asset.categoryId || '') === String(category.id));
      const openingBookValue = sumLines(categoryAssets, (asset) => {
        const purchaseDate = new Date(asset.purchaseDate);
        if (purchaseDate >= start) return 0;
        const cost = toNumber(asset.purchaseCost);
        const annualDepreciation = cost * toNumber(asset.decliningRate || 0.1);
        const yearsOwned = Math.max(0, (priorYearEnd - purchaseDate) / (365 * 24 * 60 * 60 * 1000));
        return cost - annualDepreciation * yearsOwned;
      });
      const additions = sumLines(categoryAssets.filter((asset) => {
        const date = new Date(asset.purchaseDate);
        return date >= start && date <= end;
      }), (asset) => asset.purchaseCost);
      const disposals = sumLines(categoryAssets.filter((asset) => {
        const date = asset.disposalDate ? new Date(asset.disposalDate) : null;
        return date && date >= start && date <= end;
      }), (asset) => asset.disposalProceeds);
      const depreciationCharged = sumLines(categoryAssets, (asset) => {
        const purchaseDate = new Date(asset.purchaseDate);
        const disposalDate = asset.disposalDate ? new Date(asset.disposalDate) : null;
        if (purchaseDate > end || (disposalDate && disposalDate < start)) return 0;
        const annual = toNumber(asset.purchaseCost) * toNumber(asset.decliningRate || 0.1);
        if (purchaseDate > start) return annual * (12 - purchaseDate.getMonth()) / 12;
        if (disposalDate && disposalDate < end) return annual * (disposalDate.getMonth() + 1) / 12;
        return annual;
      });
      const assetDetails = categoryAssets.map((asset) => ({
        assetId: asset.id,
        assetCode: asset.referenceNo || asset.id,
        description: asset.description || asset.name,
        purchaseDate: asset.purchaseDate,
        purchaseCost: toNumber(asset.purchaseCost),
        depreciationRate: toNumber(asset.decliningRate || 0.1),
        accumulatedDepreciation: toNumber(asset.accumulatedDepreciation),
        bookValue: toNumber(asset.purchaseCost) - toNumber(asset.accumulatedDepreciation),
        status: asset.status,
      }));
      return {
        categoryId: category.id,
        categoryCode: category.categoryCode,
        categoryName: category.name,
        openingBookValue,
        additions,
        disposals,
        depreciationCharged,
        closingBookValue: openingBookValue + additions - disposals - depreciationCharged,
        assetCount: categoryAssets.length,
        assets: assetDetails,
      };
    });

    return {
      reportName: 'Annual Fixed Asset Schedule',
      period: `Year Ended December 31, ${year}`,
      year,
      companyId,
      categories: scheduleByCategory,
      totals: {
        openingBookValue: sumLines(scheduleByCategory, (item) => item.openingBookValue),
        additions: sumLines(scheduleByCategory, (item) => item.additions),
        disposals: sumLines(scheduleByCategory, (item) => item.disposals),
        depreciationCharged: sumLines(scheduleByCategory, (item) => item.depreciationCharged),
        closingBookValue: sumLines(scheduleByCategory, (item) => item.closingBookValue),
        totalAssets: assets.length,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /** 4. Annual Inventory Valuation and Reconciliation. */
  static async getInventoryReconciliation(companyId, year) {
    const { start, end } = getYearRange(year);
    const priorYearEnd = new Date(year - 1, 11, 31, 23, 59, 59, 999);
    const cid = toIdString(companyId);
    const products = await findAllPaged(dbClient().product, {
      where: { companyId: cid, isStockable: true },
      include: { category: { select: { id: true, name: true } } },
      orderBy: [{ sku: 'asc' }, { id: 'asc' }],
    });

    const [openingQuantities, closingQuantities, purchaseByProduct, cogsByProduct,
      purchases, stockOutMovements, adjustments] = await Promise.all([
      productQuantitiesAtDate(cid, priorYearEnd),
      productQuantitiesAtDate(cid, end),
      productPurchaseAggregates(cid, start, end),
      productCogsAggregates(cid, start, end),
      dbClient().purchase.aggregate({
        where: { companyId: cid, purchaseDate: { gte: start, lte: end }, status: { in: PURCHASE_STATUSES } },
        _sum: { subtotal: true },
      }),
      dbClient().$queryRaw`
        SELECT COALESCE(SUM(quantity * unit_cost), 0)::float AS total
        FROM stock_movements
        WHERE company_id = ${cid}
          AND movement_date >= ${start} AND movement_date <= ${end}
          AND type = 'out' AND reason IN ('sale', 'dispatch')
      `,
      dbClient().$queryRaw`
        SELECT COALESCE(SUM(quantity * unit_cost), 0)::float AS total
        FROM stock_movements
        WHERE company_id = ${cid}
          AND movement_date >= ${start} AND movement_date <= ${end}
          AND (type = 'adjustment' OR reason IN ('damage', 'expired'))
      `,
    ]);

    const openingStock = products.reduce((sum, product) => {
      const quantity = openingQuantities.get(String(product.id)) || 0;
      return sum + quantity * toNumber(product.averageCost);
    }, 0);
    const closingStock = products.reduce((sum, product) => {
      const quantity = closingQuantities.get(String(product.id)) || 0;
      return sum + quantity * toNumber(product.averageCost);
    }, 0);
    const totalPurchases = toNumber(purchases._sum?.subtotal);
    const cogs = toNumber(stockOutMovements[0]?.total);
    const totalAdjustments = toNumber(adjustments[0]?.total);
    const calculatedClosing = openingStock + totalPurchases - cogs - totalAdjustments;

    const productDetails = products.map((product) => {
      const productId = String(product.id);
      const openingQty = openingQuantities.get(productId) || 0;
      const closingQty = closingQuantities.get(productId) || 0;
      const purchase = purchaseByProduct.get(productId) || {};
      const productCogs = cogsByProduct.get(productId) || {};
      const unitCost = toNumber(product.averageCost);
      return {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        category: product.category ? { _id: product.category.id, name: product.category.name } : product.categoryId,
        openingQty,
        openingValue: openingQty * unitCost,
        purchasesQty: toNumber(purchase.totalQty),
        purchasesValue: toNumber(purchase.totalCost),
        cogsQty: toNumber(productCogs.totalQty),
        cogsValue: toNumber(productCogs.totalCost),
        closingQty,
        closingValue: closingQty * unitCost,
        unitCost,
      };
    });

    return {
      reportName: 'Annual Inventory Valuation and Reconciliation',
      period: `Year Ended December 31, ${year}`,
      year,
      companyId,
      summary: {
        openingStock,
        totalPurchases,
        costOfGoodsSold: cogs,
        adjustments: totalAdjustments,
        calculatedClosing,
        actualClosing: closingStock,
        reconciliationDifference: Math.abs(closingStock - calculatedClosing),
        isReconciled: Math.abs(closingStock - calculatedClosing) < 1,
      },
      products: productDetails,
      generatedAt: new Date().toISOString(),
    };
  }

  /** 5. Annual Accounts Receivable Summary. */
  static async getAccountsReceivableSummary(companyId, year) {
    const { start, end } = getYearRange(year);
    const cid = toIdString(companyId);
    const [clients, creditSales, cashCollected, badDebts, outstanding] = await Promise.all([
      findAllPaged(dbClient().client, {
        where: { companyId: cid },
        select: { id: true, name: true, code: true, taxId: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      dbClient().invoice.groupBy({
        by: ['clientId'],
        where: { companyId: cid, invoiceDate: { gte: start, lte: end }, status: { in: [...REVENUE_STATUSES, 'overdue'] } },
        _sum: { subtotal: true },
        _count: { _all: true },
      }),
      dbClient().aRReceipt.groupBy({
        by: ['clientId'],
        where: { companyId: cid, receiptDate: { gte: start, lte: end }, status: 'posted' },
        _sum: { amountReceived: true },
        _count: { _all: true },
      }),
      dbClient().invoice.groupBy({
        by: ['clientId'],
        where: { companyId: cid, invoiceDate: { gte: start, lte: end }, status: { in: ['written_off', 'cancelled'] } },
        _sum: { totalAmount: true },
      }),
      dbClient().invoice.groupBy({
        by: ['clientId'],
        where: { companyId: cid, invoiceDate: { lte: end }, status: { in: RECEIVABLE_STATUSES } },
        _sum: { amountOutstanding: true },
      }),
    ]);

    const byClient = (rows) => new Map(rows.map((row) => [String(row.clientId), row]));
    const salesMap = byClient(creditSales);
    const receiptMap = byClient(cashCollected);
    const badDebtMap = byClient(badDebts);
    const outstandingMap = byClient(outstanding);
    const customerSummaries = clients.map((client) => {
      const key = String(client.id);
      const sales = salesMap.get(key);
      const receipts = receiptMap.get(key);
      const badDebt = badDebtMap.get(key);
      const balance = outstandingMap.get(key);
      const totalCreditSales = toNumber(sales?._sum?.subtotal);
      const totalCollected = toNumber(receipts?._sum?.amountReceived);
      const totalBadDebts = toNumber(badDebt?._sum?.totalAmount);
      const outstandingBalance = toNumber(balance?._sum?.amountOutstanding);
      return {
        customerId: client.id,
        customerName: client.name,
        customerCode: client.code,
        tin: client.taxId,
        creditSales: totalCreditSales,
        invoicesIssued: Number(sales?._count?._all || 0),
        cashCollected: totalCollected,
        paymentsReceived: Number(receipts?._count?._all || 0),
        badDebts: totalBadDebts,
        outstandingBalance,
        daysSalesOutstanding: totalCreditSales > 0 ? (outstandingBalance / totalCreditSales) * 365 : 0,
      };
    }).filter((customer) => customer.creditSales > 0 || customer.cashCollected > 0 || customer.outstandingBalance > 0);

    return {
      reportName: 'Annual Accounts Receivable Summary',
      period: `Year Ended December 31, ${year}`,
      year,
      companyId,
      customers: customerSummaries.sort((a, b) => b.creditSales - a.creditSales),
      totals: {
        totalCreditSales: sumLines(customerSummaries, (item) => item.creditSales),
        totalCashCollected: sumLines(customerSummaries, (item) => item.cashCollected),
        totalBadDebts: sumLines(customerSummaries, (item) => item.badDebts),
        totalOutstanding: sumLines(customerSummaries, (item) => item.outstandingBalance),
        totalCustomers: customerSummaries.length,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /** 6. Annual Accounts Payable Summary. */
  static async getAccountsPayableSummary(companyId, year) {
    const { start, end } = getYearRange(year);
    const cid = toIdString(companyId);
    const [suppliers, creditPurchases, cashPaid, outstanding] = await Promise.all([
      findAllPaged(dbClient().supplier, {
        where: { companyId: cid },
        select: { id: true, name: true, code: true, taxId: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      dbClient().purchase.groupBy({
        by: ['supplierId'],
        where: { companyId: cid, purchaseDate: { gte: start, lte: end }, status: { in: PURCHASE_STATUSES } },
        _sum: { subtotal: true },
        _count: { _all: true },
      }),
      dbClient().aPPayment.groupBy({
        by: ['supplierId'],
        where: { companyId: cid, paymentDate: { gte: start, lte: end }, status: 'posted' },
        _sum: { amountPaid: true },
        _count: { _all: true },
      }),
      dbClient().purchase.groupBy({
        by: ['supplierId'],
        where: { companyId: cid, purchaseDate: { lte: end }, status: { in: PURCHASE_STATUSES } },
        _sum: { totalAmount: true },
      }),
    ]);

    const bySupplier = (rows) => new Map(rows.map((row) => [String(row.supplierId), row]));
    const purchaseMap = bySupplier(creditPurchases);
    const paymentMap = bySupplier(cashPaid);
    const outstandingMap = bySupplier(outstanding);
    const supplierSummaries = suppliers.map((supplier) => {
      const key = String(supplier.id);
      const purchases = purchaseMap.get(key);
      const payments = paymentMap.get(key);
      const balance = outstandingMap.get(key);
      const totalCreditPurchases = toNumber(purchases?._sum?.subtotal);
      const totalPaid = toNumber(payments?._sum?.amountPaid);
      const outstandingBalance = toNumber(balance?._sum?.totalAmount) - totalPaid;
      return {
        supplierId: supplier.id,
        supplierName: supplier.name,
        supplierCode: supplier.code,
        tin: supplier.taxId,
        creditPurchases: totalCreditPurchases,
        purchaseOrders: Number(purchases?._count?._all || 0),
        cashPaid: totalPaid,
        paymentsMade: Number(payments?._count?._all || 0),
        outstandingBalance: Math.max(0, outstandingBalance),
        daysPayablesOutstanding: totalCreditPurchases > 0 ? (Math.max(0, outstandingBalance) / totalCreditPurchases) * 365 : 0,
      };
    }).filter((supplier) => supplier.creditPurchases > 0 || supplier.cashPaid > 0 || supplier.outstandingBalance > 0);

    return {
      reportName: 'Annual Accounts Payable Summary',
      period: `Year Ended December 31, ${year}`,
      year,
      companyId,
      suppliers: supplierSummaries.sort((a, b) => b.creditPurchases - a.creditPurchases),
      totals: {
        totalCreditPurchases: sumLines(supplierSummaries, (item) => item.creditPurchases),
        totalCashPaid: sumLines(supplierSummaries, (item) => item.cashPaid),
        totalOutstanding: sumLines(supplierSummaries, (item) => item.outstandingBalance),
        totalSuppliers: supplierSummaries.length,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /** 7. Annual Payroll and Benefits Report. */
  static async getPayrollReport(companyId, year) {
    const { start, end } = getYearRange(year);
    const { payrollRuns, payrolls, byRun } = await loadPayrollPeriod(companyId, start, end);
    const monthlyData = getMonthsInYear(year).map(({ month }) => {
      const records = payrollRuns
        .filter((run) => new Date(run.payPeriodStart).getMonth() + 1 === month)
        .flatMap((run) => byRun.get(run.id) || []);
      const totals = records.reduce((summary, payroll) => {
        const values = payrollComponents(payroll);
        summary.grossSalary += values.grossSalary;
        summary.employerRSSB += values.employerRSSB;
        summary.paye += values.paye;
        summary.employeeRSSB += values.employeeRSSB;
        summary.otherBenefits += values.otherBenefits;
        summary.netPay += values.netPay;
        return summary;
      }, { grossSalary: 0, employerRSSB: 0, paye: 0, employeeRSSB: 0, otherBenefits: 0, netPay: 0 });
      return {
        month,
        monthName: getMonthName(month),
        employeeCount: records.length,
        ...totals,
        totalEmploymentCost: totals.grossSalary + totals.employerRSSB + totals.otherBenefits,
      };
    });

    const employeeDetails = payrolls.map((payroll) => {
      const values = payrollComponents(payroll);
      const embedded = values.employee;
      const master = payroll.employeeMaster;
      return {
        employeeId: master?.id || payroll.employeeRefId || embedded._id || embedded.id || embedded.employeeId,
        employeeCode: master?.employeeId || embedded.employeeId,
        firstName: master?.firstName || embedded.firstName,
        lastName: master?.lastName || embedded.lastName,
        department: master?.department || embedded.department,
        annualGross: values.grossSalary,
        annualEmployerRSSB: values.employerRSSB,
        annualPaye: values.paye,
        annualEmployeeRSSB: values.employeeRSSB,
        annualOtherBenefits: values.otherBenefits,
        annualNetPay: values.netPay,
      };
    });

    return {
      reportName: 'Annual Payroll and Benefits Report',
      period: `Year Ended December 31, ${year}`,
      year,
      companyId,
      monthlyData,
      yearTotals: {
        grossSalary: sumLines(monthlyData, (item) => item.grossSalary),
        employerRSSB: sumLines(monthlyData, (item) => item.employerRSSB),
        paye: sumLines(monthlyData, (item) => item.paye),
        employeeRSSB: sumLines(monthlyData, (item) => item.employeeRSSB),
        otherBenefits: sumLines(monthlyData, (item) => item.otherBenefits),
        netPay: sumLines(monthlyData, (item) => item.netPay),
        totalEmploymentCost: sumLines(monthlyData, (item) => item.totalEmploymentCost),
        totalEmployees: payrolls.length,
      },
      employees: employeeDetails,
      generatedAt: new Date().toISOString(),
    };
  }

  /** 8. Annual Tax Summary Report. */
  static async getTaxSummary(companyId, year) {
    const { start, end } = getYearRange(year);
    const cid = toIdString(companyId);
    const [outputVAT, inputVAT, payrollData, invoiceWHT, purchaseWHT] = await Promise.all([
      dbClient().invoice.aggregate({
        where: { companyId: cid, invoiceDate: { gte: start, lte: end }, status: { in: REVENUE_STATUSES } },
        _sum: { taxAmount: true, subtotal: true },
      }),
      dbClient().purchase.aggregate({
        where: { companyId: cid, purchaseDate: { gte: start, lte: end }, status: { in: PURCHASE_STATUSES } },
        _sum: { taxAmount: true, subtotal: true },
      }),
      loadPayrollPeriod(cid, start, end),
      dbClient().invoice.aggregate({
        where: { companyId: cid, invoiceDate: { gte: start, lte: end }, status: { in: [...REVENUE_STATUSES, 'overdue'] }, withholdingTax: { gt: 0 } },
        _sum: { withholdingTax: true },
      }),
      dbClient().purchase.aggregate({
        where: { companyId: cid, purchaseDate: { gte: start, lte: end }, status: { in: PURCHASE_STATUSES }, withholdingTax: { gt: 0 } },
        _sum: { withholdingTax: true },
      }),
    ]);

    const runTotals = payrollData.payrollRuns.map((run) => ({
      run,
      totals: payrollRunTotals(run, payrollData.byRun.get(run.id) || []),
    }));
    const totalOutputVAT = toNumber(outputVAT._sum?.taxAmount);
    const totalInputVAT = toNumber(inputVAT._sum?.taxAmount);
    const netVATPayable = totalOutputVAT - totalInputVAT;
    const totalPaye = sumLines(runTotals, (item) => item.totals.paye);
    const totalEmployeeRSSB = sumLines(runTotals, (item) => item.totals.employeeRSSB);
    const totalEmployerRSSB = sumLines(runTotals, (item) => item.totals.employerRSSB);
    const totalRSSB = totalEmployeeRSSB + totalEmployerRSSB;
    const totalWithholdingTax = toNumber(invoiceWHT._sum?.withholdingTax) + toNumber(purchaseWHT._sum?.withholdingTax);

    const monthlyBreakdown = await Promise.all(getMonthsInYear(year).map(async ({ month }) => {
      const monthStart = new Date(year, month - 1, 1);
      monthStart.setHours(0, 0, 0, 0);
      const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);
      const [monthOutput, monthInput] = await Promise.all([
        dbClient().invoice.aggregate({
          where: { companyId: cid, invoiceDate: { gte: monthStart, lte: monthEnd }, status: { in: REVENUE_STATUSES } },
          _sum: { taxAmount: true },
        }),
        dbClient().purchase.aggregate({
          where: { companyId: cid, purchaseDate: { gte: monthStart, lte: monthEnd }, status: { in: PURCHASE_STATUSES } },
          _sum: { taxAmount: true },
        }),
      ]);
      const monthRuns = runTotals.filter((item) => {
        const date = new Date(item.run.payPeriodStart);
        return date >= monthStart && date <= monthEnd;
      });
      return {
        month,
        monthName: getMonthName(month),
        outputVAT: toNumber(monthOutput._sum?.taxAmount),
        inputVAT: toNumber(monthInput._sum?.taxAmount),
        netVAT: toNumber(monthOutput._sum?.taxAmount) - toNumber(monthInput._sum?.taxAmount),
        paye: sumLines(monthRuns, (item) => item.totals.paye),
        employeeRSSB: sumLines(monthRuns, (item) => item.totals.employeeRSSB),
        employerRSSB: sumLines(monthRuns, (item) => item.totals.employerRSSB),
      };
    }));

    return {
      reportName: 'Annual Tax Summary Report',
      period: `Year Ended December 31, ${year}`,
      year,
      companyId,
      vat: {
        outputVAT: totalOutputVAT,
        inputVAT: totalInputVAT,
        netVATPayable,
        totalSales: toNumber(outputVAT._sum?.subtotal),
        totalPurchases: toNumber(inputVAT._sum?.subtotal),
      },
      paye: { totalPaye, employeeCount: payrollData.payrollRuns.length },
      rssb: { employeeContributions: totalEmployeeRSSB, employerContributions: totalEmployerRSSB, totalContributions: totalRSSB },
      withholding: { totalWithholdingTax },
      summary: {
        totalTaxesRemitted: netVATPayable + totalPaye + totalEmployerRSSB + totalWithholdingTax,
        totalTaxesAccrued: netVATPayable + totalPaye + totalRSSB + totalWithholdingTax,
        taxComplianceRate: 100,
      },
      monthlyBreakdown,
      generatedAt: new Date().toISOString(),
    };
  }

  /** 9. Annual Budget vs Actual Performance Report. */
  static async getBudgetVsActual(companyId, year) {
    const { start, end } = getYearRange(year);
    const cid = toIdString(companyId);
    const [budgetLines, revenueByMonth, expenseByMonth] = await Promise.all([
      findAllPaged(dbClient().budgetLine, {
        where: { companyId: cid, periodYear: year },
        include: { budget: { select: { id: true, name: true, category: true, type: true, amount: true } } },
        orderBy: [{ periodMonth: 'asc' }, { id: 'asc' }],
      }),
      dbClient().$queryRaw`
        SELECT EXTRACT(MONTH FROM invoice_date)::int AS month,
               COALESCE(SUM(subtotal), 0)::float AS actual
        FROM invoices
        WHERE company_id = ${cid}
          AND invoice_date >= ${start} AND invoice_date <= ${end}
          AND status IN ('fully_paid', 'partially_paid', 'confirmed', 'sent')
        GROUP BY EXTRACT(MONTH FROM invoice_date)
      `,
      dbClient().$queryRaw`
        SELECT EXTRACT(MONTH FROM expense_date)::int AS month,
               COALESCE(category, 'Operations') AS category,
               COALESCE(SUM(amount), 0)::float AS actual
        FROM expenses
        WHERE company_id = ${cid}
          AND expense_date >= ${start} AND expense_date <= ${end}
          AND status = 'posted'
        GROUP BY EXTRACT(MONTH FROM expense_date), COALESCE(category, 'Operations')
      `,
    ]);

    const accountIds = [...new Set(budgetLines.map((line) => line.accountId).filter(Boolean))];
    const accounts = accountIds.length
      ? await dbClient().chartOfAccount.findMany({ where: { companyId: cid, id: { in: accountIds } }, select: { id: true, code: true, name: true, type: true } })
      : [];
    const accountMap = new Map(accounts.map((account) => [String(account.id), account]));
    const revenueMonths = new Map(revenueByMonth.map((row) => [Number(row.month), toNumber(row.actual)]));
    const expensesByMonth = new Map();
    for (const row of expenseByMonth) {
      const month = Number(row.month);
      const map = expensesByMonth.get(month) || new Map();
      map.set(String(row.category), toNumber(row.actual));
      expensesByMonth.set(month, map);
    }
    const allExpensesByCategory = new Map();
    for (const monthMap of expensesByMonth.values()) {
      for (const [category, amount] of monthMap) allExpensesByCategory.set(category, (allExpensesByCategory.get(category) || 0) + amount);
    }

    const findExpenseActual = (category, name) => {
      const categoryText = String(category || '').toLowerCase();
      const nameText = String(name || '').toLowerCase();
      let amount = 0;
      for (const [expenseCategory, value] of allExpensesByCategory) {
        const candidate = expenseCategory.toLowerCase();
        if (!categoryText || candidate === categoryText || candidate.includes(categoryText) || nameText.includes(candidate)) amount += value;
      }
      return amount;
    };

    const budgetComparison = budgetLines.map((line) => {
      const budget = line.budget || {};
      const account = accountMap.get(String(line.accountId));
      const accountType = budget.type || account?.type || 'expense';
      const category = line.category || budget.category || budget.name || 'Operations';
      const budgetedAmount = toNumber(line.budgetedAmount);
      const actualAmount = accountType === 'revenue' ? sumLines(revenueByMonth, (row) => row.actual) : findExpenseActual(category, budget.name);
      const variance = actualAmount - budgetedAmount;
      const monthlyActuals = Array.from({ length: 12 }, (_, index) => {
        const month = index + 1;
        const actual = accountType === 'revenue'
          ? (revenueMonths.get(month) || 0)
          : (expensesByMonth.get(month)?.get(String(category)) || findExpenseActual(category, budget.name) / 12);
        return { month, budgeted: line.periodMonth === month ? budgetedAmount : 0, actual, variance: actual - (line.periodMonth === month ? budgetedAmount : 0) };
      });
      return {
        budgetLineId: line.id,
        accountCode: account?.code || null,
        accountName: account?.name || budget.name || category,
        category,
        accountType,
        budgetedAmount,
        actualAmount,
        variance,
        variancePercent: budgetedAmount > 0 ? (variance / budgetedAmount) * 100 : 0,
        status: variance > 0 && accountType === 'expense' ? 'over'
          : variance < 0 && accountType === 'expense' ? 'under'
            : variance > 0 && accountType === 'revenue' ? 'favorable'
              : variance < 0 && accountType === 'revenue' ? 'unfavorable' : 'on_track',
        monthlyActuals,
      };
    });
    const revenueLines = budgetComparison.filter((line) => line.accountType === 'revenue');
    const expenseLines = budgetComparison.filter((line) => line.accountType === 'expense');

    return {
      reportName: 'Annual Budget vs Actual Performance Report',
      period: `Year Ended December 31, ${year}`,
      year,
      companyId,
      budgetLines: budgetComparison,
      summary: {
        totalBudgetedRevenue: sumLines(revenueLines, (line) => line.budgetedAmount),
        totalActualRevenue: sumLines(revenueLines, (line) => line.actualAmount),
        totalBudgetedExpenses: sumLines(expenseLines, (line) => line.budgetedAmount),
        totalActualExpenses: sumLines(expenseLines, (line) => line.actualAmount),
        revenueVariance: sumLines(revenueLines, (line) => line.variance),
        expenseVariance: sumLines(expenseLines, (line) => line.variance),
        netVariance: sumLines(budgetComparison, (line) => line.variance),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /** 10. Annual Audit Trail Report. */
  static async getAuditTrail(companyId, year) {
    const { start, end } = getYearRange(year);
    const cid = toIdString(companyId);
    const [users, auditLogs, journalEntries] = await Promise.all([
      findAllPaged(dbClient().user, {
        where: { OR: [{ companyId: cid }, { companyUsers: { some: { companyId: cid } } }] },
        select: { id: true, name: true, email: true, role: true },
        orderBy: { id: 'asc' },
      }),
      findAllPaged(dbClient().auditLog, {
        where: { companyId: cid, createdAt: { gte: start, lte: end } },
        include: { user: { select: { id: true, name: true, email: true, role: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      findAllPaged(dbClient().journalEntry, {
        where: {
          companyId: cid,
          date: { gte: start, lte: end },
          OR: [
            { reversed: true },
            { reversalOfId: { not: null } },
            { reversalEntryId: { not: null } },
            { isReconciliationAdjustingEntry: true },
          ],
        },
        include: { lines: { orderBy: { lineOrder: 'asc' } } },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
      }),
    ]);

    const userMap = new Map(users.map((user) => [String(user.id), user]));
    const userActivity = users.map((user) => {
      const userLogs = auditLogs.filter((log) => String(log.userId || '') === String(user.id));
      const actionsByType = {};
      for (const log of userLogs) actionsByType[log.action || 'unknown'] = (actionsByType[log.action || 'unknown'] || 0) + 1;
      return {
        userId: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        totalActions: userLogs.length,
        actionsByType,
        firstActivity: userLogs[0]?.createdAt || null,
        lastActivity: userLogs[userLogs.length - 1]?.createdAt || null,
      };
    });
    const auditTrail = auditLogs.map((log) => ({
      timestamp: log.createdAt,
      userId: log.userId,
      userName: log.user?.name || 'System',
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      description: log.errorMessage || null,
      changes: log.changes,
      ipAddress: log.ipAddress,
      userAgent: log.userAgent,
    }));
    const reversalsAndAdjustments = journalEntries.map((entry) => ({
      entryId: entry.id,
      entryNumber: entry.entryNumber,
      date: entry.date,
      description: entry.description,
      amount: sumLines(entry.lines || [], (line) => line.debit),
      type: entry.reversed || entry.reversalOfId || entry.reversalEntryId ? 'reversal' : 'adjustment',
      createdBy: userMap.get(String(entry.createdById))?.name || 'Unknown',
      reversedBy: entry.reversedById ? userMap.get(String(entry.reversedById))?.name || 'Unknown' : null,
      reversalDate: entry.reversedAt,
      reversalReason: entry.lockedReason || null,
    }));
    const actionsByMonth = {};
    for (const log of auditLogs) {
      const month = new Date(log.createdAt).getMonth() + 1;
      actionsByMonth[month] = (actionsByMonth[month] || 0) + 1;
    }
    const mostActiveUser = [...userActivity].sort((a, b) => b.totalActions - a.totalActions)[0] || null;

    return {
      reportName: 'Annual Audit Trail Report',
      period: `Year Ended December 31, ${year}`,
      year,
      companyId,
      userActivity,
      auditTrail,
      reversalsAndAdjustments,
      summary: {
        totalUsers: users.length,
        totalAuditEntries: auditLogs.length,
        totalReversals: reversalsAndAdjustments.filter((entry) => entry.type === 'reversal').length,
        totalAdjustments: reversalsAndAdjustments.filter((entry) => entry.type === 'adjustment').length,
        mostActiveUser,
        actionsByMonth,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Shared report helpers ────────────────────────────────────────────────

  static async _calculateAnnualCOGS(companyId, start, end) {
    const cid = toIdString(companyId);
    const stockOut = await dbClient().$queryRaw`
      SELECT COALESCE(SUM(quantity * unit_cost), 0)::float AS total
      FROM stock_movements
      WHERE company_id = ${cid}
        AND movement_date >= ${start} AND movement_date <= ${end}
        AND type = 'out' AND reason IN ('sale', 'dispatch')
    `;
    return toNumber(stockOut[0]?.total);
  }

  static async _getAnnualExpensesByCategory(companyId, start, end) {
    const rows = await dbClient().expense.groupBy({
      by: ['category'],
      where: { companyId: toIdString(companyId), expenseDate: { gte: start, lte: end }, status: 'posted' },
      _sum: { amount: true },
    });
    return rows
      .map((row) => ({ category: row.category || 'Uncategorized', amount: toNumber(row._sum?.amount) }))
      .sort((a, b) => b.amount - a.amount);
  }

  static async _getAnnualAccountTotal(companyId, start, end, accountPatterns) {
    return accountTotalsForPatterns(companyId, start, end, accountPatterns);
  }

  static async _getInventoryValue(companyId, date) {
    const products = await findAllPaged(dbClient().product, {
      where: { companyId: toIdString(companyId), isStockable: true },
      select: { id: true, averageCost: true },
      orderBy: { id: 'asc' },
    });
    const quantities = await productQuantitiesAtDate(companyId, date);
    return products.reduce((total, product) => total + (quantities.get(String(product.id)) || 0) * toNumber(product.averageCost), 0);
  }

  static async _getAccountsReceivable(companyId, date) {
    const result = await dbClient().invoice.aggregate({
      where: { companyId: toIdString(companyId), invoiceDate: { lte: date }, status: { in: RECEIVABLE_STATUSES } },
      _sum: { amountOutstanding: true },
    });
    return toNumber(result._sum?.amountOutstanding);
  }

  static async _getAccountsPayable(companyId, date) {
    const result = await dbClient().goodsReceivedNote.aggregate({
      where: { companyId: toIdString(companyId), receivedDate: { lte: date }, status: 'confirmed' },
      _sum: { balance: true },
    });
    return toNumber(result._sum?.balance);
  }

  static async _getBankBalance(companyId, _date) {
    const accounts = await findAllPaged(dbClient().bankAccount, {
      where: { companyId: toIdString(companyId), isActive: true },
      select: { cachedBalance: true, openingBalance: true },
      orderBy: { id: 'asc' },
    });
    return accounts.reduce((sum, account) => sum + toNumber(account.cachedBalance || account.openingBalance), 0);
  }

  static async _getLoansPayable(companyId, _date) {
    const loans = await findAllPaged(dbClient().loan, {
      where: { companyId: toIdString(companyId), status: { in: ['active', 'approved'] } },
      select: { outstandingBalance: true, originalAmount: true },
      orderBy: { id: 'asc' },
    });
    return loans.reduce((sum, loan) => sum + toNumber(loan.outstandingBalance || loan.originalAmount), 0);
  }

  static async _calculateCashFlow(companyId, year, start, end) {
    const cid = toIdString(companyId);
    const [cashFromCustomers, cashPaidToSuppliers, cashPaidForExpenses, assetPurchases] = await Promise.all([
      dbClient().aRReceipt.aggregate({ where: { companyId: cid, receiptDate: { gte: start, lte: end }, status: 'posted' }, _sum: { amountReceived: true } }),
      dbClient().aPPayment.aggregate({ where: { companyId: cid, paymentDate: { gte: start, lte: end }, status: 'posted' }, _sum: { amountPaid: true } }),
      dbClient().expense.aggregate({ where: { companyId: cid, expenseDate: { gte: start, lte: end }, status: 'posted', paymentMethod: { in: ['cash', 'bank'] } }, _sum: { amount: true } }),
      dbClient().fixedAsset.aggregate({ where: { companyId: cid, purchaseDate: { gte: start, lte: end } }, _sum: { purchaseCost: true } }),
    ]);
    const receipts = toNumber(cashFromCustomers._sum?.amountReceived);
    const supplierPayments = toNumber(cashPaidToSuppliers._sum?.amountPaid);
    const expenses = toNumber(cashPaidForExpenses._sum?.amount);
    const assetCost = toNumber(assetPurchases._sum?.purchaseCost);
    const operating = receipts - supplierPayments - expenses;
    const investing = -assetCost;
    const beginningCash = await this._getBankBalance(cid, new Date(year - 1, 11, 31, 23, 59, 59, 999));
    const endingCash = await this._getBankBalance(cid, end);
    return {
      operating: { cashFromCustomers: receipts, cashPaidToSuppliers: supplierPayments, cashPaidForExpenses: expenses, netOperatingCashFlow: operating },
      investing: { purchasesOfAssets: assetCost, netInvestingCashFlow: investing },
      financing: { netFinancingCashFlow: 0 },
      netIncrease: operating + investing,
      beginningCash,
      endingCash,
    };
  }

  static async _calculateInventoryValueAtDate(companyId, date, products = null) {
    const rows = products || await findAllPaged(dbClient().product, {
      where: { companyId: toIdString(companyId), isStockable: true },
      select: { id: true, averageCost: true },
      orderBy: { id: 'asc' },
    });
    const quantities = await productQuantitiesAtDate(companyId, date);
    return rows.reduce((total, product) => total + (quantities.get(String(product.id)) || 0) * toNumber(product.averageCost), 0);
  }

  static async _getProductQuantityAtDate(productId, date) {
    const rows = await dbClient().$queryRaw`
      SELECT COALESCE(SUM(CASE WHEN type = 'in' THEN quantity ELSE -quantity END), 0)::float AS "netQty"
      FROM stock_movements
      WHERE product_id = ${toIdString(productId)} AND movement_date <= ${date}
    `;
    return toNumber(rows[0]?.netQty);
  }
}

module.exports = AnnualReportsService;
