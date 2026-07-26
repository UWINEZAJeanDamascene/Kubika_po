/**
 * Phase 7 (Banking) + Phase 9 (ReportSnapshot) mappers.
 */

const { generateObjectId, toIdString } = require('./objectId');
const { decimalToNumber, decimalToString, mapTimestamps } = require('./decimalHelpers');
const { mergeUpdatePayload } = require('./masterDataMappers');
const { tenantCreateBase } = require('./inventoryJournalMappers');
const { nextSequence } = require('../services/sequenceService');

const moneyStr = (v) => decimalToString(v, 2);
const qtyNum = (v) => decimalToNumber(v, 0);

async function nextPettyCashRef(companyId, prefix, seqName) {
  const year = new Date().getFullYear();
  const seq = await nextSequence(companyId, seqName, { year });
  return `${prefix}-${year}-${seq}`;
}

function pickHeader(data, headerMap, idFields = []) {
  const out = {};
  for (const [mongoKey, prismaKey] of Object.entries(headerMap)) {
    if (data[mongoKey] !== undefined) {
      out[prismaKey] = idFields.includes(prismaKey) && data[mongoKey]
        ? toIdString(data[mongoKey]) : data[mongoKey];
    }
  }
  return out;
}

function headerTranslateCreate(data, headerMap, idFields = [], extra = {}) {
  const base = tenantCreateBase(data);
  return { ...base, ...pickHeader(data, headerMap, idFields), ...extra };
}

/** PettyCashFloat / Expense / Replenishment / Reconciliation have no created_by column. */
function headerTranslateCreateNoCreator(data, headerMap, idFields = [], extra = {}) {
  const { createdById, ...rest } = headerTranslateCreate(data, headerMap, idFields, extra);
  return rest;
}

function genericTranslateUpdate(headerMap, idFields = []) {
  return (update = {}) => pickHeader(mergeUpdatePayload(update), headerMap, idFields);
}

function resolveBankAccountId(data) {
  return toIdString(data.account || data.bankAccountId || data.bankAccount);
}

function resolveFloatId(data) {
  return toIdString(data.float || data.floatId);
}

// ── BankAccount ───────────────────────────────────────────────────────────────

function bankAccountToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    name: row.name,
    accountNumber: row.accountNumber ?? null,
    bankName: row.bankName ?? null,
    currencyCode: row.currencyCode,
    ledgerAccountId: row.ledgerAccountId,
    openingBalance: qtyNum(row.openingBalance),
    openingBalanceDate: row.openingBalanceDate,
    isActive: row.isActive,
    isDefault: row.isDefault,
    isPrimary: row.isDefault,
    accountType: row.accountType,
    branch: row.branch ?? null,
    swiftCode: row.swiftCode ?? null,
    cachedBalance: qtyNum(row.cachedBalance),
    cacheValid: row.cacheValid,
    cacheLastComputed: row.cacheLastComputed ?? null,
    targetBalance: qtyNum(row.targetBalance),
    holderName: row.holderName ?? null,
    lastReconciledAt: row.lastReconciledAt ?? null,
    lastReconciledBalance: qtyNum(row.lastReconciledBalance),
    notes: row.notes ?? null,
    color: row.color,
    icon: row.icon,
    interestAccountType: row.interestAccountType,
    interestRate: qtyNum(row.interestRate),
    interestCalculationMethod: row.interestCalculationMethod,
    interestCreditFrequency: row.interestCreditFrequency,
    interestIncomeAccount: row.interestIncomeAccount,
    interestAccrualAccount: row.interestAccrualAccount,
    bankStatementReference: row.bankStatementReference,
    interestStartDate: row.interestStartDate ?? null,
    lastInterestPostedDate: row.lastInterestPostedDate ?? null,
    createdBy: row.createdById ?? null,
    customFields: row.customFields ?? {},
    ...mapTimestamps(row),
  };
}

const BANK_ACCOUNT_HEADER = {
  name: 'name',
  accountNumber: 'accountNumber',
  bankName: 'bankName',
  currencyCode: 'currencyCode',
  ledgerAccountId: 'ledgerAccountId',
  openingBalance: 'openingBalance',
  openingBalanceDate: 'openingBalanceDate',
  isActive: 'isActive',
  isDefault: 'isDefault',
  accountType: 'accountType',
  branch: 'branch',
  swiftCode: 'swiftCode',
  cachedBalance: 'cachedBalance',
  cacheValid: 'cacheValid',
  cacheLastComputed: 'cacheLastComputed',
  targetBalance: 'targetBalance',
  holderName: 'holderName',
  lastReconciledAt: 'lastReconciledAt',
  lastReconciledBalance: 'lastReconciledBalance',
  notes: 'notes',
  color: 'color',
  icon: 'icon',
  interestAccountType: 'interestAccountType',
  interestRate: 'interestRate',
  interestCalculationMethod: 'interestCalculationMethod',
  interestCreditFrequency: 'interestCreditFrequency',
  interestIncomeAccount: 'interestIncomeAccount',
  interestAccrualAccount: 'interestAccrualAccount',
  bankStatementReference: 'bankStatementReference',
  interestStartDate: 'interestStartDate',
  lastInterestPostedDate: 'lastInterestPostedDate',
  customFields: 'customFields',
};

