/**
 * APTransactionLedger — PostgreSQL (Prisma) backed.
 *
 * Payables counterpart of ARTransactionLedger. Statics preserved because
 * apTrackingService and the AP reconciliation controller call them directly.
 */

const { dbClient } = require('../lib/prisma');
const { buildTenantModel } = require('../utils/masterDataCommon');
const { decimalToNumber } = require('../utils/decimalHelpers');
const {
  AP_FIELD_MAP,
  apLedgerToApi,
  apLedgerTranslateCreate,
  apLedgerTranslateUpdate,
} = require('../utils/ledgerMappers');

const APTransactionLedger = buildTenantModel({
  name: 'APTransactionLedger',
  collection: 'aptransactionledgers',
  delegateName: 'apTransactionLedger',
  fieldMap: AP_FIELD_MAP,
  toApi: apLedgerToApi,
  translateCreate: apLedgerTranslateCreate,
  translateUpdate: apLedgerTranslateUpdate,
});

/**
 * Supplier balance as at a date.
 *
 * Returns a number. The Mongo version returned the raw Decimal128, which
 * callers then did arithmetic on — that works by coercion in Mongo but would
 * silently misbehave against a Prisma Decimal object.
 */
APTransactionLedger.getSupplierBalanceAtDate = async function getSupplierBalanceAtDate(companyId, supplierId, asOfDate) {
  const row = await APTransactionLedger.findOne({
    company: companyId,
    supplier: supplierId,
    transactionDate: { $lte: asOfDate },
  }).sort({ transactionDate: -1, createdAt: -1 });

  return row ? decimalToNumber(row.supplierBalanceAfter) || 0 : 0;
};

APTransactionLedger.getSupplierHistory = async function getSupplierHistory(companyId, supplierId, options = {}) {
  const { startDate, endDate, limit = 100, skip = 0 } = options;

  const query = { company: companyId, supplier: supplierId };
  if (startDate) query.transactionDate = { $gte: startDate };
  if (endDate) {
    query.transactionDate = query.transactionDate || {};
    query.transactionDate.$lte = endDate;
  }

  return APTransactionLedger.find(query)
    .sort({ transactionDate: -1, createdAt: -1 })
    .limit(limit)
    .skip(skip);
};

/**
 * Replay each supplier's ledger and flag entries where the recorded
 * `supplierBalanceAfter` does not match the running total.
 *
 * The Mongo version did this with `$group` + `$push` to build per-supplier
 * arrays, then walked them in JS. The walk is the actual logic, so it is kept;
 * only the grouping moves out of the aggregation pipeline. Rows are ordered by
 * (supplier, transactionDate, createdAt) exactly as the pipeline's `$sort` did,
 * because a running total is meaningless if the order changes.
 */
APTransactionLedger.verifyIntegrity = async function verifyIntegrity(companyId, options = {}) {
  const { supplierId, startDate, endDate } = options;

  const where = { companyId: String(companyId) };
  if (supplierId) where.supplierId = String(supplierId);
  if (startDate || endDate) {
    where.transactionDate = {};
    if (startDate) where.transactionDate.gte = new Date(startDate);
    if (endDate) where.transactionDate.lte = new Date(endDate);
  }

  const rows = await dbClient().apTransactionLedger.findMany({
    where,
    orderBy: [
      { supplierId: 'asc' },
      { transactionDate: 'asc' },
      { createdAt: 'asc' },
    ],
  });

  const discrepancies = [];
  let currentSupplier = null;
  let expectedBalance = 0;

  for (const row of rows) {
    if (row.supplierId !== currentSupplier) {
      currentSupplier = row.supplierId;
      expectedBalance = 0;
    }

    const amount = decimalToNumber(row.amount);
    expectedBalance += row.direction === 'increase' ? amount : -amount;

    const actualBalance = decimalToNumber(row.supplierBalanceAfter);
    // Same 0.01 tolerance as before: a running total accumulates rounding.
    if (Math.abs(expectedBalance - actualBalance) > 0.01) {
      discrepancies.push({
        supplierId: row.supplierId,
        transactionId: row.id,
        expectedBalance: expectedBalance.toFixed(2),
        actualBalance: actualBalance.toFixed(2),
        difference: (expectedBalance - actualBalance).toFixed(2),
        date: row.transactionDate,
      });
    }
  }

  return {
    verified: discrepancies.length === 0,
    discrepancyCount: discrepancies.length,
    discrepancies,
  };
};

module.exports = APTransactionLedger;
