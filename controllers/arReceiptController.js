const { dbClient } = require('../lib/prisma');
const { runInPrismaTransaction } = require('../services/transactionService');
const { generateUniqueNumber } = require('../models/utils/autoIncrement');
const ARReceipt = require('../models/ARReceipt');
const JournalService = require('../services/journalService');
const periodService = require('../services/periodService');
const cacheService = require('../services/cacheService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const { generateObjectId } = require('../utils/objectId');

const money = (value) => Number(Number(value || 0).toFixed(2));
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const companyOf = (req) => String(req.user.company._id || req.user.company.id);
const userOf = (req) => String(req.user.id || req.user._id);

function receiptView(row) {
  if (!row) return null;
  const { allocations = [], client, bankAccount, ...receipt } = row;
  return {
    ...receipt,
    _id: row.id,
    company: row.companyId,
    client: client ? { _id: client.id, name: client.name, code: client.code } : { _id: row.clientId },
    bankAccount: bankAccount ? { _id: bankAccount.id, name: bankAccount.name, accountNumber: bankAccount.accountNumber } : null,
    amountReceived: String(row.amountReceived),
    unallocatedAmount: String(row.unallocatedAmount),
    allocations: allocations.map((allocation) => ({
      ...allocation,
      _id: allocation.id,
      invoice: allocation.invoice ? {
        _id: allocation.invoice.id,
        invoiceNumber: allocation.invoice.referenceNo,
        referenceNo: allocation.invoice.referenceNo,
        amountOutstanding: String(allocation.invoice.amountOutstanding),
      } : { _id: allocation.invoiceId },
      amountAllocated: String(allocation.amountAllocated),
    })),
  };
}

const receiptInclude = {
  client: { select: { id: true, name: true, code: true } },
  bankAccount: { select: { id: true, name: true, accountNumber: true } },
  allocations: { include: { invoice: { select: { id: true, referenceNo: true, amountOutstanding: true } } } },
};

exports.getReceipts = async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const where = { companyId };
    if (req.query.clientId) where.clientId = String(req.query.clientId);
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.startDate || req.query.endDate) {
      where.receiptDate = {};
      if (req.query.startDate) {
        where.receiptDate.gte = new Date(req.query.startDate);
        if (Number.isNaN(where.receiptDate.gte.getTime())) throw error(400, 'INVALID_DATE_FILTER', 'Start date is invalid.');
      }
      if (req.query.endDate) {
        where.receiptDate.lte = new Date(req.query.endDate);
        if (Number.isNaN(where.receiptDate.lte.getTime())) throw error(400, 'INVALID_DATE_FILTER', 'End date is invalid.');
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.endDate))) where.receiptDate.lte.setHours(23, 59, 59, 999);
      }
    }
    const [total, rows] = await Promise.all([
      dbClient().aRReceipt.count({ where }),
      dbClient().aRReceipt.findMany({ where, include: receiptInclude, orderBy: [{ receiptDate: 'desc' }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
    ]);
    res.json({ success: true, count: total, total, pages: Math.ceil(total / limit), currentPage: page, data: rows.map(receiptView) });
  } catch (err) { next(err); }
};

exports.getReceipt = async (req, res, next) => {
  try {
    const row = await dbClient().aRReceipt.findFirst({ where: { id: String(req.params.id), companyId: companyOf(req) }, include: receiptInclude });
    if (!row) throw error(404, 'AR_RECEIPT_NOT_FOUND', 'Receipt not found');
    const data = receiptView(row);
    res.json({ success: true, data, allocations: data.allocations });
  } catch (err) { next(err); }
};

exports.createReceipt = async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const clientId = String(req.body.client || req.body.clientId || '');
    const amount = money(req.body.amountReceived);
    const receiptDate = req.body.receiptDate ? new Date(req.body.receiptDate) : new Date();
    if (!clientId || !Number.isFinite(amount) || amount <= 0 || Number.isNaN(receiptDate.getTime())) {
      throw error(400, 'INVALID_AR_RECEIPT', 'Client, a positive receipt amount, and a valid receipt date are required.');
    }
    const prisma = dbClient();
    const [client, bank] = await Promise.all([
      prisma.client.findFirst({ where: { id: clientId, companyId }, select: { id: true } }),
      req.body.bankAccount || req.body.bankAccountId
        ? prisma.bankAccount.findFirst({ where: { id: String(req.body.bankAccount || req.body.bankAccountId), companyId, isActive: true }, select: { id: true } })
        : Promise.resolve(null),
    ]);
    if (!client) throw error(404, 'CLIENT_NOT_FOUND', 'Customer was not found in this company.');
    const method = String(req.body.paymentMethod || 'cash').toLowerCase();
    if (!['bank_transfer', 'cash', 'cheque', 'card', 'mobile_money', 'other'].includes(method)) {
      throw error(400, 'INVALID_PAYMENT_METHOD', 'Select a supported customer payment method.');
    }
    if (['bank_transfer', 'cheque', 'mobile_money', 'card'].includes(method) && !bank) {
      throw error(400, 'BANK_ACCOUNT_REQUIRED', 'Select an active bank or mobile-money account for this payment method.');
    }
    const referenceNo = req.body.referenceNo || await generateUniqueNumber('RCP', ARReceipt, companyId, 'referenceNo');
    const currencyCode = String(req.body.currencyCode || 'RWF').toUpperCase();
    const exchangeRate = req.body.exchangeRate === undefined && currencyCode === 'RWF' ? 1 : Number(req.body.exchangeRate);
    if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) throw error(400, 'INVALID_EXCHANGE_RATE', 'Exchange rate must be greater than zero.');
    const requestedAllocations = Array.isArray(req.body.allocations) ? req.body.allocations : [];
    const invoiceIds = requestedAllocations.map((allocation) => String(allocation.invoiceId || allocation.invoice || ''));
    if (invoiceIds.some((id) => !id) || new Set(invoiceIds).size !== invoiceIds.length) throw error(400, 'INVALID_ALLOCATION', 'Each allocation must have one distinct invoice.');
    const allocationAmounts = requestedAllocations.map((allocation) => money(allocation.amount));
    if (allocationAmounts.some((allocationAmount) => !Number.isFinite(allocationAmount) || allocationAmount <= 0)) throw error(400, 'INVALID_ALLOCATION', 'Allocation amounts must be valid positive numbers.');
    const allocatedTotal = money(allocationAmounts.reduce((sum, allocationAmount) => sum + allocationAmount, 0));
    if (allocatedTotal > amount + 0.009) throw error(400, 'ALLOCATION_EXCEEDS_RECEIPT', 'Invoice allocations cannot exceed the receipt amount.');
    const row = await runInPrismaTransaction(async (tx) => {
      const invoices = invoiceIds.length ? await tx.invoice.findMany({ where: { id: { in: invoiceIds }, companyId, clientId, status: { in: ['sent', 'confirmed', 'partially_paid'] } } }) : [];
      if (invoices.length !== invoiceIds.length) throw error(400, 'INVOICE_NOT_ALLOCATABLE', 'Every allocated invoice must belong to this customer and be sent or confirmed.');
      const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
      requestedAllocations.forEach((allocation, index) => {
        const invoice = invoiceById.get(invoiceIds[index]);
        if (money(invoice.amountOutstanding) + 0.009 < allocationAmounts[index]) throw error(400, 'ALLOCATION_EXCEEDS_INVOICE', `Allocation exceeds outstanding balance for invoice ${invoice.referenceNo}.`);
        if (String(invoice.currencyCode || 'RWF').toUpperCase() !== currencyCode) throw error(400, 'CURRENCY_MISMATCH', `Invoice ${invoice.referenceNo} uses a different currency.`);
      });
      const created = await tx.aRReceipt.create({ data: {
        id: generateObjectId(), companyId, referenceNo, clientId,
        receiptDate, paymentMethod: method,
        bankAccountId: bank?.id || null,
        amountReceived: amount, currencyCode, exchangeRate,
        reference: req.body.reference ? String(req.body.reference).trim() : null,
        status: 'draft', unallocatedAmount: money(amount - allocatedTotal),
        notes: req.body.notes ? String(req.body.notes).trim() : null,
        createdById: userOf(req),
      } });
      if (requestedAllocations.length) {
        await tx.aRReceiptAllocation.createMany({ data: requestedAllocations.map((_, index) => ({
          id: generateObjectId(), companyId, receiptId: created.id, invoiceId: invoiceIds[index],
          amountAllocated: allocationAmounts[index], createdById: userOf(req),
        })) });
      }
      return tx.aRReceipt.findFirst({ where: { id: created.id }, include: receiptInclude });
    });
    res.status(201).json({ success: true, data: receiptView(row) });
  } catch (err) { next(err); }
};

