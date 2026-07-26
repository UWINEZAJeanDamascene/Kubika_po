/**
 * Build AR/AP ledger views from PostgreSQL-backed source documents.
 * Used while ARTransactionLedger / APTransactionLedger remain on MongoDB.
 */

const Invoice = require('../models/Invoice');
const CreditNote = require('../models/CreditNote');
const ARReceipt = require('../models/ARReceipt');
const GoodsReceivedNote = require('../models/GoodsReceivedNote');
const APPayment = require('../models/APPayment');
const Purchase = require('../models/Purchase');

function money(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function inDateRange(date, startDate, endDate) {
  const d = new Date(date);
  if (startDate && d < new Date(startDate)) return false;
  if (endDate && d > new Date(endDate)) return false;
  return true;
}

function paginate(items, page, limit) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (currentPage - 1) * limit;
  return {
    items: items.slice(start, start + limit),
    total,
    pages,
    currentPage,
  };
}

async function getARTransactions(companyId, filters = {}, { page = 1, limit = 50 } = {}) {
  const {
    clientId,
    invoiceId,
    transactionType,
    startDate,
    endDate,
    reconciliationStatus,
  } = filters;

  const transactions = [];
  const typeFilter = transactionType || null;

  if (!typeFilter || typeFilter === 'invoice_created') {
    const invoiceQuery = {
      company: companyId,
      status: { $in: ['confirmed', 'partially_paid', 'fully_paid'] },
    };
    if (clientId) invoiceQuery.client = clientId;
    if (invoiceId) invoiceQuery._id = invoiceId;

    const invoices = await Invoice.find(invoiceQuery).populate('client');
    for (const inv of invoices) {
      const txDate = inv.confirmedDate || inv.invoiceDate || inv.createdAt;
      if (!inDateRange(txDate, startDate, endDate)) continue;
      transactions.push({
        _id: `ar-inv-${inv._id}`,
        transactionDate: txDate,
        client: inv.client,
        invoice: { _id: inv._id, referenceNo: inv.referenceNo || inv.invoiceNumber },
        transactionType: 'invoice_created',
        referenceNo: inv.referenceNo || inv.invoiceNumber,
        description: `Invoice ${inv.referenceNo || inv.invoiceNumber} created`,
        amount: money(inv.totalAmount || inv.grandTotal || inv.roundedAmount),
        direction: 'increase',
        reconciliationStatus: reconciliationStatus || 'pending',
      });
    }
  }

  if (!typeFilter || typeFilter === 'credit_note_applied') {
    const cnQuery = {
      company: companyId,
      status: { $in: ['confirmed', 'issued', 'applied'] },
    };
    if (clientId) cnQuery.client = clientId;
    if (invoiceId) cnQuery.invoice = invoiceId;

    const creditNotes = await CreditNote.find(cnQuery).populate('client invoice');
    for (const cn of creditNotes) {
      const txDate = cn.creditDate || cn.createdAt;
      if (!inDateRange(txDate, startDate, endDate)) continue;
      transactions.push({
        _id: `ar-cn-${cn._id}`,
        transactionDate: txDate,
        client: cn.client,
        invoice: cn.invoice,
        transactionType: 'credit_note_applied',
        referenceNo: cn.referenceNo || cn.creditNoteNumber,
        description: `Credit note ${cn.referenceNo || cn.creditNoteNumber}`,
        amount: money(cn.totalAmount || cn.grandTotal),
        direction: 'decrease',
        reconciliationStatus: reconciliationStatus || 'pending',
      });
    }
  }

  if (!typeFilter || typeFilter === 'receipt_posted' || typeFilter === 'payment_recorded') {
    const receiptQuery = {
      company: companyId,
      status: { $in: ['posted', 'confirmed'] },
    };
    if (clientId) receiptQuery.client = clientId;

    const receipts = await ARReceipt.find(receiptQuery).populate('client');
    for (const rc of receipts) {
      const txDate = rc.receiptDate || rc.postedAt || rc.createdAt;
      if (!inDateRange(txDate, startDate, endDate)) continue;
      transactions.push({
        _id: `ar-rc-${rc._id}`,
        transactionDate: txDate,
        client: rc.client,
        transactionType: 'receipt_posted',
        referenceNo: rc.referenceNo,
        description: `Receipt ${rc.referenceNo}`,
        amount: money(rc.amountReceived),
        direction: 'decrease',
        reconciliationStatus: reconciliationStatus || 'pending',
      });
    }
  }

  transactions.sort((a, b) => new Date(b.transactionDate) - new Date(a.transactionDate));
  return paginate(transactions, page, limit);
}

