/**
 * BudgetRevision — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  budgetRevisionToApi,
  budgetRevisionTranslateCreate,
  budgetRevisionTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  company_id: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  budget_id: { target: 'budgetId', isId: true },
  revision_number: { target: 'revisionNumber' },
  change_type: { target: 'changeType' },
  changed_by: { target: 'changedById', isId: true },
};

module.exports = buildTenantModel({
  name: 'BudgetRevision',
  collection: 'budgetrevisions',
  delegateName: 'budgetRevision',
  fieldMap: FIELD_MAP,
  toApi: budgetRevisionToApi,
  translateCreate: budgetRevisionTranslateCreate,
  translateUpdate: budgetRevisionTranslateUpdate,
  mutable: true,
});
