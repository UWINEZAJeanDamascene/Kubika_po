/**
 * BudgetWorkflowConfig — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  budgetWorkflowConfigToApi,
  budgetWorkflowConfigTranslateCreate,
  budgetWorkflowConfigTranslateUpdate,
} = require('../utils/phase10Mappers');
const { prisma } = require('../lib/prisma');
const { decimalToNumber } = require('../utils/decimalHelpers');

const FIELD_MAP = {
  company_id: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  name: { target: 'name' },
  workflow_type: { target: 'workflowType' },
  is_active: { target: 'isActive' },
  is_default: { target: 'isDefault' },
};

const BudgetWorkflowConfig = buildTenantModel({
  name: 'BudgetWorkflowConfig',
  collection: 'budgetworkflowconfigs',
  delegateName: 'budgetWorkflowConfig',
  fieldMap: FIELD_MAP,
  toApi: budgetWorkflowConfigToApi,
  translateCreate: budgetWorkflowConfigTranslateCreate,
  translateUpdate: budgetWorkflowConfigTranslateUpdate,
  mutable: true,
});

BudgetWorkflowConfig.findMatchingWorkflow = async function(
  companyId,
  workflowType,
  amount = 0,
  departmentId = null
) {
  const where = {
    companyId: String(companyId),
    workflowType: { in: [workflowType, 'all'] },
    isActive: true,
  };

  const workflows = await prisma.budgetWorkflowConfig.findMany({
    where,
    orderBy: { priority: 'desc' },
  });

  for (const workflow of workflows) {
    const minAmt = decimalToNumber(workflow.minAmount, 0);
    const maxAmt = workflow.maxAmount != null ? decimalToNumber(workflow.maxAmount) : Infinity;

    if (amount < minAmt || (maxAmt !== Infinity && amount > maxAmt)) {
      continue;
    }

    if (workflow.departmentScope === 'specific') {
      if (!departmentId) continue;
      const deptIds = (workflow.departmentIds || []).map((id) => String(id));
      if (!deptIds.includes(String(departmentId))) continue;
    }

    return budgetWorkflowConfigToApi(workflow);
  }

  const defaultWorkflow = await prisma.budgetWorkflowConfig.findFirst({
    where: {
      companyId: String(companyId),
      workflowType,
      isDefault: true,
      isActive: true,
    },
  });

  return defaultWorkflow ? budgetWorkflowConfigToApi(defaultWorkflow) : null;
};

module.exports = BudgetWorkflowConfig;
