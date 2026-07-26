/**
 * Currency model — PostgreSQL (Prisma) backed (global, no tenant).
 */

const { buildGlobalModel } = require('../utils/masterDataCommon');
const {
  currencyToApi,
  currencyTranslateCreate,
  currencyTranslateUpdate,
} = require('../utils/masterDataMappers');

const FIELD_MAP = {
  code: { target: 'code', transform: (v) => ({ code: typeof v === 'string' ? v.toUpperCase() : v }) },
  name: { target: 'name' },
  symbol: { target: 'symbol' },
  decimal_places: { target: 'decimalPlaces' },
  decimalPlaces: { target: 'decimalPlaces' },
  is_active: { target: 'isActive' },
  isActive: { target: 'isActive' },
};

module.exports = buildGlobalModel({
  name: 'Currency',
  collection: 'currencies',
  delegateName: 'currency',
  fieldMap: FIELD_MAP,
  toApi: currencyToApi,
  translateCreate: currencyTranslateCreate,
  translateUpdate: currencyTranslateUpdate,
});
