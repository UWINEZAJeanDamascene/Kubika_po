/**
 * Encumbrance — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  encumbranceToApi,
  encumbranceTranslateCreate,
  encumbranceTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  company_id: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  budget_id: { target: 'budgetId', isId: true },
  budget_line_id: { target: 'budgetLineId', isId: true },
  account_id: { target: 'accountId', isId: true },
  source_type: { target: 'sourceType' },
  status: { target: 'status' },
};

module.exports = buildTenantModel({
  name: 'Encumbrance',
  collection: 'encumbrances',
  delegateName: 'encumbrance',
  fieldMap: FIELD_MAP,
  toApi: encumbranceToApi,
  translateCreate: encumbranceTranslateCreate,
  translateUpdate: encumbranceTranslateUpdate,
  mutable: true,
});
