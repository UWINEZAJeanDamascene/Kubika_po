/**
 * PettyCash models — PostgreSQL (Prisma) backed.
 */

const { prisma } = require('../lib/prisma');
const { buildTenantModel } = require('../utils/masterDataCommon');
const { buildConstructorModel } = require('../utils/bankAccountMethods');
const {
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
} = require('../utils/bankingMappers');

const FLOAT_FIELD_MAP = {
  name: { target: 'name' },
  ledgerAccountId: { target: 'ledgerAccountId' },
  openingBalance: { target: 'openingBalance' },
  currentBalance: { target: 'currentBalance' },
  floatAmount: { target: 'floatAmount' },
  imprestMode: { target: 'imprestMode' },
  minimumBalance: { target: 'minimumBalance' },
  custodian: { target: 'custodianId', isId: true },
  location: { target: 'location' },
  isActive: { target: 'isActive' },
  cachedBalance: { target: 'cachedBalance' },
  cacheValid: { target: 'cacheValid' },
  notes: { target: 'notes' },
};

const EXPENSE_FIELD_MAP = {
  float: { target: 'floatId', isId: true },
  floatId: { target: 'floatId', isId: true },
  description: { target: 'description' },
  amount: { target: 'amount' },
  status: { target: 'status' },
  category: { target: 'category' },
  date: { target: 'date' },
  approvedBy: { target: 'approvedById', isId: true },
};

const REPLENISHMENT_FIELD_MAP = {
  float: { target: 'floatId', isId: true },
  floatId: { target: 'floatId', isId: true },
  amount: { target: 'amount' },
  status: { target: 'status' },
  requestedBy: { target: 'requestedById', isId: true },
  bank_account_id: { target: 'bankAccountId', isId: true },
  bankAccountId: { target: 'bankAccountId', isId: true },
};

const TRANSACTION_FIELD_MAP = {
  float: { target: 'floatId', isId: true },
  floatId: { target: 'floatId', isId: true },
  referenceNo: { target: 'referenceNo' },
  type: { target: 'type' },
  status: { target: 'status' },
  transactionDate: { target: 'transactionDate' },
  reference: { target: 'referenceId', isId: true },
  journalEntryId: { target: 'journalEntryId', isId: true },
};

const RECONCILIATION_FIELD_MAP = {
  float: { target: 'floatId', isId: true },
  floatId: { target: 'floatId', isId: true },
  reconciliationNumber: { target: 'reconciliationNumber' },
  countDate: { target: 'countDate' },
  status: { target: 'status' },
  countedBy: { target: 'countedById', isId: true },
  journalEntryId: { target: 'journalEntryId', isId: true },
};

const pettyCashFloatBase = buildTenantModel({
  name: 'PettyCashFloat',
  collection: 'pettycashfloats',
  delegateName: 'pettyCashFloat',
  fieldMap: FLOAT_FIELD_MAP,
  toApi: pettyCashFloatToApi,
  translateCreate: pettyCashFloatTranslateCreate,
  translateUpdate: pettyCashFloatTranslateUpdate,
  mutable: true,
});

const PettyCashFloat = buildConstructorModel({
  name: 'PettyCashFloat',
  baseModel: pettyCashFloatBase,
  toApi: pettyCashFloatToApi,
  translateCreate: pettyCashFloatTranslateCreate,
  translateUpdate: pettyCashFloatTranslateUpdate,
  delegateName: 'pettyCashFloat',
});

PettyCashFloat.invalidateCacheForLedgerAccount = async function invalidateCacheForLedgerAccount(
  companyId,
  ledgerAccountId,
) {
  return PettyCashFloat.updateMany(
    { company: companyId, ledgerAccountId },
    { $set: { cacheValid: false } },
  );
};

PettyCashFloat.getCurrentBalance = async function getCurrentBalance(floatId) {
  const rows = await prisma.pettyCashTransaction.findMany({
    where: { floatId: String(floatId) },
    select: { amount: true },
  });
  return rows.reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
};

const pettyCashExpenseBase = buildTenantModel({
  name: 'PettyCashExpense',
  collection: 'pettycashexpenses',
  delegateName: 'pettyCashExpense',
  fieldMap: EXPENSE_FIELD_MAP,
  toApi: pettyCashExpenseToApi,
  translateCreate: pettyCashExpenseTranslateCreate,
  translateUpdate: pettyCashExpenseTranslateUpdate,
  mutable: true,
});

const PettyCashExpense = buildConstructorModel({
  name: 'PettyCashExpense',
  baseModel: pettyCashExpenseBase,
  toApi: pettyCashExpenseToApi,
  translateCreate: pettyCashExpenseTranslateCreate,
  translateUpdate: pettyCashExpenseTranslateUpdate,
  delegateName: 'pettyCashExpense',
});

const pettyCashReplenishmentBase = buildTenantModel({
  name: 'PettyCashReplenishment',
  collection: 'pettycashreplenishments',
  delegateName: 'pettyCashReplenishment',
  fieldMap: REPLENISHMENT_FIELD_MAP,
  toApi: pettyCashReplenishmentToApi,
  translateCreate: pettyCashReplenishmentTranslateCreate,
  translateUpdate: pettyCashReplenishmentTranslateUpdate,
  mutable: true,
});

const PettyCashReplenishment = buildConstructorModel({
  name: 'PettyCashReplenishment',
  baseModel: pettyCashReplenishmentBase,
  toApi: pettyCashReplenishmentToApi,
  translateCreate: pettyCashReplenishmentTranslateCreate,
  translateUpdate: pettyCashReplenishmentTranslateUpdate,
  delegateName: 'pettyCashReplenishment',
});

const PettyCashTransaction = buildTenantModel({
  name: 'PettyCashTransaction',
  collection: 'pettycashtransactions',
  delegateName: 'pettyCashTransaction',
  fieldMap: TRANSACTION_FIELD_MAP,
  toApi: pettyCashTransactionToApi,
  translateCreate: pettyCashTransactionTranslateCreate,
  translateUpdate: pettyCashTransactionTranslateUpdate,
  mutable: true,
});

const PettyCashReconciliation = buildTenantModel({
  name: 'PettyCashReconciliation',
  collection: 'pettycashreconciliations',
  delegateName: 'pettyCashReconciliation',
  fieldMap: RECONCILIATION_FIELD_MAP,
  toApi: pettyCashReconciliationToApi,
  translateCreate: pettyCashReconciliationTranslateCreate,
  translateUpdate: pettyCashReconciliationTranslateUpdate,
  mutable: true,
});

module.exports = {
  PettyCashFloat,
  PettyCashExpense,
  PettyCashReplenishment,
  PettyCashTransaction,
  PettyCashReconciliation,
};
