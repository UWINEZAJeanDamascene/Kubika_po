/**
 * BankReconciliationSession — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  bankReconciliationSessionToApi,
  bankReconciliationSessionTranslateCreate,
  bankReconciliationSessionTranslateUpdate,
} = require('../utils/bankingMappers');

const FIELD_MAP = {
  bankAccountId: { target: 'bankAccountId', isId: true },
  bankAccount: { target: 'bankAccountId', isId: true },
  companyId: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  periodStart: { target: 'periodStart' },
  periodEnd: { target: 'periodEnd' },
  status: { target: 'status' },
  completedBy: { target: 'completedById', isId: true },
};

module.exports = buildTenantModel({
  name: 'BankReconciliationSession',
  collection: 'bankreconciliationsessions',
  delegateName: 'bankReconciliationSession',
  fieldMap: FIELD_MAP,
  toApi: bankReconciliationSessionToApi,
  translateCreate: bankReconciliationSessionTranslateCreate,
  translateUpdate: bankReconciliationSessionTranslateUpdate,
  mutable: true,
});
