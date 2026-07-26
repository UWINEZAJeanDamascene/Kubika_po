/**
 * AssetStatusHistory — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  assetStatusHistoryToApi,
  assetStatusHistoryTranslateCreate,
  assetStatusHistoryTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  asset: { target: 'assetId', isId: true },
  fromStatus: { target: 'fromStatus' },
  toStatus: { target: 'toStatus' },
  changedAt: { target: 'changedAt' },
  changedBy: { target: 'changedById', isId: true },
};

module.exports = buildTenantModel({
  name: 'AssetStatusHistory',
  collection: 'assetstatushistories',
  delegateName: 'assetStatusHistory',
  fieldMap: FIELD_MAP,
  toApi: assetStatusHistoryToApi,
  translateCreate: assetStatusHistoryTranslateCreate,
  translateUpdate: assetStatusHistoryTranslateUpdate,
  mutable: true,
});
