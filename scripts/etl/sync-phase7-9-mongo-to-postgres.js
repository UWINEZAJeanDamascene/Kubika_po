/**
 * ETL: Sync Phase 7 (Banking/Petty Cash) + Phase 9 (Report Snapshots) MongoDB → PostgreSQL.
 *
 * Usage:
 *   node scripts/etl/sync-phase7-9-mongo-to-postgres.js
 *   node scripts/etl/sync-phase7-9-mongo-to-postgres.js --dry-run
 *
 * Requires: MONGODB_URI and DATABASE_URL
 */
require('dotenv').config();

const mongoose = require('mongoose');
const { prisma, connectPrisma, disconnectPrisma } = require('../../lib/prisma');

const DRY_RUN = process.argv.includes('--dry-run');

function rawModel(name, collection) {
  const modelName = `EtlPhase79${name}`;
  if (mongoose.models[modelName]) return mongoose.models[modelName];
  return mongoose.model(modelName, new mongoose.Schema({}, { strict: false, collection }));
}

function oid(v) { return v == null ? null : String(v); }
function dec(v, fb = 0) {
  if (v == null) return fb;
  if (typeof v === 'object' && v.$numberDecimal) return v.$numberDecimal;
  if (typeof v === 'object' && v.toString) return v.toString();
  return v;
}

function resolveBankAccountId(doc) {
  return oid(doc.account || doc.bankAccountId || doc.bankAccount);
}

function resolveFloatId(doc) {
  return oid(doc.float || doc.floatId);
}

async function companyExists(id) {
  if (!id) return false;
  return Boolean(await prisma.company.findUnique({ where: { id }, select: { id: true } }));
}

async function refExists(model, id) {
  if (!id) return false;
  return Boolean(await prisma[model].findUnique({ where: { id }, select: { id: true } }));
}

async function optionalRef(model, id) {
  if (!id) return null;
  return (await refExists(model, id)) ? id : null;
}

