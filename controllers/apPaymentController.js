const { dbClient } = require('../lib/prisma');
const { runInPrismaTransaction } = require('../services/transactionService');
const { generateUniqueNumber } = require('../models/utils/autoIncrement');
const APPayment = require('../models/APPayment');
const JournalService = require('../services/journalService');
const APTrackingService = require('../services/apTrackingService');
const periodService = require('../services/periodService');
const cacheService = require('../services/cacheService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const { generateObjectId } = require('../utils/objectId');

const money = (n) => Number(Number(n || 0).toFixed(2));
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const companyOf = (req) => String(req.user.company._id || req.user.company.id);
const userOf = (req) => String(req.user.id || req.user._id);

const include = {
  supplier: { select: { id: true, name: true, code: true } },
  bankAccount: { select: { id: true, name: true, accountNumber: true, ledgerAccountId: true } },
  allocations: { include: { grn: { select: { id: true, referenceNo: true, balance: true, totalAmount: true, paymentStatus: true } } } },
};

function view(row) {
  if (!row) return null;
  return {
    ...row, _id: row.id, company: row.companyId,
    supplier: row.supplier ? { _id: row.supplier.id, name: row.supplier.name, code: row.supplier.code } : { _id: row.supplierId },
    bankAccount: row.bankAccount ? { _id: row.bankAccount.id, accountName: row.bankAccount.name, accountNumber: row.bankAccount.accountNumber } : null,
    amountPaid: String(row.amountPaid), unallocatedAmount: String(row.unallocatedAmount),
    reference: row.externalReference || null, journalEntry: row.journalEntryId,
    allocations: (row.allocations || []).map((a) => ({ ...a, _id: a.id, grn: a.grn ? { _id: a.grn.id, referenceNo: a.grn.referenceNo, balance: String(a.grn.balance), totalAmount: String(a.grn.totalAmount), paymentStatus: a.grn.paymentStatus } : { _id: a.grnId }, amountAllocated: String(a.amountAllocated) })),
  };
}

exports.list = async (req, res, next) => {
  try {
    const companyId = companyOf(req); const page = Math.max(1, Number(req.query.page) || 1); const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const where = { companyId };
    if (req.query.supplier_id) where.supplierId = String(req.query.supplier_id);
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.date_from || req.query.date_to) { where.paymentDate = {}; if (req.query.date_from) where.paymentDate.gte = new Date(req.query.date_from); if (req.query.date_to) { where.paymentDate.lte = new Date(req.query.date_to); if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.date_to)) where.paymentDate.lte.setHours(23, 59, 59, 999); } }
    const [count, rows] = await Promise.all([dbClient().aPPayment.count({ where }), dbClient().aPPayment.findMany({ where, include, orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: limit })]);
    res.json({ success: true, count, total: count, pages: Math.ceil(count / limit), currentPage: page, data: rows.map(view) });
  } catch (err) { next(err); }
};

