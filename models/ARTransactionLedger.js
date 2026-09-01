/**
 * ARTransactionLedger — PostgreSQL (Prisma) backed.
 *
 * Append-only audit trail of every event that moves a client's receivable
 * balance. The Mongoose statics below are preserved because
 * arTrackingService and the AR reconciliation controller call them directly.
 */

const { dbClient } = require('../lib/prisma');
const { buildTenantModel } = require('../utils/masterDataCommon');
const { decimalToNumber } = require('../utils/decimalHelpers');
const {
  AR_FIELD_MAP,
  arLedgerToApi,
  arLedgerTranslateCreate,
  arLedgerTranslateUpdate,
} = require('../utils/ledgerMappers');

const ARTransactionLedger = buildTenantModel({
  name: 'ARTransactionLedger',
  collection: 'artransactionledgers',
  delegateName: 'arTransactionLedger',
  fieldMap: AR_FIELD_MAP,
  toApi: arLedgerToApi,
  translateCreate: arLedgerTranslateCreate,
  translateUpdate: arLedgerTranslateUpdate,
});

/** Mongo: `new this(data).save()`. */
ARTransactionLedger.recordTransaction = async function recordTransaction(data) {
  return ARTransactionLedger.create(data);
};

/**
 * Client balance as at a date — the balance recorded by the most recent entry
 * on or before it. Ties on transactionDate break by createdAt, as in Mongo.
 */
ARTransactionLedger.getClientBalanceAtDate = async function getClientBalanceAtDate(companyId, clientId, date) {
  const row = await ARTransactionLedger.findOne({
    company: companyId,
    client: clientId,
    transactionDate: { $lte: date },
  }).sort({ transactionDate: -1, createdAt: -1 });

  return row ? decimalToNumber(row.clientBalanceAfter) || 0 : 0;
};

ARTransactionLedger.getInvoiceBalanceAtDate = async function getInvoiceBalanceAtDate(companyId, invoiceId, date) {
  const row = await ARTransactionLedger.findOne({
    company: companyId,
    invoice: invoiceId,
    transactionDate: { $lte: date },
  }).sort({ transactionDate: -1, createdAt: -1 });

  return row ? decimalToNumber(row.invoiceBalanceAfter) || 0 : 0;
};

/**
 * Ledger entries whose recorded balance no longer matches the live invoice or
 * client balance.
 *
 * Reimplemented against Prisma rather than translated from the Mongo pipeline.
 * That pipeline used `$lookup` + `$addFields` + `$cond`, which the aggregate
 * compatibility layer does not cover; relying on it would have failed quietly
 * or returned wrong rows. Prisma joins the two relations in one query and the
 * comparison happens here, where it is explicit.
 *
 * Comparison is on a rounded-to-cents difference, not equality: the Mongo
 * version compared Decimal128 values with `$ne`, which flags a discrepancy for
 * a representational difference that is not a real one.
 */
ARTransactionLedger.findDiscrepancies = async function findDiscrepancies(companyId, options = {}) {
  const { startDate, endDate, clientId } = options;

  const where = {
    companyId: String(companyId),
    reconciliationStatus: { in: ['pending', 'discrepancy'] },
  };
  if (clientId) where.clientId = String(clientId);
  if (startDate || endDate) {
    where.transactionDate = {};
    if (startDate) where.transactionDate.gte = new Date(startDate);
    if (endDate) where.transactionDate.lte = new Date(endDate);
  }

  const rows = await dbClient().arTransactionLedger.findMany({
    where,
    orderBy: { transactionDate: 'desc' },
    include: {
      client: { select: { id: true, name: true, outstandingBalance: true } },
    },
  });

  // Invoice balances in one follow-up query rather than one per row.
  const invoiceIds = [...new Set(rows.map((r) => r.invoiceId).filter(Boolean))];
  const invoices = invoiceIds.length
    ? await dbClient().invoice.findMany({
      where: { id: { in: invoiceIds } },
      select: { id: true, amountOutstanding: true },
    })
    : [];
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));

  const differs = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) > 0.005;

  return rows
    .map((row) => {
      const currentInvoice = row.invoiceId ? invoiceById.get(row.invoiceId) : null;
      const currentInvoiceBalance = currentInvoice ? decimalToNumber(currentInvoice.amountOutstanding) : null;
      const currentClientBalance = row.client ? decimalToNumber(row.client.outstandingBalance) : null;

      const invoiceDiscrepancy = row.invoiceId != null
        && currentInvoiceBalance != null
        && differs(decimalToNumber(row.invoiceBalanceAfter), currentInvoiceBalance);
      const clientDiscrepancy = currentClientBalance != null
        && differs(decimalToNumber(row.clientBalanceAfter), currentClientBalance);

      if (!invoiceDiscrepancy && !clientDiscrepancy) return null;

      return {
        ...arLedgerToApi(row),
        currentInvoiceBalance,
        currentClientBalance,
        invoiceDiscrepancy,
        clientDiscrepancy,
      };
    })
    .filter(Boolean);
};

module.exports = ARTransactionLedger;
