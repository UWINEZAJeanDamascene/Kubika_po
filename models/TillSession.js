/**
 * TillSession model — PostgreSQL (Prisma) backed.
 *
 * Mutable so the close-till flow can keep using `till.save()`.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  tillSessionToApi,
  tillSessionTranslateCreate,
  tillSessionTranslateUpdate,
} = require('../utils/tillMappers');

const FIELD_MAP = {
  openedBy: { target: 'openedById', isId: true },
  openedById: { target: 'openedById', isId: true },
  status: { target: 'status' },
  openingFloat: { target: 'openingFloat' },
  closingCount: { target: 'closingCount' },
  openedAt: { target: 'openedAt' },
  closedAt: { target: 'closedAt' },
};

module.exports = buildTenantModel({
  name: 'TillSession',
  collection: 'tillsessions',
  delegateName: 'tillSession',
  fieldMap: FIELD_MAP,
  toApi: tillSessionToApi,
  translateCreate: tillSessionTranslateCreate,
  translateUpdate: tillSessionTranslateUpdate,
  mutable: true,
});