async function syncBankAccounts() {
  const M = rawModel('BankAccount', 'bankaccounts');
  const docs = await M.find({}).lean();
  console.log(`BankAccounts: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    if (!(await companyExists(companyId))) continue;
    await prisma.bankAccount.upsert({
      where: { id },
      create: {
        id,
        companyId,
        name: doc.name || 'Bank Account',
        accountNumber: doc.accountNumber || null,
        bankName: doc.bankName || null,
        currencyCode: doc.currencyCode || 'USD',
        ledgerAccountId: doc.ledgerAccountId || '1100',
        openingBalance: dec(doc.openingBalance, 0),
        openingBalanceDate: doc.openingBalanceDate || new Date(),
        isActive: doc.isActive ?? true,
        isDefault: doc.isDefault ?? false,
        accountType: doc.accountType || 'bk_bank',
        branch: doc.branch || null,
        swiftCode: doc.swiftCode || null,
        cachedBalance: dec(doc.cachedBalance ?? doc.openingBalance, 0),
        cacheValid: doc.cacheValid ?? false,
        cacheLastComputed: doc.cacheLastComputed || null,
        targetBalance: dec(doc.targetBalance, 0),
        holderName: doc.holderName || null,
        lastReconciledAt: doc.lastReconciledAt || null,
        lastReconciledBalance: dec(doc.lastReconciledBalance, 0),
        notes: doc.notes || null,
        color: doc.color || '#3B82F6',
        icon: doc.icon || 'bank',
        interestAccountType: doc.interestAccountType || 'current',
        interestRate: dec(doc.interestRate, 0),
        interestCalculationMethod: doc.interestCalculationMethod || 'simple',
        interestCreditFrequency: doc.interestCreditFrequency || 'monthly',
        interestIncomeAccount: doc.interestIncomeAccount || '4300',
        interestAccrualAccount: doc.interestAccrualAccount || '1350',
        bankStatementReference: Boolean(doc.bankStatementReference),
        interestStartDate: doc.interestStartDate || null,
        lastInterestPostedDate: doc.lastInterestPostedDate || null,
        customFields: doc.customFields || {},
        createdById: oid(doc.createdBy),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        name: doc.name || 'Bank Account',
        isActive: doc.isActive ?? true,
        cachedBalance: dec(doc.cachedBalance ?? doc.openingBalance, 0),
        cacheValid: doc.cacheValid ?? false,
      },
    });
    n += 1;
  }
  return n;
}

async function syncBankTransactions() {
  const M = rawModel('BankTransaction', 'banktransactions');
  const docs = await M.find({}).lean();
  console.log(`BankTransactions: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company || doc.companyId);
    const bankAccountId = resolveBankAccountId(doc);
    const createdById = oid(doc.createdBy);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('bankAccount', bankAccountId))) continue;
    if (!createdById) continue;
    const reconciledSessionId = await optionalRef('bankReconciliationSession', oid(doc.reconciledSessionId || doc.reconciledSession));
    const reversalTransactionId = await optionalRef('bankTransaction', oid(doc.reversalTransactionId || doc.reversalTransaction));
    await prisma.bankTransaction.upsert({
      where: { id },
      create: {
        id,
        companyId,
        bankAccountId,
        type: doc.type || 'debit',
        amount: dec(doc.amount, 0),
        balanceAfter: dec(doc.balanceAfter ?? doc.balance, 0),
        balance: dec(doc.balance ?? doc.balanceAfter, 0),
        reference: doc.reference ?? null,
        referenceType: doc.referenceType || null,
        description: doc.description || null,
        date: doc.date || new Date(),
        paymentMethod: doc.paymentMethod || 'bank_transfer',
        referenceNumber: doc.referenceNumber || null,
        status: doc.status || 'completed',
        notes: doc.notes || null,
        attachments: doc.attachments || [],
        journalEntryId: await optionalRef('journalEntry', oid(doc.journalEntry || doc.journalEntryId)),
        journalEntryLineId: oid(doc.journalEntryLineId),
        transactionType: doc.transactionType || 'other',
        sourceDocumentType: doc.sourceDocumentType || 'journal_entry',
        sourceDocumentId: oid(doc.sourceDocumentId),
        sourceReference: doc.sourceReference || null,
        reconciliationStatus: doc.reconciliationStatus || 'unreconciled',
        reconciledSessionId,
        isReversed: Boolean(doc.isReversed),
        reversalTransactionId,
        createdById,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        status: doc.status || 'completed',
        reconciliationStatus: doc.reconciliationStatus || 'unreconciled',
        balanceAfter: dec(doc.balanceAfter ?? doc.balance, 0),
      },
    });
    n += 1;
  }
  return n;
}

async function syncBankReconciliations() {
  const M = rawModel('BankReconciliation', 'bankreconciliations');
  const docs = await M.find({}).lean();
  console.log(`BankReconciliations: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const bankAccountId = resolveBankAccountId(doc);
    const startedById = oid(doc.startedBy);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('bankAccount', bankAccountId))) continue;
    if (!startedById) continue;
    await prisma.bankReconciliation.upsert({
      where: { id },
      create: {
        id,
        companyId,
        bankAccountId,
        statementDateStart: doc.statementDateStart || new Date(),
        statementDateEnd: doc.statementDateEnd || new Date(),
        statementClosingBalance: dec(doc.statementClosingBalance, 0),
        bookClosingBalance: doc.bookClosingBalance != null ? dec(doc.bookClosingBalance) : null,
        difference: dec(doc.difference, 0),
        status: doc.status || 'draft',
        startedById,
        completedById: oid(doc.completedBy),
        startedAt: doc.startedAt || doc.createdAt || new Date(),
        completedAt: doc.completedAt || null,
        reportSnapshot: doc.reportSnapshot || {},
        notes: doc.notes || null,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        status: doc.status || 'draft',
        difference: dec(doc.difference, 0),
      },
    });
    n += 1;
  }
  return n;
}

async function syncBankStatementLines() {
  const M = rawModel('BankStatementLine', 'bankstatementlines');
  const docs = await M.find({}).lean();
  console.log(`BankStatementLines: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const bankAccountId = resolveBankAccountId(doc);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('bankAccount', bankAccountId))) continue;
    const reconciliationId = await optionalRef('bankReconciliation', oid(doc.reconciliationId || doc.reconciliation));
    await prisma.bankStatementLine.upsert({
      where: { id },
      create: {
        id,
        companyId,
        bankAccountId,
        reconciliationId,
        transactionDate: doc.transactionDate || new Date(),
        description: doc.description || '',
        debitAmount: dec(doc.debitAmount, 0),
        creditAmount: dec(doc.creditAmount, 0),
        balance: doc.balance != null ? dec(doc.balance) : null,
        reference: doc.reference || null,
        status: doc.status || 'unmatched',
        isReconciled: Boolean(doc.isReconciled),
        matchedAmount: doc.matchedAmount != null ? dec(doc.matchedAmount) : null,
        importedAt: doc.importedAt || doc.createdAt || new Date(),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        status: doc.status || 'unmatched',
        isReconciled: Boolean(doc.isReconciled),
      },
    });
    n += 1;
  }
  return n;
}

