/**
 * BudgetTransfer — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  budgetTransferToApi,
  budgetTransferTranslateCreate,
  budgetTransferTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  company_id: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  budget_id: { target: 'budgetId', isId: true },
  from_line_id: { target: 'fromLineId', isId: true },
  to_line_id: { target: 'toLineId', isId: true },
  status: { target: 'status' },
  requested_by: { target: 'requestedById', isId: true },
};

module.exports = buildTenantModel({
  name: 'BudgetTransfer',
  collection: 'budgettransfers',
  delegateName: 'budgetTransfer',
  fieldMap: FIELD_MAP,
  toApi: budgetTransferToApi,
  translateCreate: budgetTransferTranslateCreate,
  translateUpdate: budgetTransferTranslateUpdate,
  mutable: true,
});