exports.updateReceipt = async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const receiptId = String(req.params.id);
    const row = await dbClient().aRReceipt.findFirst({ where: { id: receiptId, companyId }, include: { allocations: true } });
    if (!row) throw error(404, 'AR_RECEIPT_NOT_FOUND', 'Receipt not found');
    if (row.status !== 'draft') throw error(409, 'AR_RECEIPT_LOCKED', 'Only draft receipts can be edited. Reverse a posted receipt and create a corrected receipt.');
    const data = {};
    const requestedAllocations = Array.isArray(req.body.allocations) ? req.body.allocations : null;
    if (req.body.receiptDate !== undefined) {
      const date = new Date(req.body.receiptDate);
      if (Number.isNaN(date.getTime())) throw error(400, 'INVALID_RECEIPT_DATE', 'Receipt date is invalid.');
      data.receiptDate = date;
    }
    if (req.body.paymentMethod !== undefined) {
      const method = String(req.body.paymentMethod).toLowerCase();
      if (!['bank_transfer', 'cash', 'cheque', 'card', 'mobile_money', 'other'].includes(method)) throw error(400, 'INVALID_PAYMENT_METHOD', 'Select a supported customer payment method.');
      data.paymentMethod = method;
    }
    if (req.body.reference !== undefined) data.reference = req.body.reference ? String(req.body.reference).trim() : null;
    if (req.body.notes !== undefined) data.notes = req.body.notes ? String(req.body.notes).trim() : null;
    if (req.body.amountReceived !== undefined) {
      const amount = money(req.body.amountReceived);
      const allocated = requestedAllocations
        ? requestedAllocations.reduce((sum, item) => sum + money(item.amount), 0)
        : row.allocations.reduce((sum, item) => sum + Number(item.amountAllocated), 0);
      if (!Number.isFinite(amount) || amount <= 0 || amount < allocated) throw error(400, 'AMOUNT_BELOW_ALLOCATIONS', 'Receipt amount must be a valid positive amount and cannot be less than the allocations.');
      data.amountReceived = amount;
      data.unallocatedAmount = money(amount - allocated);
    }
    const bankId = req.body.bankAccount ?? req.body.bankAccountId;
    if (bankId !== undefined) {
      if (bankId) {
        const bank = await dbClient().bankAccount.findFirst({ where: { id: String(bankId), companyId, isActive: true }, select: { id: true } });
        if (!bank) throw error(400, 'INVALID_BANK_ACCOUNT', 'Select an active bank account from this company.');
        data.bankAccountId = bank.id;
      } else data.bankAccountId = null;
    }
    const resultingMethod = data.paymentMethod || row.paymentMethod;
    const resultingBankId = data.bankAccountId !== undefined ? data.bankAccountId : row.bankAccountId;
    if (['bank_transfer', 'cheque', 'mobile_money', 'card'].includes(resultingMethod) && !resultingBankId) throw error(400, 'BANK_ACCOUNT_REQUIRED', 'Select an active bank, card-clearing, or mobile-money account for this payment method.');
    const saved = await runInPrismaTransaction(async (tx) => {
      const current = await tx.aRReceipt.findFirst({ where: { id: receiptId, companyId }, include: { allocations: true } });
      if (!current || current.status !== 'draft') throw error(409, 'AR_RECEIPT_LOCKED', 'This receipt was changed. Refresh and edit a draft receipt.');
      const amount = money(data.amountReceived ?? current.amountReceived);
      if (requestedAllocations) {
        const invoiceIds = requestedAllocations.map((allocation) => String(allocation.invoiceId || allocation.invoice || ''));
        const allocationAmounts = requestedAllocations.map((allocation) => money(allocation.amount));
        if (invoiceIds.some((id) => !id) || new Set(invoiceIds).size !== invoiceIds.length || allocationAmounts.some((value) => !Number.isFinite(value) || value <= 0)) throw error(400, 'INVALID_ALLOCATION', 'Provide a valid positive amount for each distinct invoice.');
        const allocatedTotal = money(allocationAmounts.reduce((sum, value) => sum + value, 0));
        if (allocatedTotal > amount + 0.009) throw error(400, 'ALLOCATION_EXCEEDS_RECEIPT', 'Invoice allocations cannot exceed the receipt amount.');
        const invoices = invoiceIds.length ? await tx.invoice.findMany({ where: { id: { in: invoiceIds }, companyId, clientId: current.clientId, status: { in: ['sent', 'confirmed', 'partially_paid'] } } }) : [];
        if (invoices.length !== invoiceIds.length) throw error(400, 'INVOICE_NOT_ALLOCATABLE', 'Every allocated invoice must belong to this customer and be sent or confirmed.');
        const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
        requestedAllocations.forEach((_, index) => {
          const invoice = invoiceById.get(invoiceIds[index]);
          const existingAmount = money(current.allocations.find((allocation) => allocation.invoiceId === invoiceIds[index])?.amountAllocated);
          if (money(invoice.amountOutstanding) + existingAmount + 0.009 < allocationAmounts[index]) throw error(400, 'ALLOCATION_EXCEEDS_INVOICE', `Allocation exceeds outstanding balance for invoice ${invoice.referenceNo}.`);
          if (String(invoice.currencyCode || 'RWF').toUpperCase() !== String(current.currencyCode || 'RWF').toUpperCase()) throw error(400, 'CURRENCY_MISMATCH', `Invoice ${invoice.referenceNo} uses a different currency.`);
        });
        const nextIds = new Set(invoiceIds);
        for (const existing of current.allocations) {
          if (!nextIds.has(existing.invoiceId)) await tx.aRReceiptAllocation.delete({ where: { id: existing.id } });
        }
        for (let index = 0; index < requestedAllocations.length; index += 1) {
          const existing = current.allocations.find((allocation) => allocation.invoiceId === invoiceIds[index]);
          if (existing) await tx.aRReceiptAllocation.update({ where: { id: existing.id }, data: { amountAllocated: allocationAmounts[index] } });
          else await tx.aRReceiptAllocation.create({ data: { id: generateObjectId(), companyId, receiptId, invoiceId: invoiceIds[index], amountAllocated: allocationAmounts[index], createdById: userOf(req) } });
        }
        data.unallocatedAmount = money(amount - allocatedTotal);
      }
      return tx.aRReceipt.update({ where: { id: receiptId }, data, include: receiptInclude });
    });
    res.json({ success: true, data: receiptView(saved) });
  } catch (err) { next(err); }
};

