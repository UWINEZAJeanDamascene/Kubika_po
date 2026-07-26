/**
 * BudgetPeriodLock — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  budgetPeriodLockToApi,
  budgetPeriodLockTranslateCreate,
  budgetPeriodLockTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  company_id: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  budget_id: { target: 'budgetId', isId: true },
};

module.exports = buildTenantModel({
  name: 'BudgetPeriodLock',
  collection: 'budgetperiodlocks',
  delegateName: 'budgetPeriodLock',
  fieldMap: FIELD_MAP,
  toApi: budgetPeriodLockToApi,
  translateCreate: budgetPeriodLockTranslateCreate,
  translateUpdate: budgetPeriodLockTranslateUpdate,
  mutable: true,
});
