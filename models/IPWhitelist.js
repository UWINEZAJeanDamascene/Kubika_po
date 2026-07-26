/**
 * IPWhitelist — PostgreSQL (Prisma) backed.
 *
 * Uses the global builder rather than the tenant builder: entries with a null
 * company are platform-wide, and every caller passes `company` explicitly
 * (including the platform stats count, which spans all companies).
 */

const { buildGlobalModel } = require('../utils/masterDataCommon');
const {
  ipWhitelistToApi,
  ipWhitelistTranslateCreate,
  ipWhitelistTranslateUpdate,
} = require('../utils/authMappers');

const FIELD_MAP = {
  ip: { target: 'ip' },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  description: { target: 'description' },
  enabled: { target: 'enabled' },
};

module.exports = buildGlobalModel({
  name: 'IPWhitelist',
  collection: 'ipwhitelists',
  delegateName: 'ipWhitelist',
  fieldMap: FIELD_MAP,
  toApi: ipWhitelistToApi,
  translateCreate: ipWhitelistTranslateCreate,
  translateUpdate: ipWhitelistTranslateUpdate,
});
