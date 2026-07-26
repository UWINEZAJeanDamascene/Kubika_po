/**
 * BudgetLine — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  budgetLineToApi,
  budgetLineTranslateCreate,
  budgetLineTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  company_id: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  budget_id: { target: 'budgetId', isId: true },
  account_id: { target: 'accountId', isId: true },
  period_month: { target: 'periodMonth' },
  period_year: { target: 'periodYear' },
  project_id: { target: 'projectId', isId: true },
};

module.exports = buildTenantModel({
  name: 'BudgetLine',
  collection: 'budgetlines',
  delegateName: 'budgetLine',
  fieldMap: FIELD_MAP,
  toApi: budgetLineToApi,
  translateCreate: budgetLineTranslateCreate,
  translateUpdate: budgetLineTranslateUpdate,
  mutable: true,
});