exports.allocateReceipt = async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const receiptId = String(req.params.id);
    const invoiceId = String(req.body.invoiceId || '');
    const amount = money(req.body.amount);
    if (!invoiceId || !Number.isFinite(amount) || amount <= 0) throw error(400, 'INVALID_ALLOCATION', 'Invoice and a valid positive allocation amount are required.');
    await runInPrismaTransaction(async (tx) => {
      const receipt = await tx.aRReceipt.findFirst({ where: { id: receiptId, companyId }, include: { allocations: true } });
      if (!receipt) throw error(404, 'AR_RECEIPT_NOT_FOUND', 'Receipt not found');
      if (!['draft', 'posted'].includes(receipt.status)) throw error(409, 'AR_RECEIPT_LOCKED', 'Allocations cannot be changed on a reversed receipt.');
      const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, companyId, clientId: receipt.clientId, status: { in: ['sent', 'confirmed', 'partially_paid'] } } });
      if (!invoice) throw error(404, 'INVOICE_NOT_ALLOCATABLE', 'Invoice must belong to this customer and be sent or confirmed.');
      const outstanding = money(invoice.amountOutstanding);
      if (amount > outstanding + 0.009) throw error(400, 'ALLOCATION_EXCEEDS_INVOICE', `Allocation exceeds invoice outstanding balance (${outstanding.toFixed(2)}).`);
      const existing = receipt.allocations.find((item) => item.invoiceId === invoiceId);
      if (receipt.status === 'posted' && existing) throw error(409, 'AR_RECEIPT_LOCKED', 'A posted allocation cannot be edited. Reverse the receipt to correct it.');
      const currentAllocation = existing ? money(existing.amountAllocated) : 0;
      const availableReceipt = money(Number(receipt.unallocatedAmount) + currentAllocation);
      if (amount > availableReceipt + 0.009) throw error(400, 'ALLOCATION_EXCEEDS_RECEIPT', `Allocation exceeds unapplied receipt amount (${availableReceipt.toFixed(2)}).`);
      const delta = money(amount - currentAllocation);
      const reserve = await tx.aRReceipt.updateMany({
        where: { id: receiptId, companyId, status: receipt.status, ...(delta > 0 ? { unallocatedAmount: { gte: delta } } : {}) },
        data: { unallocatedAmount: delta > 0 ? { decrement: delta } : { increment: Math.abs(delta) } },
      });
      if (reserve.count !== 1) throw error(409, 'RECEIPT_CHANGED', 'The unapplied amount changed. Reload the receipt and retry.');
      if (existing) await tx.aRReceiptAllocation.update({ where: { id: existing.id }, data: { amountAllocated: amount } });
      else await tx.aRReceiptAllocation.create({ data: { id: generateObjectId(), companyId, receiptId, invoiceId, amountAllocated: amount, createdById: userOf(req) } });

      if (receipt.status === 'posted') {
        const allocationId = existing?.id || (await tx.aRReceiptAllocation.findUnique({ where: { receiptId_invoiceId: { receiptId, invoiceId } }, select: { id: true } }))?.id;
        const arCode = await JournalService.getMappedAccountCode(companyId, 'sales', 'accountsReceivable', DEFAULT_ACCOUNTS.accountsReceivable);
        const advanceCode = await JournalService.getMappedAccountCode(companyId, 'sales', 'customerAdvances', DEFAULT_ACCOUNTS.customerAdvances);
        const description = `Apply receipt ${receipt.referenceNo} to invoice ${invoice.referenceNo}`;
        const entry = await JournalService.createEntry(companyId, userOf(req), {
          date: new Date(), description, sourceType: 'ar_receipt_allocation', sourceId: allocationId,
          sourceReference: receipt.referenceNo,
          lines: [JournalService.createDebitLine(advanceCode, amount, description), JournalService.createCreditLine(arCode, amount, description)],
          isAutoGenerated: true, sourceData: { receiptId, invoiceId, amount },
        });
        const invoiceChanged = await tx.invoice.updateMany({ where: { id: invoice.id, companyId, amountOutstanding: { gte: amount } }, data: { amountPaid: { increment: amount }, amountOutstanding: { decrement: amount } } });
        if (invoiceChanged.count !== 1) throw error(409, 'INVOICE_BALANCE_CHANGED', 'The invoice balance changed; reload and try again.');
        const updatedInvoice = await tx.invoice.findUnique({ where: { id: invoice.id }, select: { amountOutstanding: true } });
        const newOutstanding = money(updatedInvoice.amountOutstanding);
        await tx.invoice.update({ where: { id: invoice.id }, data: { status: newOutstanding <= 0.009 ? 'fully_paid' : 'partially_paid', ...(newOutstanding <= 0.009 ? { paidDate: new Date() } : {}) } });
        const openInvoices = await tx.invoice.aggregate({ where: { companyId, clientId: receipt.clientId, status: { in: ['sent', 'confirmed', 'partially_paid'] } }, _sum: { amountOutstanding: true } });
        await tx.client.update({ where: { id: receipt.clientId }, data: { outstandingBalance: openInvoices._sum.amountOutstanding || 0 } });
        await tx.arTransactionLedger.create({ data: {
          id: generateObjectId(), companyId, clientId: receipt.clientId, invoiceId: invoice.id, receiptId,
          transactionType: 'allocation_made', transactionDate: new Date(), referenceNo: receipt.referenceNo,
          description, amount, direction: 'decrease', invoiceBalanceAfter: newOutstanding,
          sourceType: 'ar_receipt_allocation', sourceId: allocationId, sourceReference: receipt.referenceNo,
          journalEntryId: entry?._id || entry?.id || null, reconciliationStatus: 'verified', createdById: userOf(req),
        } });
      }
    });
    const saved = await dbClient().aRReceipt.findFirst({ where: { id: receiptId, companyId }, include: receiptInclude });
    res.json({ success: true, data: receiptView(saved) });
  } catch (err) { next(err); }
};