const LEDGER_DEFAULT_BY_TYPE = {
  bk_bank: '1100',
  equity_bank: '1100',
  im_bank: '1100',
  cogebanque: '1100',
  ecobank: '1100',
  mtn_momo: '1200',
  airtel_money: '1200',
  cash_in_hand: '1000',
};

function bankAccountTranslateCreate(data) {
  const accountType = data.accountType || 'bk_bank';
  const openingBal = moneyStr(data.openingBalance ?? 0);
  return headerTranslateCreate(data, BANK_ACCOUNT_HEADER, [], {
    openingBalance: openingBal,
    openingBalanceDate: data.openingBalanceDate || new Date(),
    cachedBalance: openingBal,
    cacheValid: true,
    cacheLastComputed: new Date(),
    ledgerAccountId: data.ledgerAccountId || LEDGER_DEFAULT_BY_TYPE[accountType] || '1100',
    isActive: data.isActive ?? true,
    isDefault: data.isDefault ?? false,
    currencyCode: data.currencyCode || 'USD',
    accountType,
  });
}

const bankAccountTranslateUpdate = genericTranslateUpdate(BANK_ACCOUNT_HEADER);

// ── BankTransaction ─────────────────────────────────────────────────────────

function bankTransactionToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    companyId: row.companyId,
    account: row.bankAccountId,
    bankAccountId: row.bankAccountId,
    type: row.type,
    amount: qtyNum(row.amount),
    balanceAfter: qtyNum(row.balanceAfter),
    balance: qtyNum(row.balance),
    reference: row.reference ?? null,
    referenceType: row.referenceType ?? null,
    description: row.description ?? null,
    date: row.date,
    paymentMethod: row.paymentMethod,
    referenceNumber: row.referenceNumber ?? null,
    status: row.status,
    notes: row.notes ?? null,
    attachments: row.attachments ?? [],
    journalEntryId: row.journalEntryId ?? null,
    journalEntryLineId: row.journalEntryLineId ?? null,
    transactionType: row.transactionType,
    sourceDocumentType: row.sourceDocumentType,
    sourceDocumentId: row.sourceDocumentId ?? null,
    sourceReference: row.sourceReference ?? null,
    reconciliationStatus: row.reconciliationStatus,
    reconciledSessionId: row.reconciledSessionId ?? null,
    isReversed: row.isReversed,
    reversalTransactionId: row.reversalTransactionId ?? null,
    createdBy: row.createdById,
    ...mapTimestamps(row),
  };
}

const BANK_TRANSACTION_HEADER = {
  account: 'bankAccountId',
  bankAccountId: 'bankAccountId',
  type: 'type',
  amount: 'amount',
  balanceAfter: 'balanceAfter',
  balance: 'balance',
  reference: 'reference',
  referenceType: 'referenceType',
  description: 'description',
  date: 'date',
  paymentMethod: 'paymentMethod',
  referenceNumber: 'referenceNumber',
  status: 'status',
  notes: 'notes',
  attachments: 'attachments',
  journalEntryId: 'journalEntryId',
  journalEntryLineId: 'journalEntryLineId',
  transactionType: 'transactionType',
  sourceDocumentType: 'sourceDocumentType',
  sourceDocumentId: 'sourceDocumentId',
  sourceReference: 'sourceReference',
  reconciliationStatus: 'reconciliationStatus',
  reconciledSessionId: 'reconciledSessionId',
  isReversed: 'isReversed',
  reversalTransactionId: 'reversalTransactionId',
};

function bankTransactionTranslateCreate(data) {
  const bankAccountId = resolveBankAccountId(data);
  return headerTranslateCreate(data, BANK_TRANSACTION_HEADER, [
    'bankAccountId',
    'journalEntryId',
    'journalEntryLineId',
    'sourceDocumentId',
    'reconciledSessionId',
    'reversalTransactionId',
  ], {
    bankAccountId,
    amount: moneyStr(data.amount ?? 0),
    balanceAfter: moneyStr(data.balanceAfter ?? data.balance ?? 0),
    balance: moneyStr(data.balance ?? data.balanceAfter ?? 0),
    createdById: toIdString(data.createdBy),
  });
}

const bankTransactionTranslateUpdate = genericTranslateUpdate(BANK_TRANSACTION_HEADER, [
  'bankAccountId',
  'journalEntryId',
  'journalEntryLineId',
  'sourceDocumentId',
  'reconciledSessionId',
  'reversalTransactionId',
]);