exports.get = async (req, res, next) => {
  try { const row = await dbClient().aPPayment.findFirst({ where: { id: String(req.params.id), companyId: companyOf(req) }, include }); if (!row) throw fail(404, 'AP_PAYMENT_NOT_FOUND', 'Supplier payment not found.'); const data = view(row); res.json({ success: true, data, allocations: data.allocations }); } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const companyId = companyOf(req); const supplierId = String(req.body.supplier || req.body.supplierId || ''); const amount = money(req.body.amountPaid); const paymentDate = req.body.paymentDate ? new Date(req.body.paymentDate) : new Date();
    if (!supplierId || !Number.isFinite(amount) || amount <= 0 || Number.isNaN(paymentDate.getTime())) throw fail(400, 'INVALID_AP_PAYMENT', 'Supplier, positive payment amount, and valid payment date are required.');
    const method = String(req.body.paymentMethod || '').toLowerCase(); const methods = ['bank_transfer', 'cash', 'cheque', 'card', 'mobile_money', 'other'];
    if (!methods.includes(method)) throw fail(400, 'INVALID_PAYMENT_METHOD', 'Select a supported supplier payment method.');
    const bankId = String(req.body.bankAccount || req.body.bankAccountId || '') || null;
    const supplier = await dbClient().supplier.findFirst({ where: { id: supplierId, companyId }, select: { id: true } }); if (!supplier) throw fail(404, 'SUPPLIER_NOT_FOUND', 'Supplier was not found in this company.');
    const cashMethods = ['bank_transfer', 'cheque', 'card', 'mobile_money'];
    const bank = bankId ? await dbClient().bankAccount.findFirst({ where: { id: bankId, companyId, isActive: true }, select: { id: true } }) : null;
    if (bankId && !bank) throw fail(400, 'INVALID_BANK_ACCOUNT', 'Select an active account from this company.');
    if (cashMethods.includes(method) && !bank) throw fail(400, 'BANK_ACCOUNT_REQUIRED', 'Select an active bank, card-clearing, or mobile-money account.');
    const currencyCode = String(req.body.currencyCode || 'RWF').toUpperCase(); const exchangeRate = currencyCode === 'RWF' && req.body.exchangeRate == null ? 1 : Number(req.body.exchangeRate);
    if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) throw fail(400, 'INVALID_EXCHANGE_RATE', 'Exchange rate must be greater than zero.');
    const allocations = Array.isArray(req.body.allocations) ? req.body.allocations : [];
    const ids = allocations.map((a) => String(a.grnId || a.grn || '')); const amounts = allocations.map((a) => money(a.amount || a.amountAllocated));
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length || amounts.some((a) => !Number.isFinite(a) || a <= 0)) throw fail(400, 'INVALID_ALLOCATION', 'Each allocation needs one distinct GRN and a positive amount.');
    const allocated = money(amounts.reduce((sum, n) => sum + n, 0)); if (allocated > amount + 0.009) throw fail(400, 'ALLOCATION_EXCEEDS_PAYMENT', 'GRN allocations cannot exceed the payment amount.');
    const referenceNo = await generateUniqueNumber('PAY', APPayment, companyId, 'referenceNo');
    const row = await runInPrismaTransaction(async (tx) => {
      const grns = ids.length ? await tx.goodsReceivedNote.findMany({ where: { id: { in: ids }, companyId, supplierId, status: 'confirmed' }, include: { purchaseOrder: { select: { currencyCode: true } } } }) : [];
      if (grns.length !== ids.length) throw fail(400, 'GRN_NOT_ALLOCATABLE', 'Every allocation must reference a confirmed GRN for this supplier.');
      const byId = new Map(grns.map((g) => [g.id, g]));
      ids.forEach((id, i) => { const grn = byId.get(id); if (money(grn.balance) + 0.009 < amounts[i]) throw fail(400, 'GRN_BALANCE_EXCEEDED', `Allocation exceeds the outstanding balance for ${grn.referenceNo}.`); if (String(grn.purchaseOrder?.currencyCode || 'RWF').toUpperCase() !== currencyCode) throw fail(400, 'CURRENCY_MISMATCH', `GRN ${grn.referenceNo} uses a different currency.`); });
      const created = await tx.aPPayment.create({ data: { id: generateObjectId(), companyId, referenceNo, supplierId, paymentDate, paymentMethod: method, bankAccountId: bank?.id || null, amountPaid: amount, currencyCode, exchangeRate, status: 'draft', unallocatedAmount: money(amount - allocated), externalReference: req.body.reference ? String(req.body.reference).trim() : null, notes: req.body.notes ? String(req.body.notes).trim() : null, createdById: userOf(req) } });
      if (ids.length) await tx.aPPaymentAllocation.createMany({ data: ids.map((grnId, i) => ({ id: generateObjectId(), companyId, paymentId: created.id, grnId, amountAllocated: amounts[i], createdById: userOf(req) })) });
      return tx.aPPayment.findFirst({ where: { id: created.id }, include });
    });
    res.status(201).json({ success: true, data: view(row) });
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const companyId = companyOf(req); const id = String(req.params.id);
    const saved = await runInPrismaTransaction(async (tx) => {
      const current = await tx.aPPayment.findFirst({ where: { id, companyId }, include: { allocations: true } });
      if (!current) throw fail(404, 'AP_PAYMENT_NOT_FOUND', 'Supplier payment not found.');
      if (current.status !== 'draft') throw fail(409, 'AP_PAYMENT_LOCKED', 'Only draft payments can be edited; reverse a posted payment and create a corrected one.');
      const method = req.body.paymentMethod == null ? current.paymentMethod : String(req.body.paymentMethod).toLowerCase();
      const amount = req.body.amountPaid == null ? money(current.amountPaid) : money(req.body.amountPaid);
      const allocations = Array.isArray(req.body.allocations) ? req.body.allocations : null;
      const ids = allocations ? allocations.map((a) => String(a.grnId || a.grn || '')) : current.allocations.map((a) => a.grnId);
      const amounts = allocations ? allocations.map((a) => money(a.amount || a.amountAllocated)) : current.allocations.map((a) => money(a.amountAllocated));
      const allocated = money(amounts.reduce((sum, n) => sum + n, 0));
      if (amount <= 0 || allocated > amount + 0.009 || ids.some((x) => !x) || new Set(ids).size !== ids.length || amounts.some((x) => x <= 0)) throw fail(400, 'INVALID_AP_PAYMENT', 'Payment amount and unique positive allocations are invalid.');
      const grns = ids.length ? await tx.goodsReceivedNote.findMany({ where: { id: { in: ids }, companyId, supplierId: current.supplierId, status: 'confirmed' }, include: { purchaseOrder: { select: { currencyCode: true } } } }) : [];
      if (grns.length !== ids.length) throw fail(400, 'GRN_NOT_ALLOCATABLE', 'Every allocation must reference a confirmed GRN for this supplier.');
      const oldById = new Map(current.allocations.map((a) => [a.grnId, money(a.amountAllocated)])); const byId = new Map(grns.map((g) => [g.id, g]));
      ids.forEach((grnId, i) => { const grn = byId.get(grnId); if (amounts[i] > money(grn.balance) + (oldById.get(grnId) || 0) + 0.009) throw fail(400, 'GRN_BALANCE_EXCEEDED', `Allocation exceeds the outstanding balance for ${grn.referenceNo}.`); if (String(grn.purchaseOrder?.currencyCode || 'RWF').toUpperCase() !== String(req.body.currencyCode || current.currencyCode).toUpperCase()) throw fail(400, 'CURRENCY_MISMATCH', `GRN ${grn.referenceNo} uses a different currency.`); });
      const bankId = req.body.bankAccount === undefined && req.body.bankAccountId === undefined ? current.bankAccountId : String(req.body.bankAccount || req.body.bankAccountId || '') || null;
      const bank = bankId ? await tx.bankAccount.findFirst({ where: { id: bankId, companyId, isActive: true }, select: { id: true } }) : null;
      if (bankId && !bank) throw fail(400, 'INVALID_BANK_ACCOUNT', 'Select an active account from this company.');
      if (['bank_transfer', 'cheque', 'card', 'mobile_money'].includes(method) && !bank) throw fail(400, 'BANK_ACCOUNT_REQUIRED', 'Select an active bank or clearing account.');
      if (allocations) {
        const next = new Set(ids); for (const old of current.allocations) if (!next.has(old.grnId)) await tx.aPPaymentAllocation.delete({ where: { id: old.id } });
        for (let i = 0; i < ids.length; i++) { const old = current.allocations.find((a) => a.grnId === ids[i]); if (old) await tx.aPPaymentAllocation.update({ where: { id: old.id }, data: { amountAllocated: amounts[i] } }); else await tx.aPPaymentAllocation.create({ data: { id: generateObjectId(), companyId, paymentId: id, grnId: ids[i], amountAllocated: amounts[i], createdById: userOf(req) } }); }
      }
      const data = { paymentMethod: method, amountPaid: amount, bankAccountId: bank?.id || null, unallocatedAmount: money(amount - allocated) };
      for (const key of ['paymentDate', 'currencyCode', 'exchangeRate']) if (req.body[key] !== undefined) data[key] = key === 'paymentDate' ? new Date(req.body[key]) : (key === 'currencyCode' ? String(req.body[key]).toUpperCase() : Number(req.body[key]));
      if (data.paymentDate && Number.isNaN(data.paymentDate.getTime())) throw fail(400, 'INVALID_PAYMENT_DATE', 'Payment date is invalid.');
      if (!Number.isFinite(Number(data.exchangeRate ?? current.exchangeRate)) || Number(data.exchangeRate ?? current.exchangeRate) <= 0) throw fail(400, 'INVALID_EXCHANGE_RATE', 'Exchange rate must be greater than zero.');
      if (req.body.reference !== undefined) data.externalReference = req.body.reference ? String(req.body.reference).trim() : null;
      if (req.body.notes !== undefined) data.notes = req.body.notes ? String(req.body.notes).trim() : null;
      return tx.aPPayment.update({ where: { id }, data, include });
    });
    res.json({ success: true, data: view(saved) });
  } catch (err) { next(err); }
};

