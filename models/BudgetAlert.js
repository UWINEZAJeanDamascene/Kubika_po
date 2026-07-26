/**
 * BudgetAlert — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  budgetAlertToApi,
  budgetAlertTranslateCreate,
  budgetAlertTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  company_id: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  budget_id: { target: 'budgetId', isId: true },
  is_enabled: { target: 'isEnabled' },
};

module.exports = buildTenantModel({
  name: 'BudgetAlert',
  collection: 'budgetalerts',
  delegateName: 'budgetAlert',
  fieldMap: FIELD_MAP,
  toApi: budgetAlertToApi,
  translateCreate: budgetAlertTranslateCreate,
  translateUpdate: budgetAlertTranslateUpdate,
  mutable: true,
});
