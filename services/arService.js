const { dbClient } = require('../lib/prisma');
const ARReceipt = require("../models/ARReceipt");
const ARReceiptAllocation = require("../models/ARReceiptAllocation");
const ARBadDebtWriteoff = require("../models/ARBadDebtWriteoff");
const Invoice = require("../models/Invoice");
const Client = require("../models/Client");
const JournalService = require("./journalService");
const periodService = require("./periodService");
const cacheService = require("./cacheService");
const ARTrackingService = require("./arTrackingService");
const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");

/**
 * AR Service - Handles Accounts Receivable operations.
 * All reporting reads use PostgreSQL-backed models or set-based SQL.
 */

class ARService {
  /**
   * Get aging report without loading every invoice and allocation into Node.
   */
  static async getAgingReport(companyId, options = {}) {
    const { clientId, asOfDate } = options;
    const asOf = asOfDate ? new Date(asOfDate) : new Date();
    if (Number.isNaN(asOf.getTime())) throw new Error('Invalid asOfDate');
    const today = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
    const params = [String(companyId), today];
    const clientClause = clientId
      ? (() => { params.push(String(clientId)); return `AND i.client_id = $${params.length}`; })()
      : '';

    const rows = await dbClient().$queryRawUnsafe(`
      WITH invoice_balances AS (
        SELECT i.client_id,
               c.name AS client_name,
               c.code AS client_code,
               GREATEST(
                 i.amount_outstanding - COALESCE(SUM(a.amount_allocated), 0),
                 0
               )::double precision AS balance,
               COALESCE(i.due_date, i.invoice_date)::date AS due_date
          FROM invoices i
          JOIN clients c ON c.id = i.client_id
          LEFT JOIN ar_receipt_allocations a
            ON a.invoice_id = i.id AND a.company_id = i.company_id
         WHERE i.company_id = $1
           AND i.status IN ('sent', 'confirmed', 'partially_paid')
           ${clientClause}
         GROUP BY i.id, i.client_id, c.name, c.code, i.amount_outstanding,
                  i.due_date, i.invoice_date
      ), eligible AS (
        SELECT * FROM invoice_balances WHERE balance > 0
      )
      SELECT client_id AS "clientId",
             client_name AS "clientName",
             client_code AS "clientCode",
             COALESCE(SUM(CASE WHEN due_date >= $2::date THEN balance ELSE 0 END), 0)::double precision AS current,
             COALESCE(SUM(CASE WHEN due_date BETWEEN ($2::date - INTERVAL '30 days') AND ($2::date - INTERVAL '1 day') THEN balance ELSE 0 END), 0)::double precision AS "1-30",
             COALESCE(SUM(CASE WHEN due_date BETWEEN ($2::date - INTERVAL '60 days') AND ($2::date - INTERVAL '31 days') THEN balance ELSE 0 END), 0)::double precision AS "31-60",
             COALESCE(SUM(CASE WHEN due_date BETWEEN ($2::date - INTERVAL '90 days') AND ($2::date - INTERVAL '61 days') THEN balance ELSE 0 END), 0)::double precision AS "61-90",
             COALESCE(SUM(CASE WHEN due_date < ($2::date - INTERVAL '90 days') THEN balance ELSE 0 END), 0)::double precision AS "90+"
        FROM eligible
       GROUP BY client_id, client_name, client_code
       ORDER BY SUM(balance) DESC, client_id`, ...params);

    const data = rows.map((row) => {
      const current = Number(row.current || 0);
      const oneToThirty = Number(row['1-30'] || 0);
      const thirtyOneToSixty = Number(row['31-60'] || 0);
      const sixtyOneToNinety = Number(row['61-90'] || 0);
      const overNinety = Number(row['90+'] || 0);
      return {
        client: { _id: row.clientId, name: row.clientName || 'Unknown', code: row.clientCode || '' },
        current: current.toFixed(2),
        '1-30': oneToThirty.toFixed(2),
        '31-60': thirtyOneToSixty.toFixed(2),
        '61-90': sixtyOneToNinety.toFixed(2),
        '90+': overNinety.toFixed(2),
        totalBalance: (current + oneToThirty + thirtyOneToSixty + sixtyOneToNinety + overNinety).toFixed(2),
      };
    });

    return {
      success: true,
      asOfDate: today,
      data,
    };
  }

