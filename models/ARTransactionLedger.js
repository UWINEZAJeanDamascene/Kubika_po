/**
 * ARTransactionLedger — PostgreSQL (Prisma) backed.
 *
 * Append-only audit trail of every event that moves a client's receivable
 * balance. The legacy statics are preserved for existing callers.
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

ARTransactionLedger.recordTransaction = async function recordTransaction(data) {
  return ARTransactionLedger.create(data);
};

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
 * Compare ledger balances with current invoice/client balances in PostgreSQL.
 * The ledger rows are streamed in bounded pages, while invoice balances are
 * joined in each page, preventing a full tenant history from entering Node.
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

  const discrepancies = [];
  const batchSize = Math.min(2000, Math.max(100, Number(process.env.RECONCILIATION_BATCH_SIZE) || 500));
  let skip = 0;
  for (;;) {
    const rows = await dbClient().arTransactionLedger.findMany({
      where,
      orderBy: [
        { transactionDate: 'desc' },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: batchSize,
      skip,
    });
    if (!rows.length) break;

    const invoiceIds = [...new Set(rows.map((row) => row.invoiceId).filter(Boolean))];
    const invoices = [];
    for (let index = 0; index < invoiceIds.length; index += 500) {
      const ids = invoiceIds.slice(index, index + 500);
      invoices.push(...await dbClient().invoice.findMany({
        where: { id: { in: ids } },
        select: { id: true, amountOutstanding: true },
        take: ids.length,
      }));
    }
    const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
    const clientIds = [...new Set(rows.map((row) => row.clientId).filter(Boolean))];
    const clients = [];
    for (let index = 0; index < clientIds.length; index += 500) {
      const ids = clientIds.slice(index, index + 500);
      clients.push(...await dbClient().client.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, outstandingBalance: true },
        take: ids.length,
      }));
    }
    const clientById = new Map(clients.map((client) => [client.id, client]));

    for (const row of rows) {
      const invoice = row.invoiceId ? invoiceById.get(row.invoiceId) : null;
      const client = clientById.get(row.clientId);
      const currentInvoiceBalance = invoice ? decimalToNumber(invoice.amountOutstanding) : null;
      const currentClientBalance = client ? decimalToNumber(client.outstandingBalance) : null;
      const differs = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) > 0.005;
      const invoiceDiscrepancy = row.invoiceId != null
        && currentInvoiceBalance != null
        && differs(decimalToNumber(row.invoiceBalanceAfter), currentInvoiceBalance);
      const clientDiscrepancy = currentClientBalance != null
        && differs(decimalToNumber(row.clientBalanceAfter), currentClientBalance);
      if (!invoiceDiscrepancy && !clientDiscrepancy) continue;

      discrepancies.push({
        ...arLedgerToApi(row),
        currentInvoiceBalance,
        currentClientBalance,
        invoiceDiscrepancy,
        clientDiscrepancy,
      });
    }

    if (rows.length < batchSize) break;
    skip += rows.length;
  }
  return discrepancies;
};

module.exports = ARTransactionLedger;