exports.postReceipt = async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const receiptId = String(req.params.id);
    const userId = userOf(req);
    await runInPrismaTransaction(async (tx) => {
      const receipt = await tx.aRReceipt.findFirst({ where: { id: receiptId, companyId }, include: { client: true, allocations: { include: { invoice: true } }, bankAccount: true } });
      if (!receipt) throw error(404, 'AR_RECEIPT_NOT_FOUND', 'Receipt not found');
      if (receipt.status !== 'draft') throw error(409, 'AR_RECEIPT_NOT_DRAFT', 'Only a draft receipt can be posted.');
      const claimed = await tx.aRReceipt.updateMany({ where: { id: receiptId, companyId, status: 'draft' }, data: { status: 'posting' } });
      if (claimed.count !== 1) throw error(409, 'AR_RECEIPT_NOT_DRAFT', 'This receipt has already been posted or changed.');
      const date = new Date(receipt.receiptDate);
      if (await periodService.isDateInClosedPeriod(companyId, date)) throw error(409, 'PERIOD_CLOSED', 'Receipt date is in a closed accounting period.');
      const amount = money(receipt.amountReceived);
      const allocated = receipt.allocations.reduce((sum, allocation) => sum + Number(allocation.amountAllocated), 0);
      const unapplied = money(amount - allocated);
      if (allocated > amount + 0.009) throw error(409, 'ALLOCATION_EXCEEDS_RECEIPT', 'Receipt allocations exceed the receipt amount.');
      for (const allocation of receipt.allocations) {
        const inv = allocation.invoice;
        if (!inv || inv.companyId !== companyId || inv.clientId !== receipt.clientId || !['sent', 'confirmed', 'partially_paid'].includes(inv.status)) throw error(409, 'INVOICE_NO_LONGER_ALLOCATABLE', 'An allocated invoice is no longer eligible. Refresh the receipt allocations.');
        if (Number(allocation.amountAllocated) > Number(inv.amountOutstanding) + 0.009) throw error(409, 'INVOICE_BALANCE_CHANGED', `Invoice ${inv.referenceNo} no longer has enough outstanding balance.`);
      }

      const cashCode = receipt.bankAccount?.ledgerAccountId || (receipt.paymentMethod === 'mobile_money' ? DEFAULT_ACCOUNTS.mtnMoMo : (receipt.paymentMethod === 'bank_transfer' || receipt.paymentMethod === 'cheque' ? DEFAULT_ACCOUNTS.cashAtBank : DEFAULT_ACCOUNTS.cashInHand));
      const arCode = await JournalService.getMappedAccountCode(companyId, 'sales', 'accountsReceivable', DEFAULT_ACCOUNTS.accountsReceivable);
      const advanceCode = await JournalService.getMappedAccountCode(companyId, 'sales', 'customerAdvances', DEFAULT_ACCOUNTS.customerAdvances);
      const narration = `Customer receipt ${receipt.referenceNo} - ${receipt.client.name}`;
      const lines = [JournalService.createDebitLine(cashCode, amount, narration)];
      if (allocated > 0) lines.push(JournalService.createCreditLine(arCode, allocated, `${narration} allocated to invoices`));
      if (unapplied > 0) lines.push(JournalService.createCreditLine(advanceCode, unapplied, `${narration} unapplied customer credit`));
      const entry = await JournalService.createEntry(companyId, userId, {
        date, description: narration, sourceType: 'ar_receipt', sourceId: receipt.id,
        sourceReference: receipt.referenceNo, lines, isAutoGenerated: true,
        sourceData: { customerId: receipt.clientId, amount, allocated, unapplied, bankAccountId: receipt.bankAccountId },
        bankAccountId: receipt.bankAccountId || null,
      });

      for (const allocation of receipt.allocations) {
        const invoice = allocation.invoice;
        const allocationAmount = Number(allocation.amountAllocated);
        const invoiceChanged = await tx.invoice.updateMany({ where: { id: invoice.id, companyId, amountOutstanding: { gte: allocationAmount } }, data: { amountPaid: { increment: allocationAmount }, amountOutstanding: { decrement: allocationAmount } } });
        if (invoiceChanged.count !== 1) throw error(409, 'INVOICE_BALANCE_CHANGED', `Invoice ${invoice.referenceNo} changed while posting.`);
        const updatedInvoice = await tx.invoice.findUnique({ where: { id: invoice.id }, select: { amountOutstanding: true } });
        const outstanding = money(updatedInvoice.amountOutstanding);
        await tx.invoice.update({ where: { id: invoice.id }, data: { status: outstanding <= 0.009 ? 'fully_paid' : 'partially_paid', ...(outstanding <= 0.009 ? { paidDate: date } : {}) } });
        await tx.arTransactionLedger.create({ data: {
          id: generateObjectId(), companyId, clientId: receipt.clientId, invoiceId: invoice.id, receiptId: receipt.id,
          transactionType: 'allocation_made', transactionDate: date, referenceNo: receipt.referenceNo,
          description: `Receipt ${receipt.referenceNo} allocated to invoice ${invoice.referenceNo}`,
          amount: Number(allocation.amountAllocated), direction: 'decrease', invoiceBalanceAfter: outstanding,
          sourceType: 'ar_receipt', sourceId: receipt.id, sourceReference: receipt.referenceNo,
          journalEntryId: entry?._id || entry?.id || null, reconciliationStatus: 'verified', createdById: userId,
        } });
      }
      if (allocated > 0) {
        const openInvoices = await tx.invoice.aggregate({ where: { companyId, clientId: receipt.clientId, status: { in: ['sent', 'confirmed', 'partially_paid'] } }, _sum: { amountOutstanding: true } });
        await tx.client.update({ where: { id: receipt.clientId }, data: { outstandingBalance: openInvoices._sum.amountOutstanding || 0 } });
      }

      if (receipt.bankAccountId) {
        const bank = await tx.bankAccount.findFirst({ where: { id: receipt.bankAccountId, companyId, isActive: true } });
        if (!bank) throw error(409, 'BANK_ACCOUNT_INACTIVE', 'The selected bank account is inactive.');
        await tx.bankAccount.update({ where: { id: bank.id }, data: { cacheValid: false, cacheLastComputed: null } });
      }
      await tx.aRReceipt.update({ where: { id: receipt.id }, data: { status: 'posted', postedById: userId, postedAt: new Date(), journalEntryId: entry?._id || entry?.id || null, unallocatedAmount: unapplied } });
    });
    await cacheService.bumpCompanyFinancialCaches(companyId).catch(() => {});
    const saved = await dbClient().aRReceipt.findFirst({ where: { id: receiptId, companyId }, include: receiptInclude });
    res.json({ success: true, message: 'Receipt posted successfully.', data: receiptView(saved) });
  } catch (err) { next(err); }
};

