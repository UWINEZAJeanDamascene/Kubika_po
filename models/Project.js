/**
 * Project — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  projectToApi,
  projectTranslateCreate,
  projectTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  company_id: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  project_code: { target: 'projectCode' },
  name: { target: 'name' },
  project_category: { target: 'projectCategory' },
  parent_id: { target: 'parentId', isId: true },
  wbs_code: { target: 'wbsCode' },
  type: { target: 'type' },
  status: { target: 'status' },
  department_id: { target: 'departmentId', isId: true },
  client_id: { target: 'clientId', isId: true },
  manager_id: { target: 'managerId', isId: true },
  sponsor_id: { target: 'sponsorId', isId: true },
  team_member_ids: { target: 'teamMemberIds' },
  tax_rate_id: { target: 'taxRateId', isId: true },
  currency_code: { target: 'currencyCode' },
  is_template: { target: 'isTemplate' },
  estimated_hours: { target: 'estimatedHours' },
  actual_hours: { target: 'actualHours' },
  acceptance_criteria: { target: 'acceptanceCriteria' },
  depends_on_ids: { target: 'dependsOnIds' },
  completed_at: { target: 'completedAt' },
  is_active: { target: 'isActive' },
};

module.exports = buildTenantModel({
  name: 'Project',
  collection: 'projects',
  delegateName: 'project',
  fieldMap: FIELD_MAP,
  toApi: projectToApi,
  translateCreate: projectTranslateCreate,
  translateUpdate: projectTranslateUpdate,
  mutable: true,
});
