/**
 * BankAccount — PostgreSQL (Prisma) backed.
 * Also registers BankTransaction, BankStatementLine, BankReconciliationMatch,
 * BankReconciliation (legacy export pattern preserved).
 */

const mongoose = require('mongoose');
const { prisma } = require('../lib/prisma');
const { makeCompatModel } = require('../utils/prismaCompat');
const { STANDARD_TENANT_FIELD_MAP, registerBareSchema } = require('../utils/masterDataCommon');
const {
  setBankTransactionRef,
  attachBankAccountStatics,
  wrapBankAccountDoc,
  buildConstructorModel,
  buildBankTransactionModel,
  BankAccountDocProto,
} = require('../utils/bankAccountMethods');
const {
  bankAccountToApi,
  bankAccountTranslateCreate,
  bankAccountTranslateUpdate,
  bankTransactionToApi,
  bankTransactionTranslateCreate,
  bankTransactionTranslateUpdate,
  bankStatementLineToApi,
  bankStatementLineTranslateCreate,
  bankStatementLineTranslateUpdate,
  bankReconciliationMatchToApi,
  bankReconciliationMatchTranslateCreate,
  bankReconciliationMatchTranslateUpdate,
  bankReconciliationToApi,
  bankReconciliationTranslateCreate,
  bankReconciliationTranslateUpdate,
} = require('../utils/bankingMappers');

const BANK_ACCOUNT_FIELD_MAP = {
  name: { target: 'name' },
  accountNumber: { target: 'accountNumber' },
  bankName: { target: 'bankName' },
  currencyCode: { target: 'currencyCode' },
  ledgerAccountId: { target: 'ledgerAccountId' },
  openingBalance: { target: 'openingBalance' },
  openingBalanceDate: { target: 'openingBalanceDate' },
  isActive: { target: 'isActive' },
  isDefault: { target: 'isDefault' },
  isPrimary: { target: 'isDefault' },
  accountType: { target: 'accountType' },
  branch: { target: 'branch' },
  swiftCode: { target: 'swiftCode' },
  cachedBalance: { target: 'cachedBalance' },
  cacheValid: { target: 'cacheValid' },
  cacheLastComputed: { target: 'cacheLastComputed' },
  targetBalance: { target: 'targetBalance' },
  holderName: { target: 'holderName' },
  lastReconciledAt: { target: 'lastReconciledAt' },
  lastReconciledBalance: { target: 'lastReconciledBalance' },
  notes: { target: 'notes' },
  color: { target: 'color' },
  icon: { target: 'icon' },
  customFields: { target: 'customFields' },
};

const BANK_TRANSACTION_FIELD_MAP = {
  account: { target: 'bankAccountId', isId: true },
  bankAccountId: { target: 'bankAccountId', isId: true },
  companyId: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  type: { target: 'type' },
  amount: { target: 'amount' },
  date: { target: 'date' },
  status: { target: 'status' },
  journalEntryId: { target: 'journalEntryId', isId: true },
  journalEntryLineId: { target: 'journalEntryLineId', isId: true },
  reconciliationStatus: { target: 'reconciliationStatus' },
  transactionType: { target: 'transactionType' },
};

const BANK_STATEMENT_LINE_FIELD_MAP = {
  bankAccount: { target: 'bankAccountId', isId: true },
  bankAccountId: { target: 'bankAccountId', isId: true },
  reconciliationId: { target: 'reconciliationId', isId: true },
  transactionDate: { target: 'transactionDate' },
  status: { target: 'status' },
  isReconciled: { target: 'isReconciled' },
};

const BANK_RECON_MATCH_FIELD_MAP = {
  sessionId: { target: 'sessionId', isId: true },
  bookTransactionId: { target: 'bookTransactionId', isId: true },
  statementTransactionId: { target: 'statementTransactionId', isId: true },
  bankStatementLine: { target: 'bankStatementLineId', isId: true },
  bankStatementLineId: { target: 'bankStatementLineId', isId: true },
  journalEntry: { target: 'journalEntryId', isId: true },
  journalEntryId: { target: 'journalEntryId', isId: true },
  bankAccount: { target: 'bankAccountId', isId: true },
  bankAccountId: { target: 'bankAccountId', isId: true },
  companyId: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
};