// ── BankStatementLine ─────────────────────────────────────────────────────────

function bankStatementLineToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    bankAccount: row.bankAccountId,
    reconciliationId: row.reconciliationId ?? null,
    transactionDate: row.transactionDate,
    description: row.description,
    debitAmount: qtyNum(row.debitAmount),
    creditAmount: qtyNum(row.creditAmount),
    balance: row.balance != null ? qtyNum(row.balance) : null,
    reference: row.reference ?? null,
    status: row.status,
    isReconciled: row.isReconciled,
    matchedAmount: row.matchedAmount != null ? qtyNum(row.matchedAmount) : null,
    importedAt: row.importedAt,
    ...mapTimestamps(row),
  };
}

const BANK_STATEMENT_LINE_HEADER = {
  bankAccount: 'bankAccountId',
  bankAccountId: 'bankAccountId',
  reconciliationId: 'reconciliationId',
  transactionDate: 'transactionDate',
  description: 'description',
  debitAmount: 'debitAmount',
  creditAmount: 'creditAmount',
  balance: 'balance',
  reference: 'reference',
  status: 'status',
  isReconciled: 'isReconciled',
  matchedAmount: 'matchedAmount',
  importedAt: 'importedAt',
};

function bankStatementLineTranslateCreate(data) {
  return headerTranslateCreate(data, BANK_STATEMENT_LINE_HEADER, [
    'bankAccountId',
    'reconciliationId',
  ], {
    bankAccountId: resolveBankAccountId(data),
    debitAmount: moneyStr(data.debitAmount ?? 0),
    creditAmount: moneyStr(data.creditAmount ?? 0),
    balance: data.balance != null ? moneyStr(data.balance) : null,
    matchedAmount: data.matchedAmount != null ? moneyStr(data.matchedAmount) : null,
  });
}

const bankStatementLineTranslateUpdate = genericTranslateUpdate(BANK_STATEMENT_LINE_HEADER, [
  'bankAccountId',
  'reconciliationId',
]);

// ── BankReconciliation ────────────────────────────────────────────────────────

function bankReconciliationToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    bankAccount: row.bankAccountId,
    statementDateStart: row.statementDateStart,
    statementDateEnd: row.statementDateEnd,
    statementClosingBalance: qtyNum(row.statementClosingBalance),
    bookClosingBalance: row.bookClosingBalance != null ? qtyNum(row.bookClosingBalance) : null,
    difference: qtyNum(row.difference),
    status: row.status,
    startedBy: row.startedById,
    completedBy: row.completedById ?? null,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? null,
    reportSnapshot: row.reportSnapshot ?? {},
    notes: row.notes ?? null,
    ...mapTimestamps(row),
  };
}

const BANK_RECONCILIATION_HEADER = {
  bankAccount: 'bankAccountId',
  bankAccountId: 'bankAccountId',
  statementDateStart: 'statementDateStart',
  statementDateEnd: 'statementDateEnd',
  statementClosingBalance: 'statementClosingBalance',
  bookClosingBalance: 'bookClosingBalance',
  difference: 'difference',
  status: 'status',
  startedBy: 'startedById',
  completedBy: 'completedById',
  startedAt: 'startedAt',
  completedAt: 'completedAt',
  reportSnapshot: 'reportSnapshot',
  notes: 'notes',
};

function bankReconciliationTranslateCreate(data) {
  return headerTranslateCreate(data, BANK_RECONCILIATION_HEADER, [
    'bankAccountId',
    'startedById',
    'completedById',
  ], {
    bankAccountId: resolveBankAccountId(data),
    statementClosingBalance: moneyStr(data.statementClosingBalance ?? 0),
    bookClosingBalance: data.bookClosingBalance != null ? moneyStr(data.bookClosingBalance) : null,
    difference: moneyStr(data.difference ?? 0),
    startedById: toIdString(data.startedBy),
    reportSnapshot: data.reportSnapshot ?? {},
  });
}

const bankReconciliationTranslateUpdate = genericTranslateUpdate(BANK_RECONCILIATION_HEADER, [
  'bankAccountId',
  'startedById',
  'completedById',
]);

// ── BankReconciliationSession ─────────────────────────────────────────────────

function bankReconciliationSessionToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    companyId: row.companyId,
    company: row.companyId,
    bankAccountId: row.bankAccountId,
    bankAccount: row.bankAccountId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    openingBookBalance: qtyNum(row.openingBookBalance),
    closingBookBalance: qtyNum(row.closingBookBalance),
    openingStatementBalance: qtyNum(row.openingStatementBalance),
    closingStatementBalance: qtyNum(row.closingStatementBalance),
    status: row.status,
    completedAt: row.completedAt ?? null,
    completedBy: row.completedById ?? null,
    lockedAt: row.lockedAt ?? null,
    adjustedBookBalance: qtyNum(row.adjustedBookBalance),
    adjustedBankBalance: qtyNum(row.adjustedBankBalance),
    isBalanced: row.isBalanced,
    outstandingDeposits: qtyNum(row.outstandingDeposits),
    outstandingChecks: qtyNum(row.outstandingChecks),
    unrecordedBankItems: qtyNum(row.unrecordedBankItems),
    notes: row.notes ?? null,
    ...mapTimestamps(row),
  };
}

const BANK_RECON_SESSION_HEADER = {
  bankAccountId: 'bankAccountId',
  bankAccount: 'bankAccountId',
  periodStart: 'periodStart',
  periodEnd: 'periodEnd',
  openingBookBalance: 'openingBookBalance',
  closingBookBalance: 'closingBookBalance',
  openingStatementBalance: 'openingStatementBalance',
  closingStatementBalance: 'closingStatementBalance',
  status: 'status',
  completedAt: 'completedAt',
  completedBy: 'completedById',
  lockedAt: 'lockedAt',
  adjustedBookBalance: 'adjustedBookBalance',
  adjustedBankBalance: 'adjustedBankBalance',
  isBalanced: 'isBalanced',
  outstandingDeposits: 'outstandingDeposits',
  outstandingChecks: 'outstandingChecks',
  unrecordedBankItems: 'unrecordedBankItems',
  notes: 'notes',
};

const bankReconciliationSessionTranslateCreate = (data) =>
  headerTranslateCreate(data, BANK_RECON_SESSION_HEADER, ['bankAccountId', 'completedById'], {
    bankAccountId: resolveBankAccountId(data),
    openingBookBalance: moneyStr(data.openingBookBalance ?? 0),
    closingBookBalance: moneyStr(data.closingBookBalance ?? 0),
    openingStatementBalance: moneyStr(data.openingStatementBalance ?? 0),
    closingStatementBalance: moneyStr(data.closingStatementBalance ?? 0),
    adjustedBookBalance: moneyStr(data.adjustedBookBalance ?? 0),
    adjustedBankBalance: moneyStr(data.adjustedBankBalance ?? 0),
    outstandingDeposits: moneyStr(data.outstandingDeposits ?? 0),
    outstandingChecks: moneyStr(data.outstandingChecks ?? 0),
    unrecordedBankItems: moneyStr(data.unrecordedBankItems ?? 0),
  });

const bankReconciliationSessionTranslateUpdate = genericTranslateUpdate(
  BANK_RECON_SESSION_HEADER,
  ['bankAccountId', 'completedById'],
);

// ── BankStatementTransaction ──────────────────────────────────────────────────

function bankStatementTransactionToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    companyId: row.companyId,
    company: row.companyId,
    bankAccountId: row.bankAccountId,
    bankAccount: row.bankAccountId,
    reconciliationSessionId: row.reconciliationSessionId,
    date: row.date,
    description: row.description,
    reference: row.reference ?? null,
    debit: qtyNum(row.debit),
    credit: qtyNum(row.credit),
    balance: qtyNum(row.balance),
    matchStatus: row.matchStatus,
    matchedBookTransactionId: row.matchedBookTransactionId ?? null,
    importedAt: row.importedAt,
    importSource: row.importSource,
    isAdjustment: row.isAdjustment,
    ...mapTimestamps(row),
  };
}

const BANK_STATEMENT_TX_HEADER = {
  bankAccountId: 'bankAccountId',
  bankAccount: 'bankAccountId',
  reconciliationSessionId: 'reconciliationSessionId',
  date: 'date',
  description: 'description',
  reference: 'reference',
  debit: 'debit',
  credit: 'credit',
  balance: 'balance',
  matchStatus: 'matchStatus',
  matchedBookTransactionId: 'matchedBookTransactionId',
  importedAt: 'importedAt',
  importSource: 'importSource',
  isAdjustment: 'isAdjustment',
};

const bankStatementTransactionTranslateCreate = (data) =>
  headerTranslateCreate(data, BANK_STATEMENT_TX_HEADER, [
    'bankAccountId',
    'reconciliationSessionId',
    'matchedBookTransactionId',
  ], {
    bankAccountId: resolveBankAccountId(data),
    debit: moneyStr(data.debit ?? 0),
    credit: moneyStr(data.credit ?? 0),
    balance: moneyStr(data.balance ?? 0),
  });

const bankStatementTransactionTranslateUpdate = genericTranslateUpdate(
  BANK_STATEMENT_TX_HEADER,
  ['bankAccountId', 'reconciliationSessionId', 'matchedBookTransactionId'],
);

// ── BankReconciliationMatch ───────────────────────────────────────────────────

function bankReconciliationMatchToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    companyId: row.companyId,
    company: row.companyId,
    sessionId: row.sessionId ?? null,
    bookTransactionId: row.bookTransactionId ?? null,
    statementTransactionId: row.statementTransactionId ?? null,
    bankStatementLine: row.bankStatementLineId ?? null,
    bankStatementLineId: row.bankStatementLineId ?? null,
    journalEntryLineId: row.journalEntryLineId ?? null,
    journalEntry: row.journalEntryId ?? null,
    journalEntryId: row.journalEntryId ?? null,
    bankAccount: row.bankAccountId ?? null,
    bankAccountId: row.bankAccountId ?? null,
    matchType: row.matchType,
    amount: row.amount != null ? qtyNum(row.amount) : null,
    matchedAmount: row.matchedAmount != null ? qtyNum(row.matchedAmount) : null,
    matchedBy: row.matchedById ?? null,
    matchedAt: row.matchedAt,
    notes: row.notes ?? null,
    ...mapTimestamps(row),
  };
}

const BANK_RECON_MATCH_HEADER = {
  sessionId: 'sessionId',
  bookTransactionId: 'bookTransactionId',
  statementTransactionId: 'statementTransactionId',
  bankStatementLine: 'bankStatementLineId',
  bankStatementLineId: 'bankStatementLineId',
  journalEntryLineId: 'journalEntryLineId',
  journalEntry: 'journalEntryId',
  journalEntryId: 'journalEntryId',
  bankAccount: 'bankAccountId',
  bankAccountId: 'bankAccountId',
  matchType: 'matchType',
  amount: 'amount',
  matchedAmount: 'matchedAmount',
  matchedBy: 'matchedById',
  matchedAt: 'matchedAt',
  notes: 'notes',
};

function bankReconciliationMatchTranslateCreate(data) {
  return headerTranslateCreate(data, BANK_RECON_MATCH_HEADER, [
    'sessionId',
    'bookTransactionId',
    'statementTransactionId',
    'bankStatementLineId',
    'journalEntryId',
    'bankAccountId',
    'matchedById',
  ], {
    bankAccountId: data.bankAccount || data.bankAccountId ? resolveBankAccountId(data) : null,
    bankStatementLineId: toIdString(data.bankStatementLine || data.bankStatementLineId),
    amount: data.amount != null ? moneyStr(data.amount) : null,
    matchedAmount: data.matchedAmount != null ? moneyStr(data.matchedAmount) : null,
    matchedById: data.matchedBy ? toIdString(data.matchedBy) : null,
  });
}

const bankReconciliationMatchTranslateUpdate = genericTranslateUpdate(BANK_RECON_MATCH_HEADER, [
  'sessionId',
  'bookTransactionId',
  'statementTransactionId',
  'bankStatementLineId',
  'journalEntryId',
  'bankAccountId',
  'matchedById',
]);

// ── PettyCashFloat ────────────────────────────────────────────────────────────

function pettyCashFloatToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    name: row.name,
    ledgerAccountId: row.ledgerAccountId,
    openingBalance: qtyNum(row.openingBalance),
    currentBalance: qtyNum(row.currentBalance),
    floatAmount: qtyNum(row.floatAmount),
    imprestMode: row.imprestMode,
    minimumBalance: qtyNum(row.minimumBalance),
    custodian: row.custodianId,
    location: row.location ?? null,
    isActive: row.isActive,
    cachedBalance: qtyNum(row.cachedBalance),
    cacheValid: row.cacheValid,
    cacheLastComputed: row.cacheLastComputed ?? null,
    notes: row.notes ?? null,
    ...mapTimestamps(row),
  };
}

const PETTY_CASH_FLOAT_HEADER = {
  name: 'name',
  ledgerAccountId: 'ledgerAccountId',
  openingBalance: 'openingBalance',
  currentBalance: 'currentBalance',
  floatAmount: 'floatAmount',
  imprestMode: 'imprestMode',
  minimumBalance: 'minimumBalance',
  custodian: 'custodianId',
  location: 'location',
  isActive: 'isActive',
  cachedBalance: 'cachedBalance',
  cacheValid: 'cacheValid',
  cacheLastComputed: 'cacheLastComputed',
  notes: 'notes',
};

function pettyCashFloatTranslateCreate(data) {
  const openingBal = moneyStr(data.openingBalance ?? 0);
  return headerTranslateCreateNoCreator(
    data,
    PETTY_CASH_FLOAT_HEADER,
    ['custodianId'],
    {
      openingBalance: openingBal,
      currentBalance: moneyStr(data.currentBalance ?? 0),
      floatAmount: moneyStr(data.floatAmount ?? data.openingBalance ?? 0),
      cachedBalance: moneyStr(data.cachedBalance ?? 0),
      cacheValid: data.cacheValid ?? false,
      custodianId: toIdString(data.custodian ?? data.custodianId),
      isActive: data.isActive ?? true,
      imprestMode: data.imprestMode !== undefined ? Boolean(data.imprestMode) : true,
    },
  );
}