async function syncBankReconciliationSessions() {
  const M = rawModel('BankReconciliationSession', 'bankreconciliationsessions');
  const docs = await M.find({}).lean();
  console.log(`BankReconciliationSessions: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company || doc.companyId);
    const bankAccountId = resolveBankAccountId(doc);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('bankAccount', bankAccountId))) continue;
    await prisma.bankReconciliationSession.upsert({
      where: { id },
      create: {
        id,
        companyId,
        bankAccountId,
        periodStart: doc.periodStart || new Date(),
        periodEnd: doc.periodEnd || new Date(),
        openingBookBalance: dec(doc.openingBookBalance, 0),
        closingBookBalance: dec(doc.closingBookBalance, 0),
        openingStatementBalance: dec(doc.openingStatementBalance, 0),
        closingStatementBalance: dec(doc.closingStatementBalance, 0),
        status: doc.status || 'in_progress',
        completedAt: doc.completedAt || null,
        completedById: oid(doc.completedBy),
        lockedAt: doc.lockedAt || null,
        adjustedBookBalance: dec(doc.adjustedBookBalance, 0),
        adjustedBankBalance: dec(doc.adjustedBankBalance, 0),
        isBalanced: Boolean(doc.isBalanced),
        outstandingDeposits: dec(doc.outstandingDeposits, 0),
        outstandingChecks: dec(doc.outstandingChecks, 0),
        unrecordedBankItems: dec(doc.unrecordedBankItems, 0),
        notes: doc.notes || null,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        status: doc.status || 'in_progress',
        isBalanced: Boolean(doc.isBalanced),
      },
    });
    n += 1;
  }
  return n;
}

async function syncBankStatementTransactions() {
  const M = rawModel('BankStatementTransaction', 'bankstatementtransactions');
  const docs = await M.find({}).lean();
  console.log(`BankStatementTransactions: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company || doc.companyId);
    const bankAccountId = resolveBankAccountId(doc);
    const reconciliationSessionId = oid(doc.reconciliationSessionId || doc.reconciliationSession);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('bankAccount', bankAccountId))) continue;
    if (!(await refExists('bankReconciliationSession', reconciliationSessionId))) continue;
    const matchedBookTransactionId = await optionalRef('bankTransaction', oid(doc.matchedBookTransactionId || doc.matchedBookTransaction));
    await prisma.bankStatementTransaction.upsert({
      where: { id },
      create: {
        id,
        companyId,
        bankAccountId,
        reconciliationSessionId,
        date: doc.date || new Date(),
        description: doc.description || '',
        reference: doc.reference || null,
        debit: dec(doc.debit, 0),
        credit: dec(doc.credit, 0),
        balance: dec(doc.balance, 0),
        matchStatus: doc.matchStatus || 'unmatched',
        matchedBookTransactionId,
        importedAt: doc.importedAt || doc.createdAt || new Date(),
        importSource: doc.importSource || 'manual',
        isAdjustment: Boolean(doc.isAdjustment),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        matchStatus: doc.matchStatus || 'unmatched',
        matchedBookTransactionId,
      },
    });
    n += 1;
  }
  return n;
}

