/**
 * BudgetWorkflowConfig — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  budgetWorkflowConfigToApi,
  budgetWorkflowConfigTranslateCreate,
  budgetWorkflowConfigTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  company_id: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  name: { target: 'name' },
  workflow_type: { target: 'workflowType' },
  is_active: { target: 'isActive' },
  is_default: { target: 'isDefault' },
};

module.exports = buildTenantModel({
  name: 'BudgetWorkflowConfig',
  collection: 'budgetworkflowconfigs',
  delegateName: 'budgetWorkflowConfig',
  fieldMap: FIELD_MAP,
  toApi: budgetWorkflowConfigToApi,
  translateCreate: budgetWorkflowConfigTranslateCreate,
  translateUpdate: budgetWorkflowConfigTranslateUpdate,
  mutable: true,
});