const pettyCashFloatTranslateUpdate = genericTranslateUpdate(PETTY_CASH_FLOAT_HEADER, ['custodianId']);

// ── PettyCashExpense ──────────────────────────────────────────────────────────

function pettyCashExpenseToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    float: row.floatId,
    description: row.description,
    amount: qtyNum(row.amount),
    expenseAccountId: row.expenseAccountId,
    category: row.category,
    subcategory: row.subcategory ?? null,
    recipientType: row.recipientType ?? null,
    isTaxable: row.isTaxable,
    isStaffAdvance: row.isStaffAdvance,
    staffAdvanceStatus: row.staffAdvanceStatus ?? null,
    purpose: row.purpose ?? null,
    date: row.date,
    receiptNumber: row.receiptNumber ?? null,
    receiptImage: row.receiptImage ?? null,
    receiptUploadUrl: row.receiptUploadUrl ?? null,
    receiptUploadName: row.receiptUploadName ?? null,
    notes: row.notes ?? null,
    voucherNumber: row.voucherNumber ?? null,
    status: row.status,
    approvedBy: row.approvedById ?? null,
    approvedAt: row.approvedAt ?? null,
    ...mapTimestamps(row),
  };
}

const PETTY_CASH_EXPENSE_HEADER = {
  float: 'floatId',
  floatId: 'floatId',
  description: 'description',
  amount: 'amount',
  expenseAccountId: 'expenseAccountId',
  category: 'category',
  subcategory: 'subcategory',
  recipientType: 'recipientType',
  isTaxable: 'isTaxable',
  isStaffAdvance: 'isStaffAdvance',
  staffAdvanceStatus: 'staffAdvanceStatus',
  purpose: 'purpose',
  date: 'date',
  receiptNumber: 'receiptNumber',
  receiptImage: 'receiptImage',
  receiptUploadUrl: 'receiptUploadUrl',
  receiptUploadName: 'receiptUploadName',
  notes: 'notes',
  voucherNumber: 'voucherNumber',
  status: 'status',
  approvedBy: 'approvedById',
  approvedAt: 'approvedAt',
};

async function pettyCashExpenseTranslateCreate(data) {
  const companyId = toIdString(data.company || data.companyId);
  const voucherNumber = data.voucherNumber
    || await nextPettyCashRef(companyId, 'PCV', 'petty_cash_voucher');
  return headerTranslateCreateNoCreator(data, PETTY_CASH_EXPENSE_HEADER, ['floatId', 'approvedById'], {
    floatId: resolveFloatId(data),
    amount: moneyStr(data.amount ?? 0),
    voucherNumber,
    approvedById: data.approvedBy ? toIdString(data.approvedBy) : null,
  });
}

const pettyCashExpenseTranslateUpdate = genericTranslateUpdate(PETTY_CASH_EXPENSE_HEADER, [
  'floatId',
  'approvedById',
]);

// ── PettyCashReplenishment ────────────────────────────────────────────────────

function pettyCashReplenishmentToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    float: row.floatId,
    amount: qtyNum(row.amount),
    actualAmount: row.actualAmount != null ? qtyNum(row.actualAmount) : null,
    reason: row.reason ?? null,
    receipts: row.receipts ?? [],
    status: row.status,
    requestedBy: row.requestedById,
    approvedBy: row.approvedById ?? null,
    approvedAt: row.approvedAt ?? null,
    completedBy: row.completedById ?? null,
    completedAt: row.completedAt ?? null,
    notes: row.notes ?? null,
    replenishmentNumber: row.replenishmentNumber ?? null,
    bank_account_id: row.bankAccountId ?? null,
    bankAccountId: row.bankAccountId ?? null,
    ...mapTimestamps(row),
  };
}

const PETTY_CASH_REPLENISH_HEADER = {
  float: 'floatId',
  floatId: 'floatId',
  amount: 'amount',
  actualAmount: 'actualAmount',
  reason: 'reason',
  receipts: 'receipts',
  status: 'status',
  requestedBy: 'requestedById',
  approvedBy: 'approvedById',
  approvedAt: 'approvedAt',
  completedBy: 'completedById',
  completedAt: 'completedAt',
  notes: 'notes',
  replenishmentNumber: 'replenishmentNumber',
  bank_account_id: 'bankAccountId',
  bankAccountId: 'bankAccountId',
};

