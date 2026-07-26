/**
 * ChartOfAccount model — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  chartOfAccountToApi,
  chartOfAccountTranslateCreate,
  chartOfAccountTranslateUpdate,
} = require('../utils/masterDataMappers');

const FIELD_MAP = {
  code: { target: 'code' },
  name: { target: 'name' },
  type: { target: 'type' },
  subtype: { target: 'subtype' },
  normal_balance: { target: 'normalBalance' },
  normalBalance: { target: 'normalBalance' },
  parent_id: { target: 'parentId', isId: true },
  parent: { target: 'parentId', isId: true },
  allow_direct_posting: { target: 'allowDirectPosting' },
  allowDirectPosting: { target: 'allowDirectPosting' },
  customFields: { target: 'customFields' },
};

module.exports = buildTenantModel({
  name: 'ChartOfAccount',
  collection: 'chartofaccounts',
  delegateName: 'chartOfAccount',
  fieldMap: FIELD_MAP,
  toApi: chartOfAccountToApi,
  translateCreate: chartOfAccountTranslateCreate,
  translateUpdate: chartOfAccountTranslateUpdate,
});