exports.post = async (req, res, next) => {
  try {
    const companyId = companyOf(req); const id = String(req.params.id); const userId = userOf(req);
    await runInPrismaTransaction(async (tx) => {
      const payment = await tx.aPPayment.findFirst({ where: { id, companyId }, include: { supplier: true, allocations: { include: { grn: { include: { purchaseOrder: true } } } }, bankAccount: true } });
      if (!payment) throw fail(404, 'AP_PAYMENT_NOT_FOUND', 'Supplier payment not found.');
      if (payment.status !== 'draft') throw fail(409, 'AP_PAYMENT_NOT_DRAFT', 'Only a draft payment can be posted.');
      const claim = await tx.aPPayment.updateMany({ where: { id, companyId, status: 'draft' }, data: { status: 'posting' } }); if (claim.count !== 1) throw fail(409, 'AP_PAYMENT_CHANGED', 'Payment changed; reload and retry.');
      const date = new Date(payment.paymentDate); if (await periodService.isDateInClosedPeriod(companyId, date)) throw fail(409, 'PERIOD_CLOSED', 'Payment date is in a closed accounting period.');
      const total = money(payment.amountPaid); const allocated = money(payment.allocations.reduce((sum, a) => sum + Number(a.amountAllocated), 0)); const unapplied = money(total - allocated);
      if (allocated > total + 0.009) throw fail(409, 'ALLOCATION_EXCEEDS_PAYMENT', 'Allocations exceed payment amount.');
      for (const a of payment.allocations) { const grn = a.grn; if (!grn || grn.companyId !== companyId || grn.supplierId !== payment.supplierId || grn.status !== 'confirmed' || money(a.amountAllocated) > money(grn.balance) + 0.009) throw fail(409, 'GRN_BALANCE_CHANGED', `GRN ${grn?.referenceNo || ''} is no longer payable for the allocated amount.`); if (String(grn.purchaseOrder?.currencyCode || 'RWF').toUpperCase() !== String(payment.currencyCode).toUpperCase()) throw fail(409, 'CURRENCY_MISMATCH', `GRN ${grn.referenceNo} uses a different currency.`); }
      const cashCode = payment.bankAccount?.ledgerAccountId || (payment.paymentMethod === 'mobile_money' ? DEFAULT_ACCOUNTS.mtnMoMo : (['bank_transfer', 'cheque', 'card'].includes(payment.paymentMethod) ? DEFAULT_ACCOUNTS.cashAtBank : DEFAULT_ACCOUNTS.cashInHand));
      const apCode = await JournalService.getMappedAccountCode(companyId, 'purchases', 'accountsPayable', DEFAULT_ACCOUNTS.accountsPayable);
      const advanceCode = await JournalService.getMappedAccountCode(companyId, 'purchases', 'supplierAdvances', DEFAULT_ACCOUNTS.otherReceivables);
      const narration = `Supplier payment ${payment.referenceNo} - ${payment.supplier.name}`;
      const lines = []; if (allocated > 0) lines.push(JournalService.createDebitLine(apCode, allocated, `${narration} allocated to GRNs`)); if (unapplied > 0) lines.push(JournalService.createDebitLine(advanceCode, unapplied, `${narration} supplier advance`)); lines.push(JournalService.createCreditLine(cashCode, total, narration));
      const entry = await JournalService.createEntry(companyId, userId, { date, description: narration, sourceType: 'ap_payment', sourceId: payment.id, sourceReference: payment.referenceNo, lines, isAutoGenerated: true, notes: payment.notes || '', sourceData: { supplierId: payment.supplierId, allocated, unapplied, bankAccountId: payment.bankAccountId }, bankAccountId: payment.bankAccountId || null });
      for (const a of payment.allocations) { const amount = money(a.amountAllocated); const balance = money(money(a.grn.balance) - amount); const paid = money(money(a.grn.amountPaid) + amount); await tx.goodsReceivedNote.update({ where: { id: a.grnId }, data: { amountPaid: paid, balance, paymentStatus: balance <= 0.009 ? 'paid' : 'partially_paid' } }); }
      if (payment.bankAccountId) { const bank = await tx.bankAccount.findFirst({ where: { id: payment.bankAccountId, companyId, isActive: true } }); if (!bank) throw fail(409, 'BANK_ACCOUNT_INACTIVE', 'The selected account is inactive.'); await tx.bankAccount.update({ where: { id: bank.id }, data: { cacheValid: false, cacheLastComputed: null } }); }
      await tx.aPPayment.update({ where: { id }, data: { status: 'posted', postedById: userId, postedAt: new Date(), journalEntryId: entry?._id || entry?.id || null, unallocatedAmount: unapplied } });
      const ledgerPayment = await APPayment.findOne({ _id: id, company: companyId });
      await APTrackingService.recordPaymentPosted({ ...ledgerPayment, amountPaid: allocated }, userId);
    });
    await cacheService.bumpCompanyFinancialCaches(companyId).catch(() => {});
    const saved = await dbClient().aPPayment.findFirst({ where: { id, companyId }, include }); res.json({ success: true, data: view(saved) });
  } catch (err) { next(err); }
};