function pettyCashReplenishmentTranslateCreate(data) {
  return headerTranslateCreateNoCreator(data, PETTY_CASH_REPLENISH_HEADER, [
    'floatId',
    'requestedById',
    'approvedById',
    'completedById',
    'bankAccountId',
  ], {
    floatId: resolveFloatId(data),
    amount: moneyStr(data.amount ?? 0),
    actualAmount: data.actualAmount != null ? moneyStr(data.actualAmount) : null,
    requestedById: toIdString(data.requestedBy),
    bankAccountId: data.bank_account_id || data.bankAccountId
      ? toIdString(data.bank_account_id || data.bankAccountId) : null,
  });
}

const pettyCashReplenishmentTranslateUpdate = genericTranslateUpdate(PETTY_CASH_REPLENISH_HEADER, [
  'floatId',
  'requestedById',
  'approvedById',
  'completedById',
  'bankAccountId',
]);

// ── PettyCashTransaction ──────────────────────────────────────────────────────

function pettyCashTransactionToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    float: row.floatId,
    referenceNo: row.referenceNo ?? null,
    voucherNumber: row.voucherNumber ?? null,
    type: row.type,
    transactionDate: row.transactionDate,
    status: row.status,
    approvedBy: row.approvedById ?? null,
    approvedAt: row.approvedAt ?? null,
    reference: row.referenceId ?? null,
    referenceType: row.referenceType ?? null,
    amount: qtyNum(row.amount),
    receiptRef: row.receiptRef ?? null,
    expenseAccountId: row.expenseAccountId ?? null,
    balanceAfter: qtyNum(row.balanceAfter),
    description: row.description,
    journalEntryId: row.journalEntryId ?? null,
    createdBy: row.createdById,
    notes: row.notes ?? null,
    ...mapTimestamps(row),
  };
}

const PETTY_CASH_TX_HEADER = {
  float: 'floatId',
  floatId: 'floatId',
  referenceNo: 'referenceNo',
  voucherNumber: 'voucherNumber',
  type: 'type',
  transactionDate: 'transactionDate',
  status: 'status',
  approvedBy: 'approvedById',
  approvedAt: 'approvedAt',
  reference: 'referenceId',
  referenceId: 'referenceId',
  referenceType: 'referenceType',
  amount: 'amount',
  receiptRef: 'receiptRef',
  expenseAccountId: 'expenseAccountId',
  balanceAfter: 'balanceAfter',
  description: 'description',
  journalEntryId: 'journalEntryId',
  notes: 'notes',
};

async function pettyCashTransactionTranslateCreate(data) {
  const companyId = toIdString(data.company || data.companyId);
  const referenceNo = data.referenceNo
    || await nextPettyCashRef(companyId, 'PCT', 'petty_cash_transaction');
  return headerTranslateCreate(data, PETTY_CASH_TX_HEADER, [
    'floatId',
    'approvedById',
    'referenceId',
    'journalEntryId',
  ], {
    floatId: resolveFloatId(data),
    amount: moneyStr(data.amount ?? 0),
    balanceAfter: moneyStr(data.balanceAfter ?? 0),
    referenceNo,
    voucherNumber: data.voucherNumber || null,
    receiptRef: data.receiptRef || data.receiptNumber || null,
    expenseAccountId: data.expenseAccountId || null,
    createdById: toIdString(data.createdBy || data.createdById),
    referenceId: data.reference ? toIdString(data.reference) : (data.referenceId ? toIdString(data.referenceId) : null),
    approvedById: data.approvedBy ? toIdString(data.approvedBy) : null,
  });
}

const pettyCashTransactionTranslateUpdate = genericTranslateUpdate(PETTY_CASH_TX_HEADER, [
  'floatId',
  'approvedById',
  'referenceId',
  'journalEntryId',
]);

// ── PettyCashReconciliation ───────────────────────────────────────────────────

function pettyCashReconciliationToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    float: row.floatId,
    reconciliationNumber: row.reconciliationNumber,
    countDate: row.countDate,
    systemBalance: qtyNum(row.systemBalance),
    cashDenominations: row.cashDenominations ?? [],
    physicalCashTotal: qtyNum(row.physicalCashTotal),
    difference: qtyNum(row.difference),
    differenceType: row.differenceType,
    status: row.status,
    countedBy: row.countedById,
    approvedBy: row.approvedById ?? null,
    approvedAt: row.approvedAt ?? null,
    notes: row.notes ?? null,
    discrepancyExplanation: row.discrepancyExplanation ?? null,
    shortageOverageAccountId: row.shortageOverageAccountId,
    journalEntryId: row.journalEntryId ?? null,
    ...mapTimestamps(row),
  };
}

const PETTY_CASH_RECON_HEADER = {
  float: 'floatId',
  floatId: 'floatId',
  reconciliationNumber: 'reconciliationNumber',
  countDate: 'countDate',
  systemBalance: 'systemBalance',
  cashDenominations: 'cashDenominations',
  physicalCashTotal: 'physicalCashTotal',
  difference: 'difference',
  differenceType: 'differenceType',
  status: 'status',
  countedBy: 'countedById',
  approvedBy: 'approvedById',
  approvedAt: 'approvedAt',
  notes: 'notes',
  discrepancyExplanation: 'discrepancyExplanation',
  shortageOverageAccountId: 'shortageOverageAccountId',
  journalEntryId: 'journalEntryId',
};