async function getAPTransactions(companyId, filters = {}, { page = 1, limit = 50 } = {}) {
  const {
    supplierId,
    transactionType,
    startDate,
    endDate,
    reconciliationStatus,
  } = filters;

  const transactions = [];
  const typeFilter = transactionType || null;

  if (!typeFilter || typeFilter === 'grn_received') {
    const grnQuery = {
      company: companyId,
      status: { $in: ['confirmed', 'posted', 'partially_paid', 'fully_paid'] },
    };
    if (supplierId) grnQuery.supplier = supplierId;

    const grns = await GoodsReceivedNote.find(grnQuery).populate('supplier');
    for (const grn of grns) {
      const txDate = grn.receivedDate || grn.grnDate || grn.createdAt;
      if (!inDateRange(txDate, startDate, endDate)) continue;
      transactions.push({
        _id: `ap-grn-${grn._id}`,
        transactionDate: txDate,
        supplier: grn.supplier,
        grn: { _id: grn._id, referenceNo: grn.referenceNo || grn.grnNumber },
        transactionType: 'grn_received',
        referenceNo: grn.referenceNo || grn.grnNumber,
        description: `GRN ${grn.referenceNo || grn.grnNumber} received`,
        amount: money(grn.totalAmount || grn.grandTotal),
        direction: 'increase',
        reconciliationStatus: reconciliationStatus || 'pending',
      });
    }
  }

  if (!typeFilter || typeFilter === 'grn_received') {
    const purchaseQuery = {
      company: companyId,
      status: { $in: ['confirmed', 'posted', 'partially_paid', 'fully_paid'] },
    };
    if (supplierId) purchaseQuery.supplier = supplierId;

    const purchases = await Purchase.find(purchaseQuery).populate('supplier');
    for (const pur of purchases) {
      const txDate = pur.purchaseDate || pur.supplierInvoiceDate || pur.createdAt;
      if (!inDateRange(txDate, startDate, endDate)) continue;
      transactions.push({
        _id: `ap-pur-${pur._id}`,
        transactionDate: txDate,
        supplier: pur.supplier,
        transactionType: 'grn_received',
        referenceNo: pur.purchaseNumber || pur.referenceNo,
        description: `Purchase ${pur.purchaseNumber || pur.referenceNo}`,
        amount: money(pur.totalAmount || pur.grandTotal),
        direction: 'increase',
        reconciliationStatus: reconciliationStatus || 'pending',
      });
    }
  }

  if (!typeFilter || typeFilter === 'payment_posted') {
    const paymentQuery = {
      company: companyId,
      status: { $in: ['posted', 'confirmed'] },
    };
    if (supplierId) paymentQuery.supplier = supplierId;

    const payments = await APPayment.find(paymentQuery).populate('supplier');
    for (const pay of payments) {
      const txDate = pay.paymentDate || pay.postedAt || pay.createdAt;
      if (!inDateRange(txDate, startDate, endDate)) continue;
      transactions.push({
        _id: `ap-pay-${pay._id}`,
        transactionDate: txDate,
        supplier: pay.supplier,
        payment: { _id: pay._id, referenceNo: pay.referenceNo },
        transactionType: 'payment_posted',
        referenceNo: pay.referenceNo,
        description: `Payment ${pay.referenceNo}`,
        amount: money(pay.amountPaid || pay.totalAmount),
        direction: 'decrease',
        reconciliationStatus: reconciliationStatus || 'pending',
      });
    }
  }

  transactions.sort((a, b) => new Date(b.transactionDate) - new Date(a.transactionDate));
  return paginate(transactions, page, limit);
}

module.exports = {
  getARTransactions,
  getAPTransactions,
};
