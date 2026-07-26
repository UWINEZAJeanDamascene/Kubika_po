/**
 * AccountMapping — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  accountMappingToApi,
  accountMappingTranslateCreate,
  accountMappingTranslateUpdate,
} = require('../utils/inventoryJournalMappers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  module: { target: 'module' },
  key: { target: 'key' },
  accountCode: { target: 'accountCode' },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

module.exports = buildTenantModel({
  name: 'AccountMapping',
  collection: 'accountmappings',
  delegateName: 'accountMapping',
  fieldMap: FIELD_MAP,
  toApi: accountMappingToApi,
  translateCreate: accountMappingTranslateCreate,
  translateUpdate: accountMappingTranslateUpdate,
  mutable: true,
});