  static async writeOffBadDebt(companyId, userId, data) {
    const { invoiceId, writeoffDate, amount, reason, notes } = data;

    const invoice = await Invoice.findOne({
      _id: invoiceId,
      company: companyId,
    });
    if (!invoice) {
      throw new Error("Invoice not found");
    }

    if (invoice.status === "cancelled") {
      throw new Error("Invoice is already written off as bad debt");
    }

    const amountNum = parseFloat(amount) || parseFloat(invoice.balance) || 0;
    if (amountNum <= 0) {
      throw new Error("Invalid write-off amount");
    }

    const targetDate = writeoffDate || new Date();
    if (await periodService.isDateInClosedPeriod(companyId, targetDate)) {
      throw new Error("Target accounting period is closed");
    }

    const client = await Client.findById(invoice.client);
    const clientName = client?.name || "Unknown Client";
    const invoiceRef = invoice.referenceNo || invoice.invoiceNumber || "N/A";

    const writeoff = new ARBadDebtWriteoff({
      invoice: invoiceId,
      client: invoice.client,
      writeoffDate: targetDate,
      amount: amountNum.toFixed(2),
      reason: reason || "Bad debt write-off",
      notes: notes || null,
      status: "draft",
      createdBy: userId,
      company: companyId,
    });

    await writeoff.save();

    try {
      await cacheService.bumpCompanyFinancialCaches(companyId);
    } catch (e) {
      console.error("Cache invalidation failed:", e);
    }

    return writeoff;
  }

  static async postBadDebtWriteoff(companyId, userId, writeoffId) {
    const writeoff = await ARBadDebtWriteoff.findOne({
      _id: writeoffId,
      company: companyId,
    });
    if (!writeoff) throw new Error("Bad debt write-off not found");
    if (writeoff.status !== "draft") {
      const err = new Error("INVALID_STATUS");
      err.status = 400;
      throw err;
    }

    const invoice = await Invoice.findById(writeoff.invoice);
    if (!invoice) throw new Error("Invoice not found");

    const amountNum = parseFloat(writeoff.amount) || 0;
    const client = await Client.findById(writeoff.client);
    const clientName = client?.name || "Unknown Client";
    const invoiceRef = invoice.referenceNo || invoice.invoiceNumber || "N/A";
    const narration = `Bad Debt Write-off - ${clientName} - INV#${invoiceRef}`;

    const bdDebitLine = JournalService.createDebitLine(
      DEFAULT_ACCOUNTS.badDebtExpense || "6100",
      amountNum,
      narration,
    );
    const bdCreditLine = JournalService.createCreditLine(
      await JournalService.getMappedAccountCode(
        companyId,
        "sales",
        "accountsReceivable",
        DEFAULT_ACCOUNTS.accountsReceivable,
      ),
      amountNum,
      narration,
    );

    const bdEntryA = {
      date: writeoff.writeoffDate || new Date(),
      description: narration,
      sourceType: "bad_debt_writeoff",
      sourceId: writeoff._id,
      sourceReference: writeoff.reference || writeoff.referenceNo,
      lines: [bdDebitLine, bdCreditLine],
      isAutoGenerated: true,
    };

    const bdEntries = await JournalService.createEntriesAtomic(companyId, userId, [bdEntryA]);
    const journalEntry = Array.isArray(bdEntries) && bdEntries.length > 0 ? bdEntries[0] : null;

    writeoff.status = "posted";
    if (journalEntry) writeoff.journalEntry = journalEntry._id;
    writeoff.postedBy = userId;
    await writeoff.save();

    const currentOutstanding = parseFloat(invoice.amountOutstanding) || parseFloat(invoice.balance) || 0;
    const newOutstanding = currentOutstanding - amountNum;
    invoice.amountOutstanding = Math.max(0, newOutstanding).toFixed(2);
    invoice.balance = Math.max(0, newOutstanding);

    if (newOutstanding <= 0.01) {
      invoice.status = "cancelled";
      invoice.badDebtWrittenOff = true;
      invoice.writtenOffAt = new Date();
      invoice.writtenOffBy = userId;
      invoice.badDebtReason = writeoff.reason || "Bad debt write-off";
    }
    await invoice.save();

    if (client) {
      client.outstandingBalance = Math.max(0, (client.outstandingBalance || 0) - amountNum);
      await client.save();
    }

    try {
      await cacheService.bumpCompanyFinancialCaches(companyId);
    } catch (e) {
      console.error("Cache invalidation failed:", e);
    }

    try {
      await ARTrackingService.recordBadDebtWriteoff(writeoff, invoice, userId);
    } catch (trackingError) {
      console.error("AR tracking error for bad debt write-off:", trackingError);
    }

    return writeoff;
  }