async function syncBankReconciliationMatches() {
  const M = rawModel('BankReconciliationMatch', 'bankreconciliationmatches');
  const docs = await M.find({}).lean();
  console.log(`BankReconciliationMatches: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company || doc.companyId);
    if (!(await companyExists(companyId))) continue;
    const sessionId = await optionalRef('bankReconciliationSession', oid(doc.sessionId || doc.session));
    const bookTransactionId = await optionalRef('bankTransaction', oid(doc.bookTransactionId || doc.bookTransaction));
    const statementTransactionId = await optionalRef('bankStatementTransaction', oid(doc.statementTransactionId || doc.statementTransaction));
    const bankStatementLineId = await optionalRef('bankStatementLine', oid(doc.bankStatementLine || doc.bankStatementLineId));
    const bankAccountId = resolveBankAccountId(doc);
    const resolvedBankAccountId = bankAccountId
      ? await optionalRef('bankAccount', bankAccountId)
      : null;
    await prisma.bankReconciliationMatch.upsert({
      where: { id },
      create: {
        id,
        companyId,
        sessionId,
        bookTransactionId,
        statementTransactionId,
        bankStatementLineId,
        journalEntryLineId: oid(doc.journalEntryLineId),
        journalEntryId: oid(doc.journalEntry || doc.journalEntryId),
        bankAccountId: resolvedBankAccountId,
        matchType: doc.matchType || 'manual',
        amount: doc.amount != null ? dec(doc.amount) : null,
        matchedAmount: doc.matchedAmount != null ? dec(doc.matchedAmount) : null,
        matchedById: oid(doc.matchedBy),
        matchedAt: doc.matchedAt || doc.createdAt || new Date(),
        notes: doc.notes || null,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        matchType: doc.matchType || 'manual',
        matchedAmount: doc.matchedAmount != null ? dec(doc.matchedAmount) : null,
      },
    });
    n += 1;
  }
  return n;
}

async function syncPettyCashFloats() {
  const M = rawModel('PettyCashFloat', 'pettycashfloats');
  const docs = await M.find({}).lean();
  console.log(`PettyCashFloats: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const custodianId = oid(doc.custodian);
    if (!(await companyExists(companyId))) continue;
    if (!custodianId) continue;
    await prisma.pettyCashFloat.upsert({
      where: { id },
      create: {
        id,
        companyId,
        name: doc.name || 'Petty Cash Float',
        ledgerAccountId: doc.ledgerAccountId || '1050',
        openingBalance: dec(doc.openingBalance, 0),
        currentBalance: dec(doc.currentBalance, 0),
        floatAmount: dec(doc.floatAmount ?? doc.openingBalance, 0),
        imprestMode: doc.imprestMode ?? true,
        minimumBalance: dec(doc.minimumBalance, 10000),
        custodianId,
        location: doc.location || null,
        isActive: doc.isActive ?? true,
        cachedBalance: dec(doc.cachedBalance, 0),
        cacheValid: doc.cacheValid ?? false,
        cacheLastComputed: doc.cacheLastComputed || null,
        notes: doc.notes || null,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        currentBalance: dec(doc.currentBalance, 0),
        isActive: doc.isActive ?? true,
        cacheValid: doc.cacheValid ?? false,
      },
    });
    n += 1;
  }
  return n;
}

