/**
 * TaxTransaction — PostgreSQL (Prisma) backed.
 *
 * Centralized tax-event ledger. Static query helpers preserve the Mongoose API
 * surface that taxTransactionService delegates to.
 */

const { dbClient } = require('../lib/prisma');
const { buildTenantModel } = require('../utils/masterDataCommon');
const { decimalToNumber } = require('../utils/decimalHelpers');
const { toIdString } = require('../utils/objectId');
const {
  TAX_TRANSACTION_FIELD_MAP,
  taxTransactionToApi,
  taxTransactionTranslateCreate,
  taxTransactionTranslateUpdate,
  taxTransactionInclude,
  TAX_TRANSACTION_DEFAULT_INCLUDE,
} = require('../utils/taxMappers');

const TaxTransaction = buildTenantModel({
  name: 'TaxTransaction',
  collection: 'taxtransactions',
  delegateName: 'taxTransaction',
  fieldMap: TAX_TRANSACTION_FIELD_MAP,
  toApi: taxTransactionToApi,
  translateCreate: taxTransactionTranslateCreate,
  translateUpdate: taxTransactionTranslateUpdate,
  include: taxTransactionInclude,
});

function companyKey(companyId) {
  return toIdString(companyId);
}

function buildDateRange(year, month) {
  if (!year) return null;
  const y = Number(year);
  if (month) {
    const m = Number(month);
    return {
      gte: new Date(y, m - 1, 1),
      lte: new Date(y, m, 0, 23, 59, 59, 999),
    };
  }
  return {
    gte: new Date(y, 0, 1),
    lte: new Date(y, 11, 31, 23, 59, 59, 999),
  };
}

function emptyDashboardSummary() {
  return {
    vat: {
      output: 0,
      input: 0,
      output_reversed: 0,
      input_reversed: 0,
      net_payable: 0,
    },
    paye: { withheld: 0, count: 0 },
    rssb: { employee: 0, employer: 0, total: 0 },
    corporate_income: { owed: 0 },
    withholding: { collected: 0 },
    trading_license: { fee: 0 },
    total_tax_liability: 0,
    transaction_count: 0,
  };
}

function applyDashboardGroup(summary, taxType, direction, total, count) {
  switch (taxType) {
    case 'vat_output':
      summary.vat.output = total;
      break;
    case 'vat_input':
      summary.vat.input = total;
      break;
    case 'vat_output_reversed':
      summary.vat.output_reversed = total;
      break;
    case 'vat_input_reversed':
      summary.vat.input_reversed = total;
      break;
    case 'paye':
      summary.paye.withheld = total;
      summary.paye.count = count;
      break;
    case 'rssb_employee':
      summary.rssb.employee = total;
      break;
    case 'rssb_employer':
      summary.rssb.employer = total;
      break;
    case 'corporate_income':
    case 'income_tax':
      summary.corporate_income.owed = total;
      break;
    case 'withholding':
      summary.withholding.collected = total;
      break;
    case 'trading_license':
      summary.trading_license.fee = total;
      break;
    default:
      break;
  }
  summary.transaction_count += count;
}

TaxTransaction.getBalance = async function getBalance(companyId, taxType, periodStart, periodEnd) {
  const rows = await dbClient().taxTransaction.groupBy({
    by: ['direction'],
    where: {
      companyId: companyKey(companyId),
      taxType,
      status: 'posted',
      date: {
        gte: new Date(periodStart),
        lte: new Date(periodEnd),
      },
    },
    _sum: { amount: true },
  });

  const balances = { input: 0, output: 0, withheld: 0, paid: 0, net: 0 };
  for (const row of rows) {
    balances[row.direction] = decimalToNumber(row._sum.amount);
  }
  if (String(taxType).startsWith('vat')) {
    balances.net = balances.output - balances.input;
  } else {
    balances.net = balances.withheld;
  }
  return balances;
};

TaxTransaction.getDashboardSummary = async function getDashboardSummary(companyId, year, month) {
  const dateFilter = buildDateRange(year, month);
  const where = {
    companyId: companyKey(companyId),
    status: 'posted',
    ...(dateFilter ? { date: dateFilter } : {}),
  };

  const rows = await dbClient().taxTransaction.groupBy({
    by: ['taxType', 'direction'],
    where,
    _sum: { amount: true },
    _count: { _all: true },
  });

  const summary = emptyDashboardSummary();
  for (const row of rows) {
    applyDashboardGroup(
      summary,
      row.taxType,
      row.direction,
      decimalToNumber(row._sum.amount),
      row._count._all,
    );
  }

  summary.vat.net_payable =
    summary.vat.output -
    summary.vat.input -
    summary.vat.output_reversed +
    summary.vat.input_reversed;
  summary.rssb.total = summary.rssb.employee + summary.rssb.employer;
  summary.total_tax_liability =
    (summary.vat.net_payable > 0 ? summary.vat.net_payable : 0) +
    summary.paye.withheld +
    summary.rssb.total +
    summary.corporate_income.owed +
    summary.withholding.collected +
    summary.trading_license.fee;

  return summary;
};