const BANK_RECONCILIATION_FIELD_MAP = {
  bankAccount: { target: 'bankAccountId', isId: true },
  bankAccountId: { target: 'bankAccountId', isId: true },
  status: { target: 'status' },
  statementDateStart: { target: 'statementDateStart' },
  statementDateEnd: { target: 'statementDateEnd' },
  startedBy: { target: 'startedById', isId: true },
  completedBy: { target: 'completedById', isId: true },
};

registerBareSchema('BankAccount', 'bankaccounts');
registerBareSchema('BankTransaction', 'banktransactions');
registerBareSchema('BankStatementLine', 'bankstatementlines');
registerBareSchema('BankReconciliationMatch', 'bankreconciliationmatches');
registerBareSchema('BankReconciliation', 'bankreconciliations');

function wrapStatementLineDoc(apiDoc) {
  if (!apiDoc || apiDoc.__mutable) return apiDoc;
  const doc = { ...apiDoc, __mutable: true };
  doc.save = async function save() {
    if (doc.isNew || !doc._id) {
      const createData = await bankStatementLineTranslateCreate(doc);
      const row = await prisma.bankStatementLine.create({ data: createData });
      Object.assign(doc, bankStatementLineToApi(row), { __mutable: true });
      doc.isNew = false;
      return doc;
    }
    const row = await prisma.bankStatementLine.update({
      where: { id: String(doc._id) },
      data: bankStatementLineTranslateUpdate({ $set: doc }),
    });
    Object.assign(doc, bankStatementLineToApi(row), { __mutable: true });
    return doc;
  };
  return doc;
}

function wrapReconMatchDoc(apiDoc) {
  if (!apiDoc || apiDoc.__mutable) return apiDoc;
  const doc = { ...apiDoc, __mutable: true };
  doc.save = async function save() {
    if (doc.isNew || !doc._id) {
      const createData = await bankReconciliationMatchTranslateCreate(doc);
      const row = await prisma.bankReconciliationMatch.create({ data: createData });
      Object.assign(doc, bankReconciliationMatchToApi(row), { __mutable: true });
      doc.isNew = false;
      return doc;
    }
    const row = await prisma.bankReconciliationMatch.update({
      where: { id: String(doc._id) },
      data: bankReconciliationMatchTranslateUpdate({ $set: doc }),
    });
    Object.assign(doc, bankReconciliationMatchToApi(row), { __mutable: true });
    return doc;
  };
  return doc;
}

const bankTransactionBase = makeCompatModel({
  delegate: () => prisma.bankTransaction,
  fieldMap: { ...STANDARD_TENANT_FIELD_MAP, ...BANK_TRANSACTION_FIELD_MAP },
  toApi: bankTransactionToApi,
  translateCreate: bankTransactionTranslateCreate,
  translateUpdate: bankTransactionTranslateUpdate,
  tenantField: 'companyId',
  mutable: true,
});

const BankTransaction = buildBankTransactionModel(bankTransactionBase);
setBankTransactionRef(BankTransaction);

const bankAccountBase = makeCompatModel({
  delegate: () => prisma.bankAccount,
  fieldMap: { ...STANDARD_TENANT_FIELD_MAP, ...BANK_ACCOUNT_FIELD_MAP },
  toApi: (row) => wrapBankAccountDoc(bankAccountToApi(row)),
  translateCreate: bankAccountTranslateCreate,
  translateUpdate: bankAccountTranslateUpdate,
  tenantField: 'companyId',
  mutable: true,
});

function BankAccountDoc(data = {}) {
  Object.assign(this, data);
  this.isNew = !this._id;
}
BankAccountDoc.prototype = BankAccountDocProto;