async function syncPettyCashExpenses() {
  const M = rawModel('PettyCashExpense', 'pettycashexpenses');
  const docs = await M.find({}).lean();
  console.log(`PettyCashExpenses: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const floatId = resolveFloatId(doc);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('pettyCashFloat', floatId))) continue;
    await prisma.pettyCashExpense.upsert({
      where: { id },
      create: {
        id,
        companyId,
        floatId,
        description: doc.description || '',
        amount: dec(doc.amount, 0),
        expenseAccountId: doc.expenseAccountId || '5100',
        category: doc.category || 'office_stationery',
        subcategory: doc.subcategory || null,
        recipientType: doc.recipientType || null,
        isTaxable: Boolean(doc.isTaxable),
        isStaffAdvance: Boolean(doc.isStaffAdvance),
        staffAdvanceStatus: doc.staffAdvanceStatus || null,
        purpose: doc.purpose || null,
        date: doc.date || new Date(),
        receiptNumber: doc.receiptNumber || null,
        receiptImage: doc.receiptImage || null,
        receiptUploadUrl: doc.receiptUploadUrl || null,
        receiptUploadName: doc.receiptUploadName || null,
        notes: doc.notes || null,
        voucherNumber: doc.voucherNumber || null,
        status: doc.status || 'pending',
        approvedById: oid(doc.approvedBy),
        approvedAt: doc.approvedAt || null,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        status: doc.status || 'pending',
        amount: dec(doc.amount, 0),
      },
    });
    n += 1;
  }
  return n;
}

async function syncPettyCashReplenishments() {
  const M = rawModel('PettyCashReplenishment', 'pettycashreplenishments');
  const docs = await M.find({}).lean();
  console.log(`PettyCashReplenishments: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const floatId = resolveFloatId(doc);
    const requestedById = oid(doc.requestedBy);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('pettyCashFloat', floatId))) continue;
    if (!requestedById) continue;
    const bankAccountId = await optionalRef('bankAccount', oid(doc.bank_account_id || doc.bankAccountId || doc.bankAccount));
    await prisma.pettyCashReplenishment.upsert({
      where: { id },
      create: {
        id,
        companyId,
        floatId,
        amount: dec(doc.amount, 0),
        actualAmount: doc.actualAmount != null ? dec(doc.actualAmount) : null,
        reason: doc.reason || null,
        receipts: doc.receipts || [],
        status: doc.status || 'pending',
        requestedById,
        approvedById: oid(doc.approvedBy),
        approvedAt: doc.approvedAt || null,
        completedById: oid(doc.completedBy),
        completedAt: doc.completedAt || null,
        notes: doc.notes || null,
        replenishmentNumber: doc.replenishmentNumber || null,
        bankAccountId,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        status: doc.status || 'pending',
        amount: dec(doc.amount, 0),
      },
    });
    n += 1;
  }
  return n;
}

async function syncPettyCashTransactions() {
  const M = rawModel('PettyCashTransaction', 'pettycashtransactions');
  const docs = await M.find({}).lean();
  console.log(`PettyCashTransactions: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const floatId = resolveFloatId(doc);
    const createdById = oid(doc.createdBy);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('pettyCashFloat', floatId))) continue;
    if (!createdById) continue;
    await prisma.pettyCashTransaction.upsert({
      where: { id },
      create: {
        id,
        companyId,
        floatId,
        referenceNo: doc.referenceNo || null,
        voucherNumber: doc.voucherNumber || null,
        type: doc.type || 'expense',
        transactionDate: doc.transactionDate || doc.date || new Date(),
        status: doc.status || 'posted',
        approvedById: oid(doc.approvedBy),
        approvedAt: doc.approvedAt || null,
        referenceId: oid(doc.reference || doc.referenceId),
        referenceType: doc.referenceType || null,
        amount: dec(doc.amount, 0),
        receiptRef: doc.receiptRef || null,
        expenseAccountId: doc.expenseAccountId || null,
        balanceAfter: dec(doc.balanceAfter, 0),
        description: doc.description || '',
        journalEntryId: await optionalRef('journalEntry', oid(doc.journalEntry || doc.journalEntryId)),
        createdById,
        notes: doc.notes || null,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        status: doc.status || 'posted',
        balanceAfter: dec(doc.balanceAfter, 0),
      },
    });
    n += 1;
  }
  return n;
}

async function syncPettyCashReconciliations() {
  const M = rawModel('PettyCashReconciliation', 'pettycashreconciliations');
  const docs = await M.find({}).lean();
  console.log(`PettyCashReconciliations: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    const floatId = resolveFloatId(doc);
    const countedById = oid(doc.countedBy);
    if (!(await companyExists(companyId))) continue;
    if (!(await refExists('pettyCashFloat', floatId))) continue;
    if (!countedById) continue;
    await prisma.pettyCashReconciliation.upsert({
      where: { id },
      create: {
        id,
        companyId,
        floatId,
        reconciliationNumber: doc.reconciliationNumber || id,
        countDate: doc.countDate || new Date(),
        systemBalance: dec(doc.systemBalance, 0),
        cashDenominations: doc.cashDenominations || [],
        physicalCashTotal: dec(doc.physicalCashTotal, 0),
        difference: dec(doc.difference, 0),
        differenceType: doc.differenceType || 'balanced',
        status: doc.status || 'pending',
        countedById,
        approvedById: oid(doc.approvedBy),
        approvedAt: doc.approvedAt || null,
        notes: doc.notes || null,
        discrepancyExplanation: doc.discrepancyExplanation || null,
        shortageOverageAccountId: doc.shortageOverageAccountId || '5900',
        journalEntryId: await optionalRef('journalEntry', oid(doc.journalEntry || doc.journalEntryId)),
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        status: doc.status || 'pending',
        difference: dec(doc.difference, 0),
      },
    });
    n += 1;
  }
  return n;
}

