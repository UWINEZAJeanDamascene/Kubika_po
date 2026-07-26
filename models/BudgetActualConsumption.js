/**
 * BudgetActualConsumption — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  budgetActualConsumptionToApi,
  budgetActualConsumptionTranslateCreate,
  budgetActualConsumptionTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  company_id: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  budget_id: { target: 'budgetId', isId: true },
  budget_line_id: { target: 'budgetLineId', isId: true },
  account_id: { target: 'accountId', isId: true },
  origin_type: { target: 'originType' },
  document_type: { target: 'documentType' },
  project_id: { target: 'projectId', isId: true },
};

module.exports = buildTenantModel({
  name: 'BudgetActualConsumption',
  collection: 'budgetactualconsumptions',
  delegateName: 'budgetActualConsumption',
  fieldMap: FIELD_MAP,
  toApi: budgetActualConsumptionToApi,
  translateCreate: budgetActualConsumptionTranslateCreate,
  translateUpdate: budgetActualConsumptionTranslateUpdate,
  mutable: true,
});
