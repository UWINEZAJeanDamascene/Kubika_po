/**
 * AssetDisposalEvent — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  assetDisposalEventToApi,
  assetDisposalEventTranslateCreate,
  assetDisposalEventTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  asset: { target: 'assetId', isId: true },
  disposalDate: { target: 'disposalDate' },
  disposalMethod: { target: 'disposalMethod' },
  gainLossType: { target: 'gainLossType' },
  isReversed: { target: 'isReversed' },
};

module.exports = buildTenantModel({
  name: 'AssetDisposalEvent',
  collection: 'assetdisposalevents',
  delegateName: 'assetDisposalEvent',
  fieldMap: FIELD_MAP,
  toApi: assetDisposalEventToApi,
  translateCreate: assetDisposalEventTranslateCreate,
  translateUpdate: assetDisposalEventTranslateUpdate,
  mutable: true,
});
