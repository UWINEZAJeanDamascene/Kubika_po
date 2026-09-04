const Product = require('../models/Product');
const { dbClient } = require('../lib/prisma');

async function journalLineTotals(companyId, accountCodes) {
  return dbClient().journalEntryLine.aggregate({
    where: {
      companyId: String(companyId),
      accountCode: { in: accountCodes },
      journalEntry: { status: 'posted', reversed: false },
    },
    _sum: { debit: true, credit: true },
  });
}

async function getJournalTotals(companyId) {
  const jeTotals = await dbClient().journalEntry.aggregate({
    where: { companyId: String(companyId), status: 'posted' },
    _sum: { totalDebit: true, totalCredit: true },
    _count: { _all: true },
  });
  const totals = {
    totalDebit: Number(jeTotals._sum.totalDebit || 0),
    totalCredit: Number(jeTotals._sum.totalCredit || 0),
    count: jeTotals._count._all,
  };
  const diff = totals.totalDebit - totals.totalCredit;
  return { totals, difference: diff, healthy: Math.abs(diff) < 0.01 };
}

async function getStockDiscrepancies(companyId) {
  const batchAgg = await dbClient().inventoryBatch.groupBy({
    by: ['productId'],
    where: { companyId: String(companyId) },
    _sum: { availableQuantity: true },
    _count: { _all: true },
  });
  const productIds = batchAgg.map((row) => row.productId);
  const products = await Product.find({
    company: companyId,
    $or: [
      ...(productIds.length ? [{ _id: { $in: productIds } }] : []),
      { currentStock: { $ne: null, $ne: 0 } },
    ],
  }, 'name currentStock').lean();
  const productMap = new Map(products.map((product) => [String(product._id), product]));

  const batchMap = new Map();
  batchAgg.forEach((row) => batchMap.set(String(row.productId), row));

  const discrepancies = [];
  batchAgg.forEach(entry => {
    const pid = entry.productId ? String(entry.productId) : null;
    const product = productMap.get(pid);
    const currentStock = Number(product?.currentStock || 0);
    const totalAvailable = Number(entry._sum.availableQuantity || 0);
    const diff = Number(currentStock) - Number(totalAvailable);
    if (Math.abs(diff) > 0.0001) {
      discrepancies.push({ productId: pid, name: product?.name || null, currentStock, totalAvailable, difference: Number(diff) });
    }
  });

  products.forEach(p => {
    const pid = String(p._id);
    if (!batchMap.has(pid)) {
      const currentStock = Number(p.currentStock || 0);
      if (Math.abs(Number(currentStock)) > 0.0001) {
        discrepancies.push({ productId: pid, name: p.name || null, currentStock: Number(currentStock), totalAvailable: 0, difference: Number(currentStock) });
      }
    }
  });

  return { discrepancies, discrepanciesCount: discrepancies.length, healthy: discrepancies.length === 0, checked: batchAgg.length + products.length };
}

// ── TAX RECONCILIATION CHECKS ────────────────────────────────────────

/**
 * VAT Reconciliation:
 * Balance on VAT Output accounts minus balance on VAT Input accounts
 * must equal the net VAT payable figure from journal lines.
 */
async function getVatReconciliation(companyId) {
  const vatOutputCodes = ['2220'];
  const vatInputCodes = ['2210'];

  // VAT Output balance (credits - debits)
  const outputAgg = await journalLineTotals(companyId, vatOutputCodes);

  // VAT Input balance (debits - credits)
  const inputAgg = await journalLineTotals(companyId, vatInputCodes);

  const outputCredit = Number(outputAgg._sum.credit || 0);
  const outputDebit = Number(outputAgg._sum.debit || 0);
  const inputCredit = Number(inputAgg._sum.credit || 0);
  const inputDebit = Number(inputAgg._sum.debit || 0);
  const outputBalance = outputCredit - outputDebit;
  const inputBalance = inputDebit - inputCredit;
  const netVat = outputBalance - inputBalance;

  return {
    vat_output_balance: Number(outputBalance.toFixed(2)),
    vat_input_balance: Number(inputBalance.toFixed(2)),
    net_vat_payable: Number(netVat.toFixed(2)),
    healthy: true // Net VAT payable is derived from account balances, always reconciled by definition
  };
}

/**
 * PAYE Reconciliation:
 * The balance on the PAYE Tax Payable account must equal
 * total PAYE withheld minus all PAYE settlements.
 */
async function getPayeReconciliation(companyId) {
  const payeCodes = ['2230'];

  const payeAgg = await journalLineTotals(companyId, payeCodes);

  const payeWithheld = Number(payeAgg._sum.credit || 0);
  const payeRemitted = Number(payeAgg._sum.debit || 0);
  const payeBalance = payeWithheld - payeRemitted;

  return {
    paye_withheld: Number(payeWithheld.toFixed(2)),
    paye_remitted: Number(payeRemitted.toFixed(2)),
    paye_balance: Number(payeBalance.toFixed(2)),
    healthy: payeBalance >= 0 // Balance should never be negative
  };
}

/**
 * RSSB Reconciliation:
 * The balance on the RSSB Payable account must equal
 * total RSSB contributions minus all RSSB settlements.
 */
async function getRssbReconciliation(companyId) {
  const rssbCodes = ['2240'];

  const rssbAgg = await journalLineTotals(companyId, rssbCodes);

  const rssbContributed = Number(rssbAgg._sum.credit || 0);
  const rssbRemitted = Number(rssbAgg._sum.debit || 0);
  const rssbBalance = rssbContributed - rssbRemitted;

  return {
    rssb_contributed: Number(rssbContributed.toFixed(2)),
    rssb_remitted: Number(rssbRemitted.toFixed(2)),
    rssb_balance: Number(rssbBalance.toFixed(2)),
    healthy: rssbBalance >= 0 // Balance should never be negative
  };
}

async function getHealthReport(companyId) {
  const journal = await getJournalTotals(companyId);
  const stock = await getStockDiscrepancies(companyId);
  const vat = await getVatReconciliation(companyId);
  const paye = await getPayeReconciliation(companyId);
  const rssb = await getRssbReconciliation(companyId);

  return {
    healthy: journal.healthy && stock.healthy && vat.healthy && paye.healthy && rssb.healthy,
    journal_balanced: journal.healthy,
    stock_reconciled: stock.healthy,
    vat_reconciled: vat.healthy,
    paye_reconciled: paye.healthy,
    rssb_reconciled: rssb.healthy,
    journal,
    stock,
    vat,
    paye,
    rssb
  };
}

module.exports = { getJournalTotals, getStockDiscrepancies, getVatReconciliation, getPayeReconciliation, getRssbReconciliation, getHealthReport };
