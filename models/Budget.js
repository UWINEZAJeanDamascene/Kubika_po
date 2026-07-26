/**
 * Budget — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  budgetToApi,
  budgetTranslateCreate,
  budgetTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  company_id: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  name: { target: 'name' },
  code: { target: 'code' },
  fiscal_year: { target: 'fiscalYear' },
  status: { target: 'status' },
  type: { target: 'type' },
  department: { target: 'departmentId', isId: true },
  owner_id: { target: 'ownerId', isId: true },
  workflow_id: { target: 'workflowId', isId: true },
  scenario_type: { target: 'scenarioType' },
  parent_budget_id: { target: 'parentBudgetId', isId: true },
};

module.exports = buildTenantModel({
  name: 'Budget',
  collection: 'budgets',
  delegateName: 'budget',
  fieldMap: FIELD_MAP,
  toApi: budgetToApi,
  translateCreate: budgetTranslateCreate,
  translateUpdate: budgetTranslateUpdate,
  mutable: true,
});
