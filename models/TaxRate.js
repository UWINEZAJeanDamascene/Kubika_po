/**
 * TaxRate model — PostgreSQL (Prisma) backed.
 * Legacy Mongo uses snake_case field names in API responses.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  taxRateToApi,
  taxRateTranslateCreate,
  taxRateTranslateUpdate,
} = require('../utils/masterDataMappers');

const FIELD_MAP = {
  name: { target: 'name' },
  code: { target: 'code', transform: (v) => ({ code: typeof v === 'string' ? v.toUpperCase() : v }) },
  rate_pct: { target: 'ratePct' },
  ratePct: { target: 'ratePct' },
  type: { target: 'type' },
  input_account_id: { target: 'inputAccountId', isId: true },
  output_account_id: { target: 'outputAccountId', isId: true },
  input_account_code: { target: 'inputAccountCode' },
  output_account_code: { target: 'outputAccountCode' },
  is_active: { target: 'isActive' },
  isActive: { target: 'isActive' },
  effective_from: { target: 'effectiveFrom' },
  effective_to: { target: 'effectiveTo' },
};

module.exports = buildTenantModel({
  name: 'TaxRate',
  collection: 'taxrates',
  delegateName: 'taxRate',
  fieldMap: FIELD_MAP,
  toApi: taxRateToApi,
  translateCreate: taxRateTranslateCreate,
  translateUpdate: taxRateTranslateUpdate,
});