exports.reverse = async (req, res, next) => {
  try {
    const companyId = companyOf(req); const id = String(req.params.id); const userId = userOf(req); const reason = String(req.body.reason || '').trim();
    if (!reason) throw fail(400, 'REVERSAL_REASON_REQUIRED', 'A reason is required to reverse a posted payment.');
    await runInPrismaTransaction(async (tx) => {
      const payment = await tx.aPPayment.findFirst({ where: { id, companyId }, include: { supplier: true, allocations: { include: { grn: true } }, bankAccount: true } });
      if (!payment) throw fail(404, 'AP_PAYMENT_NOT_FOUND', 'Supplier payment not found.'); if (payment.status !== 'posted') throw fail(409, 'AP_PAYMENT_NOT_POSTED', 'Only a posted payment can be reversed.');
      const claim = await tx.aPPayment.updateMany({ where: { id, companyId, status: 'posted' }, data: { status: 'reversing' } }); if (claim.count !== 1) throw fail(409, 'AP_PAYMENT_CHANGED', 'Payment changed; refresh before reversing.');
      const date = new Date(); if (await periodService.isDateInClosedPeriod(companyId, date)) throw fail(409, 'PERIOD_CLOSED', 'The current accounting period is closed.');
      const total = money(payment.amountPaid); const allocated = money(payment.allocations.reduce((sum, a) => sum + Number(a.amountAllocated), 0)); const unapplied = money(total - allocated);
      const cashCode = payment.bankAccount?.ledgerAccountId || (payment.paymentMethod === 'mobile_money' ? DEFAULT_ACCOUNTS.mtnMoMo : (['bank_transfer', 'cheque', 'card'].includes(payment.paymentMethod) ? DEFAULT_ACCOUNTS.cashAtBank : DEFAULT_ACCOUNTS.cashInHand));
      const apCode = await JournalService.getMappedAccountCode(companyId, 'purchases', 'accountsPayable', DEFAULT_ACCOUNTS.accountsPayable); const advanceCode = await JournalService.getMappedAccountCode(companyId, 'purchases', 'supplierAdvances', DEFAULT_ACCOUNTS.otherReceivables);
      const description = `Reversal of supplier payment ${payment.referenceNo}: ${reason}`; const lines = [JournalService.createDebitLine(cashCode, total, description)]; if (allocated > 0) lines.push(JournalService.createCreditLine(apCode, allocated, `${description} restore AP`)); if (unapplied > 0) lines.push(JournalService.createCreditLine(advanceCode, unapplied, `${description} clear supplier advance`));
      const entry = await JournalService.createEntry(companyId, userId, { date, description, sourceType: 'ap_payment_reversal', sourceId: payment.id, sourceReference: payment.referenceNo, lines, isAutoGenerated: true, notes: reason, sourceData: { originalJournalEntryId: payment.journalEntryId, reversalReason: reason, bankAccountId: payment.bankAccountId }, bankAccountId: payment.bankAccountId || null });
      for (const a of payment.allocations) { const balance = money(money(a.grn.balance) + Number(a.amountAllocated)); const paid = money(Math.max(0, Number(a.grn.amountPaid) - Number(a.amountAllocated))); await tx.goodsReceivedNote.update({ where: { id: a.grnId }, data: { amountPaid: paid, balance, paymentStatus: paid <= 0.009 ? 'pending' : 'partially_paid' } }); }
      if (payment.bankAccountId) { const bank = await tx.bankAccount.findFirst({ where: { id: payment.bankAccountId, companyId } }); if (bank) { const revId = entry?._id || entry?.id; const revTx = revId ? await tx.bankTransaction.findFirst({ where: { companyId, journalEntryId: revId, bankAccountId: bank.id } }) : null; const origTx = await tx.bankTransaction.findFirst({ where: { companyId, sourceDocumentType: 'ap_payment', sourceDocumentId: payment.id, isReversed: false } }); if (origTx && revTx) await tx.bankTransaction.update({ where: { id: origTx.id }, data: { isReversed: true, reversalTransactionId: revTx.id } }); await tx.bankAccount.update({ where: { id: bank.id }, data: { cacheValid: false, cacheLastComputed: null } }); } }
      await tx.aPPayment.update({ where: { id }, data: { status: 'reversed', reverseJournalEntryId: entry?._id || entry?.id || null, reversedById: userId, reversedAt: date, reversalReason: reason } });
      const ledgerPayment = await APPayment.findOne({ _id: id, company: companyId });
      await APTrackingService.recordPaymentReversed({ ...ledgerPayment, amountPaid: allocated }, userId, reason);
    });
    await cacheService.bumpCompanyFinancialCaches(companyId).catch(() => {});
    const saved = await dbClient().aPPayment.findFirst({ where: { id, companyId }, include }); res.json({ success: true, data: view(saved) });
  } catch (err) { next(err); }
};