exports.reverseReceipt = async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const receiptId = String(req.params.id);
    const reason = String(req.body.reason || '').trim();
    if (!reason) throw error(400, 'REVERSAL_REASON_REQUIRED', 'A reason is required to reverse a posted receipt.');
    await runInPrismaTransaction(async (tx) => {
      const receipt = await tx.aRReceipt.findFirst({ where: { id: receiptId, companyId }, include: { allocations: { include: { invoice: true } }, bankAccount: true } });
      if (!receipt) throw error(404, 'AR_RECEIPT_NOT_FOUND', 'Receipt not found');
      if (receipt.status !== 'posted') throw error(409, 'AR_RECEIPT_NOT_POSTED', 'Only a posted receipt can be reversed.');
      const claimed = await tx.aRReceipt.updateMany({ where: { id: receiptId, companyId, status: 'posted' }, data: { status: 'reversing' } });
      if (claimed.count !== 1) throw error(409, 'AR_RECEIPT_NOT_POSTED', 'This receipt has already been reversed or changed.');
      const date = new Date();
      if (await periodService.isDateInClosedPeriod(companyId, date)) throw error(409, 'PERIOD_CLOSED', 'The current accounting period is closed.');
      const amount = money(receipt.amountReceived);
      const allocated = receipt.allocations.reduce((sum, allocation) => sum + Number(allocation.amountAllocated), 0);
      const cashCode = receipt.bankAccount?.ledgerAccountId || (receipt.paymentMethod === 'mobile_money' ? DEFAULT_ACCOUNTS.mtnMoMo : (receipt.paymentMethod === 'bank_transfer' || receipt.paymentMethod === 'cheque' ? DEFAULT_ACCOUNTS.cashAtBank : DEFAULT_ACCOUNTS.cashInHand));
      const arCode = await JournalService.getMappedAccountCode(companyId, 'sales', 'accountsReceivable', DEFAULT_ACCOUNTS.accountsReceivable);
      const advanceCode = await JournalService.getMappedAccountCode(companyId, 'sales', 'customerAdvances', DEFAULT_ACCOUNTS.customerAdvances);
      const unapplied = money(amount - allocated);
      const narration = `Reversal of customer receipt ${receipt.referenceNo}: ${reason}`;
      const lines = [JournalService.createCreditLine(cashCode, amount, narration)];
      if (allocated > 0) lines.push(JournalService.createDebitLine(arCode, allocated, `${narration} - restore receivable`));
      if (unapplied > 0) lines.push(JournalService.createDebitLine(advanceCode, unapplied, `${narration} - clear unapplied credit`));
      const entry = await JournalService.createEntry(companyId, userOf(req), {
        date, description: narration, sourceType: 'ar_receipt_reversal', sourceId: receipt.id,
        sourceReference: receipt.referenceNo, lines, isAutoGenerated: true,
        notes: reason, sourceData: { originalJournalEntryId: receipt.journalEntryId, reversalReason: reason, bankAccountId: receipt.bankAccountId },
        bankAccountId: receipt.bankAccountId || null,
      });
      for (const allocation of receipt.allocations) {
        const invoice = allocation.invoice;
        const paid = money(Math.max(0, Number(invoice.amountPaid) - Number(allocation.amountAllocated)));
        const outstanding = money(Number(invoice.amountOutstanding) + Number(allocation.amountAllocated));
        await tx.invoice.update({ where: { id: invoice.id }, data: {
          amountPaid: paid, amountOutstanding: outstanding,
          status: paid <= 0.009 ? 'confirmed' : 'partially_paid', paidDate: null,
        } });
        await tx.arTransactionLedger.create({ data: {
          id: generateObjectId(), companyId, clientId: receipt.clientId, invoiceId: invoice.id, receiptId: receipt.id,
          transactionType: 'allocation_removed', transactionDate: date, referenceNo: receipt.referenceNo,
          description: `Receipt ${receipt.referenceNo} reversed; allocation removed from invoice ${invoice.referenceNo}`,
          amount: Number(allocation.amountAllocated), direction: 'increase', invoiceBalanceAfter: outstanding,
          sourceType: 'ar_receipt_reversal', sourceId: receipt.id, sourceReference: receipt.referenceNo,
          journalEntryId: entry?._id || entry?.id || null, reconciliationStatus: 'verified', createdById: userOf(req),
        } });
      }
      if (allocated > 0) {
        const openInvoices = await tx.invoice.aggregate({ where: { companyId, clientId: receipt.clientId, status: { in: ['sent', 'confirmed', 'partially_paid'] } }, _sum: { amountOutstanding: true } });
        await tx.client.update({ where: { id: receipt.clientId }, data: { outstandingBalance: openInvoices._sum.amountOutstanding || 0 } });
      }
      if (receipt.bankAccountId) {
        const bank = await tx.bankAccount.findFirst({ where: { id: receipt.bankAccountId, companyId } });
        if (bank) {
          const reversalEntryId = entry?._id || entry?.id;
          const reversalTx = reversalEntryId ? await tx.bankTransaction.findFirst({ where: { companyId, journalEntryId: reversalEntryId, bankAccountId: bank.id } }) : null;
          const originalTx = await tx.bankTransaction.findFirst({ where: { companyId, sourceDocumentType: 'ar_receipt', sourceDocumentId: receipt.id, isReversed: false } });
          if (originalTx && reversalTx) await tx.bankTransaction.update({ where: { id: originalTx.id }, data: { isReversed: true, reversalTransactionId: reversalTx.id } });
          await tx.bankAccount.update({ where: { id: bank.id }, data: { cacheValid: false, cacheLastComputed: null } });
        }
      }
      await tx.aRReceipt.update({ where: { id: receipt.id }, data: {
        status: 'reversed', reversedAt: date, reversedById: userOf(req), reversalReason: reason,
        reverseJournalEntryId: entry?._id || entry?.id || null,
      } });
    });
    await cacheService.bumpCompanyFinancialCaches(companyId).catch(() => {});
    const saved = await dbClient().aRReceipt.findFirst({ where: { id: receiptId, companyId }, include: receiptInclude });
    res.json({ success: true, message: 'Receipt reversed successfully.', data: receiptView(saved) });
  } catch (err) { next(err); }
};