  static async getClientStatement(companyId, clientId, options = {}) {
    const { startDate, endDate } = options;

    const money = (value) => {
      if (value == null || value === '') return 0;
      if (typeof value === 'object' && value.toString) {
        const n = parseFloat(value.toString());
        return Number.isFinite(n) ? n : 0;
      }
      const n = parseFloat(value);
      return Number.isFinite(n) ? n : 0;
    };

    const invoiceTotal = (inv) => money(inv.totalAmount ?? inv.grandTotal ?? inv.roundedAmount ?? inv.total);
    const invoiceOutstanding = (inv) => money(inv.amountOutstanding ?? inv.balance ?? Math.max(0, invoiceTotal(inv) - money(inv.amountPaid)));

    const client = await Client.findOne({ _id: clientId, company: companyId });
    if (!client) {
      throw new Error("Client not found");
    }

    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    const invoiceQuery = {
      client: clientId,
      company: companyId,
      status: { $nin: ['draft'] },
    };
    if (startDate || endDate) invoiceQuery.invoiceDate = dateFilter;
    const invoices = await Invoice.find(invoiceQuery)
      .populate("createdBy", "name")
      .sort({ invoiceDate: 1 });

    const receiptQuery = {
      client: clientId,
      company: companyId,
      status: { $nin: ['draft', 'cancelled', 'reversed'] },
    };
    if (startDate || endDate) receiptQuery.receiptDate = dateFilter;
    const receipts = await ARReceipt.find(receiptQuery).sort({ receiptDate: 1 });

    const receiptIds = receipts.map((r) => r._id);
    const allocations = receiptIds.length
      ? await ARReceiptAllocation.find({
          receipt: { $in: receiptIds },
          company: companyId,
        }).populate("invoice", "invoiceNumber referenceNo")
      : [];

    const ledgerEvents = [];
    for (const inv of invoices) {
      const total = invoiceTotal(inv);
      if (total <= 0 && inv.status === 'cancelled') continue;
      ledgerEvents.push({
        sortDate: new Date(inv.invoiceDate || inv.date || 0),
        date: inv.invoiceDate || inv.date,
        reference: inv.referenceNo || inv.invoiceNumber || String(inv._id),
        description: `Invoice ${inv.referenceNo || inv.invoiceNumber || ''}`.trim(),
        debit: total,
        credit: 0,
        type: 'invoice',
        sourceId: String(inv._id),
      });

      const embeddedPayments = Array.isArray(inv.payments) ? inv.payments : [];
      for (const payment of embeddedPayments) {
        const amount = money(payment.amount ?? payment.amountReceived ?? payment.total);
        if (amount <= 0) continue;
        const payDate = payment.date || payment.paymentDate || payment.paidAt || inv.paidDate || inv.invoiceDate;
        ledgerEvents.push({
          sortDate: new Date(payDate || 0),
          date: payDate,
          reference: payment.reference || payment.referenceNo || inv.referenceNo || 'PAYMENT',
          description: payment.notes || payment.method
            ? `Payment${payment.method ? ` (${payment.method})` : ''} · ${inv.referenceNo || inv.invoiceNumber || ''}`
            : `Payment on ${inv.referenceNo || inv.invoiceNumber || 'invoice'}`,
          debit: 0,
          credit: amount,
          type: 'payment',
          sourceId: String(inv._id),
        });
      }
    }

    for (const rec of receipts) {
      const amount = money(rec.amountReceived ?? rec.amount);
      if (amount <= 0) continue;
      const recAllocs = allocations.filter((a) => String(a.receipt?._id || a.receipt) === String(rec._id));
      const allocLabel = recAllocs.length
        ? recAllocs.map((a) => a.invoice?.referenceNo || a.invoice?.invoiceNumber).filter(Boolean).join(', ')
        : null;
      ledgerEvents.push({
        sortDate: new Date(rec.receiptDate || 0),
        date: rec.receiptDate,
        reference: rec.referenceNo || rec.reference || String(rec._id),
        description: allocLabel ? `Receipt allocated to ${allocLabel}` : `Customer receipt`,
        debit: 0,
        credit: amount,
        type: 'receipt',
        sourceId: String(rec._id),
      });
    }

    ledgerEvents.sort((a, b) => {
      const diff = a.sortDate.getTime() - b.sortDate.getTime();
      if (diff !== 0) return diff;
      if (a.type === 'invoice' && b.type !== 'invoice') return -1;
      if (b.type === 'invoice' && a.type !== 'invoice') return 1;
      return 0;
    });

    let running = 0;
    const transactions = ledgerEvents.map((event) => {
      running = Math.round((running + event.debit - event.credit) * 100) / 100;
      return {
        date: event.date,
        reference: event.reference,
        description: event.description,
        debit: event.debit > 0 ? Math.round(event.debit * 100) / 100 : 0,
        credit: event.credit > 0 ? Math.round(event.credit * 100) / 100 : 0,
        runningBalance: running,
        type: event.type,
      };
    });

    const mappedInvoices = invoices.map((inv) => ({
      id: inv._id,
      _id: inv._id,
      reference: inv.referenceNo || inv.invoiceNumber,
      invoiceNumber: inv.invoiceNumber || inv.referenceNo,
      date: inv.invoiceDate,
      invoiceDate: inv.invoiceDate,
      dueDate: inv.dueDate,
      total: invoiceTotal(inv),
      paid: money(inv.amountPaid),
      balance: invoiceOutstanding(inv),
      status: inv.status,
    }));

    const mappedReceipts = receipts.map((rec) => ({
      id: rec._id,
      _id: rec._id,
      reference: rec.referenceNo,
      date: rec.receiptDate,
      amount: money(rec.amountReceived ?? rec.amount),
      status: rec.status,
      allocations: allocations
        .filter((a) => String(a.receipt?._id || a.receipt) === String(rec._id))
        .map((a) => ({
          invoiceReference: a.invoice?.referenceNo || a.invoice?.invoiceNumber,
          amount: money(a.amountAllocated),
        })),
    }));

    const totalInvoiced = mappedInvoices.reduce((sum, inv) => sum + inv.total, 0);
    const totalPaidFromInvoices = mappedInvoices.reduce((sum, inv) => sum + inv.paid, 0);
    const totalPaidFromReceipts = mappedReceipts.reduce((sum, rec) => sum + rec.amount, 0);
    const totalPaid = totalPaidFromInvoices > 0 ? totalPaidFromInvoices : totalPaidFromReceipts;
    const totalOutstanding = mappedInvoices.reduce((sum, inv) => sum + inv.balance, 0);

    return {
      success: true,
      data: {
        client: { _id: client._id, name: client.name, code: client.code },
        period: { startDate: startDate || null, endDate: endDate || null },
        invoices: mappedInvoices,
        receipts: mappedReceipts,
        transactions,
        summary: {
          totalInvoices: Math.round(totalInvoiced * 100) / 100,
          totalInvoiced: Math.round(totalInvoiced * 100) / 100,
          totalPaid: Math.round(totalPaid * 100) / 100,
          totalOutstanding: Math.round(totalOutstanding * 100) / 100,
          balance: Math.round(totalOutstanding * 100) / 100,
          invoiceCount: invoices.length,
        },
      },
    };
  }
}

module.exports = ARService;
