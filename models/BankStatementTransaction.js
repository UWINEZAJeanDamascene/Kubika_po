/**
 * BankStatementTransaction — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  bankStatementTransactionToApi,
  bankStatementTransactionTranslateCreate,
  bankStatementTransactionTranslateUpdate,
} = require('../utils/bankingMappers');

const FIELD_MAP = {
  bankAccountId: { target: 'bankAccountId', isId: true },
  bankAccount: { target: 'bankAccountId', isId: true },
  companyId: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  reconciliationSessionId: { target: 'reconciliationSessionId', isId: true },
  date: { target: 'date' },
  matchStatus: { target: 'matchStatus' },
  matchedBookTransactionId: { target: 'matchedBookTransactionId', isId: true },
};

module.exports = buildTenantModel({
  name: 'BankStatementTransaction',
  collection: 'bankstatementtransactions',
  delegateName: 'bankStatementTransaction',
  fieldMap: FIELD_MAP,
  toApi: bankStatementTransactionToApi,
  translateCreate: bankStatementTransactionTranslateCreate,
  translateUpdate: bankStatementTransactionTranslateUpdate,
  mutable: true,
});