async function syncReportSnapshots() {
  const M = rawModel('ReportSnapshot', 'reportsnapshots');
  const docs = await M.find({}).lean();
  console.log(`ReportSnapshots: ${docs.length}`);
  if (DRY_RUN) return docs.length;
  let n = 0;
  for (const doc of docs) {
    const id = oid(doc._id);
    const companyId = oid(doc.company);
    if (!(await companyExists(companyId))) continue;
    await prisma.reportSnapshot.upsert({
      where: { id },
      create: {
        id,
        companyId,
        reportType: doc.reportType || 'sales',
        periodType: doc.periodType || 'monthly',
        periodStart: doc.periodStart || new Date(),
        periodEnd: doc.periodEnd || new Date(),
        periodLabel: doc.periodLabel || '',
        year: doc.year ?? new Date(doc.periodStart || Date.now()).getFullYear(),
        periodNumber: doc.periodNumber ?? 1,
        data: doc.data ?? null,
        summary: doc.summary || {},
        topProducts: doc.topProducts || [],
        topCustomers: doc.topCustomers || [],
        comparison: doc.comparison || {},
        generatedAt: doc.generatedAt || doc.createdAt || new Date(),
        generatedById: oid(doc.generatedBy),
        calculationSource: doc.calculationSource || 'snapshot',
        status: doc.status || 'completed',
        errorMessage: doc.errorMessage || null,
        version: doc.version ?? 1,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      },
      update: {
        status: doc.status || 'completed',
        summary: doc.summary || {},
        data: doc.data ?? null,
      },
    });
    n += 1;
  }
  return n;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI required');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  await connectPrisma();
  console.log(DRY_RUN ? 'DRY RUN' : 'SYNC');
  const results = {
    bankAccounts: await syncBankAccounts(),
    bankTransactions: await syncBankTransactions(),
    bankReconciliations: await syncBankReconciliations(),
    bankStatementLines: await syncBankStatementLines(),
    bankReconciliationSessions: await syncBankReconciliationSessions(),
    bankStatementTransactions: await syncBankStatementTransactions(),
    bankReconciliationMatches: await syncBankReconciliationMatches(),
    pettyCashFloats: await syncPettyCashFloats(),
    pettyCashExpenses: await syncPettyCashExpenses(),
    pettyCashReplenishments: await syncPettyCashReplenishments(),
    pettyCashTransactions: await syncPettyCashTransactions(),
    pettyCashReconciliations: await syncPettyCashReconciliations(),
    reportSnapshots: await syncReportSnapshots(),
  };
  console.log('Done:', results);
  await mongoose.disconnect();
  await disconnectPrisma();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  await disconnectPrisma().catch(() => {});
  process.exit(1);
});