TaxTransaction.getBySourceType = async function getBySourceType(companyId, sourceType, options = {}) {
  const { page = 1, limit = 50, startDate, endDate } = options;
  const skip = (page - 1) * limit;

  const where = {
    companyId: companyKey(companyId),
    sourceType,
    status: 'posted',
  };
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = new Date(startDate);
    if (endDate) where.date.lte = new Date(endDate);
  }

  const [total, rows] = await Promise.all([
    dbClient().taxTransaction.count({ where }),
    dbClient().taxTransaction.findMany({
      where,
      orderBy: { date: 'desc' },
      skip,
      take: limit,
      include: TAX_TRANSACTION_DEFAULT_INCLUDE,
    }),
  ]);

  return {
    transactions: rows.map(taxTransactionToApi),
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 0,
    },
  };
};

TaxTransaction.getTaxSourcesSummary = async function getTaxSourcesSummary(
  companyId,
  periodStart,
  periodEnd,
) {
  const rows = await dbClient().taxTransaction.groupBy({
    by: ['sourceType', 'taxType', 'direction'],
    where: {
      companyId: companyKey(companyId),
      status: 'posted',
      date: {
        gte: new Date(periodStart),
        lte: new Date(periodEnd),
      },
    },
    _sum: { amount: true },
    _count: { _all: true },
    _avg: { amount: true },
    _min: { amount: true },
    _max: { amount: true },
  });

  rows.sort((a, b) => {
    const s = String(a.sourceType).localeCompare(String(b.sourceType));
    return s !== 0 ? s : String(a.taxType).localeCompare(String(b.taxType));
  });

  const sources = {};
  for (const row of rows) {
    const { sourceType, taxType, direction } = row;
    if (!sources[sourceType]) {
      sources[sourceType] = {
        sourceType,
        transactions: [],
        totalAmount: 0,
        totalCount: 0,
      };
    }
    const totalAmount = decimalToNumber(row._sum.amount);
    sources[sourceType].transactions.push({
      taxType,
      direction,
      totalAmount,
      totalCount: row._count._all,
      avgAmount: decimalToNumber(row._avg.amount),
      minAmount: decimalToNumber(row._min.amount),
      maxAmount: decimalToNumber(row._max.amount),
    });
    sources[sourceType].totalAmount += totalAmount;
    sources[sourceType].totalCount += row._count._all;
  }

  return Object.values(sources);
};

TaxTransaction.getPeriodComparison = async function getPeriodComparison(
  companyId,
  currentYear,
  currentMonth,
) {
  const currentDate = new Date(currentYear, currentMonth - 1, 1);
  const previousDate = new Date(currentYear, currentMonth - 2, 1);

  const [current, previous] = await Promise.all([
    TaxTransaction.getDashboardSummary(companyId, currentYear, currentMonth),
    TaxTransaction.getDashboardSummary(
      companyId,
      previousDate.getFullYear(),
      previousDate.getMonth() + 1,
    ),
  ]);

  const calculateChange = (curr, prev) => {
    if (prev === 0) return { amount: curr, percentage: curr > 0 ? 100 : 0 };
    const amount = curr - prev;
    const percentage = (amount / Math.abs(prev)) * 100;
    return { amount, percentage: Math.round(percentage * 100) / 100 };
  };

  return {
    current_period: { year: currentYear, month: currentMonth, summary: current },
    previous_period: {
      year: previousDate.getFullYear(),
      month: previousDate.getMonth() + 1,
      summary: previous,
    },
    changes: {
      vat_net: calculateChange(current.vat.net_payable, previous.vat.net_payable),
      paye: calculateChange(current.paye.withheld, previous.paye.withheld),
      rssb: calculateChange(current.rssb.total, previous.rssb.total),
      total_liability: calculateChange(
        current.total_tax_liability,
        previous.total_tax_liability,
      ),
    },
  };
};

module.exports = TaxTransaction;
