/**
 * ExchangeRate model — PostgreSQL (Prisma) backed.
 * Legacy Mongo field `company_id` (not `company`).
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  exchangeRateToApi,
  exchangeRateTranslateCreate,
  exchangeRateTranslateUpdate,
} = require('../utils/masterDataMappers');

const FIELD_MAP = {
  company_id: { target: 'companyId', isId: true },
  from_currency: { target: 'fromCurrency', transform: (v) => ({ fromCurrency: typeof v === 'string' ? v.toUpperCase() : v }) },
  to_currency: { target: 'toCurrency', transform: (v) => ({ toCurrency: typeof v === 'string' ? v.toUpperCase() : v }) },
  rate: { target: 'rate' },
  effective_date: { target: 'effectiveDate' },
  source: { target: 'source' },
  created_by: { target: 'createdById', isId: true },
};

module.exports = buildTenantModel({
  name: 'ExchangeRate',
  collection: 'exchangerates',
  delegateName: 'exchangeRate',
  fieldMap: FIELD_MAP,
  toApi: exchangeRateToApi,
  translateCreate: exchangeRateTranslateCreate,
  translateUpdate: exchangeRateTranslateUpdate,
  tenantField: 'companyId',
});