function pettyCashReconciliationTranslateCreate(data) {
  return headerTranslateCreateNoCreator(data, PETTY_CASH_RECON_HEADER, [
    'floatId',
    'countedById',
    'approvedById',
    'journalEntryId',
  ], {
    floatId: resolveFloatId(data),
    systemBalance: moneyStr(data.systemBalance ?? 0),
    physicalCashTotal: moneyStr(data.physicalCashTotal ?? 0),
    difference: moneyStr(data.difference ?? 0),
    cashDenominations: data.cashDenominations ?? [],
    countedById: toIdString(data.countedBy),
    approvedById: data.approvedBy ? toIdString(data.approvedBy) : null,
  });
}

const pettyCashReconciliationTranslateUpdate = genericTranslateUpdate(PETTY_CASH_RECON_HEADER, [
  'floatId',
  'countedById',
  'approvedById',
  'journalEntryId',
]);

// ── ReportSnapshot ────────────────────────────────────────────────────────────

function reportSnapshotToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    reportType: row.reportType,
    periodType: row.periodType,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    periodLabel: row.periodLabel,
    year: row.year,
    periodNumber: row.periodNumber,
    data: row.data ?? null,
    summary: row.summary ?? {},
    topProducts: row.topProducts ?? [],
    topCustomers: row.topCustomers ?? [],
    comparison: row.comparison ?? {},
    generatedAt: row.generatedAt,
    generatedBy: row.generatedById ?? null,
    calculationSource: row.calculationSource,
    status: row.status,
    errorMessage: row.errorMessage ?? null,
    version: row.version,
    ...mapTimestamps(row),
  };
}

const REPORT_SNAPSHOT_HEADER = {
  reportType: 'reportType',
  periodType: 'periodType',
  periodStart: 'periodStart',
  periodEnd: 'periodEnd',
  periodLabel: 'periodLabel',
  year: 'year',
  periodNumber: 'periodNumber',
  data: 'data',
  summary: 'summary',
  topProducts: 'topProducts',
  topCustomers: 'topCustomers',
  comparison: 'comparison',
  generatedAt: 'generatedAt',
  generatedBy: 'generatedById',
  calculationSource: 'calculationSource',
  status: 'status',
  errorMessage: 'errorMessage',
  version: 'version',
};

const reportSnapshotTranslateCreate = (data) =>
  headerTranslateCreate(data, REPORT_SNAPSHOT_HEADER, ['generatedById'], {
    generatedById: data.generatedBy ? toIdString(data.generatedBy) : null,
    summary: data.summary ?? {},
    topProducts: data.topProducts ?? [],
    topCustomers: data.topCustomers ?? [],
    comparison: data.comparison ?? {},
  });

const reportSnapshotTranslateUpdate = genericTranslateUpdate(REPORT_SNAPSHOT_HEADER, ['generatedById']);

module.exports = {
  bankAccountToApi,
  bankAccountTranslateCreate,
  bankAccountTranslateUpdate,
  bankTransactionToApi,
  bankTransactionTranslateCreate,
  bankTransactionTranslateUpdate,
  bankStatementLineToApi,
  bankStatementLineTranslateCreate,
  bankStatementLineTranslateUpdate,
  bankReconciliationToApi,
  bankReconciliationTranslateCreate,
  bankReconciliationTranslateUpdate,
  bankReconciliationSessionToApi,
  bankReconciliationSessionTranslateCreate,
  bankReconciliationSessionTranslateUpdate,
  bankStatementTransactionToApi,
  bankStatementTransactionTranslateCreate,
  bankStatementTransactionTranslateUpdate,
  bankReconciliationMatchToApi,
  bankReconciliationMatchTranslateCreate,
  bankReconciliationMatchTranslateUpdate,
  pettyCashFloatToApi,
  pettyCashFloatTranslateCreate,
  pettyCashFloatTranslateUpdate,
  pettyCashExpenseToApi,
  pettyCashExpenseTranslateCreate,
  pettyCashExpenseTranslateUpdate,
  pettyCashReplenishmentToApi,
  pettyCashReplenishmentTranslateCreate,
  pettyCashReplenishmentTranslateUpdate,
  pettyCashTransactionToApi,
  pettyCashTransactionTranslateCreate,
  pettyCashTransactionTranslateUpdate,
  pettyCashReconciliationToApi,
  pettyCashReconciliationTranslateCreate,
  pettyCashReconciliationTranslateUpdate,
  reportSnapshotToApi,
  reportSnapshotTranslateCreate,
  reportSnapshotTranslateUpdate,
};
