/**
 * BudgetApproval — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  budgetApprovalToApi,
  budgetApprovalTranslateCreate,
  budgetApprovalTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  company_id: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  budget_id: { target: 'budgetId', isId: true },
  workflow_type: { target: 'workflowType' },
  workflow_id: { target: 'workflowId', isId: true },
  status: { target: 'status' },
  requested_by: { target: 'requestedById', isId: true },
};

module.exports = buildTenantModel({
  name: 'BudgetApproval',
  collection: 'budgetapprovals',
  delegateName: 'budgetApproval',
  fieldMap: FIELD_MAP,
  toApi: budgetApprovalToApi,
  translateCreate: budgetApprovalTranslateCreate,
  translateUpdate: budgetApprovalTranslateUpdate,
  mutable: true,
});
