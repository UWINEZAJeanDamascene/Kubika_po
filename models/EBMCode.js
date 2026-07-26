/**
 * EBMCode — PostgreSQL (Prisma) backed (global delegate, company stored on row).
 */

const { buildGlobalModel } = require('../utils/masterDataCommon');
const {
  ebmCodeToApi,
  ebmCodeTranslateCreate,
  ebmCodeTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  codeClass: { target: 'codeClass' },
  codeClassName: { target: 'codeClassName' },
  code: { target: 'code' },
  name: { target: 'name' },
  sortOrder: { target: 'sortOrder' },
  active: { target: 'active' },
  lastSyncedAt: { target: 'lastSyncedAt' },
};

module.exports = buildGlobalModel({
  name: 'EBMCode',
  collection: 'ebmcodes',
  delegateName: 'ebmCode',
  fieldMap: FIELD_MAP,
  toApi: ebmCodeToApi,
  translateCreate: ebmCodeTranslateCreate,
  translateUpdate: ebmCodeTranslateUpdate,
  mutable: true,
});