function BankAccount(data) {
  if (!(this instanceof BankAccount)) return new BankAccountDoc(data);
  return BankAccountDoc.call(this, data);
}

Object.assign(BankAccount, bankAccountBase);
BankAccount.prototype = BankAccountDocProto;
BankAccount.modelName = 'BankAccount';

BankAccount.create = async function create(data) {
  const doc = new BankAccountDoc(data);
  return doc.save();
};

const BankStatementLineBase = makeCompatModel({
  delegate: () => prisma.bankStatementLine,
  fieldMap: { ...STANDARD_TENANT_FIELD_MAP, ...BANK_STATEMENT_LINE_FIELD_MAP },
  toApi: (row) => wrapStatementLineDoc(bankStatementLineToApi(row)),
  translateCreate: bankStatementLineTranslateCreate,
  translateUpdate: bankStatementLineTranslateUpdate,
  tenantField: 'companyId',
  mutable: true,
});

const BankStatementLine = buildConstructorModel({
  name: 'BankStatementLine',
  baseModel: BankStatementLineBase,
  toApi: bankStatementLineToApi,
  translateCreate: bankStatementLineTranslateCreate,
  translateUpdate: bankStatementLineTranslateUpdate,
  wrapDoc: wrapStatementLineDoc,
  delegateName: 'bankStatementLine',
});

const BankReconciliationMatchBase = makeCompatModel({
  delegate: () => prisma.bankReconciliationMatch,
  fieldMap: { ...STANDARD_TENANT_FIELD_MAP, ...BANK_RECON_MATCH_FIELD_MAP },
  toApi: (row) => wrapReconMatchDoc(bankReconciliationMatchToApi(row)),
  translateCreate: bankReconciliationMatchTranslateCreate,
  translateUpdate: bankReconciliationMatchTranslateUpdate,
  tenantField: 'companyId',
  mutable: true,
});

const BankReconciliationMatch = buildConstructorModel({
  name: 'BankReconciliationMatch',
  baseModel: BankReconciliationMatchBase,
  toApi: bankReconciliationMatchToApi,
  translateCreate: bankReconciliationMatchTranslateCreate,
  translateUpdate: bankReconciliationMatchTranslateUpdate,
  wrapDoc: wrapReconMatchDoc,
  delegateName: 'bankReconciliationMatch',
});

const BankReconciliation = makeCompatModel({
  delegate: () => prisma.bankReconciliation,
  fieldMap: { ...STANDARD_TENANT_FIELD_MAP, ...BANK_RECONCILIATION_FIELD_MAP },
  toApi: bankReconciliationToApi,
  translateCreate: bankReconciliationTranslateCreate,
  translateUpdate: bankReconciliationTranslateUpdate,
  tenantField: 'companyId',
  mutable: true,
});

attachBankAccountStatics(BankAccount);

if (!mongoose.models.BankTransaction) {
  mongoose.model('BankTransaction', new mongoose.Schema({}, { strict: false, collection: 'banktransactions' }));
}
if (!mongoose.models.BankStatementLine) {
  mongoose.model('BankStatementLine', new mongoose.Schema({}, { strict: false, collection: 'bankstatementlines' }));
}
if (!mongoose.models.BankReconciliationMatch) {
  mongoose.model('BankReconciliationMatch', new mongoose.Schema({}, { strict: false, collection: 'bankreconciliationmatches' }));
}
if (!mongoose.models.BankReconciliation) {
  mongoose.model('BankReconciliation', new mongoose.Schema({}, { strict: false, collection: 'bankreconciliations' }));
}

module.exports = BankAccount;
module.exports.BankAccount = BankAccount;
module.exports.BankTransaction = BankTransaction;
module.exports.BankStatementLine = BankStatementLine;
module.exports.BankReconciliationMatch = BankReconciliationMatch;
module.exports.BankReconciliation = BankReconciliation;
