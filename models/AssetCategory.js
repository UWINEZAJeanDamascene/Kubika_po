/**
 * AssetCategory — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  assetCategoryToApi,
  assetCategoryTranslateCreate,
  assetCategoryTranslateUpdate,
} = require('../utils/phase10Mappers');
const { seedAssetCategoryDefaults, syncDefaultAssetCategoryAccounts } = require('../utils/assetCategoryDefaults');

const FIELD_MAP = {
  name: { target: 'name' },
  categoryCode: { target: 'categoryCode' },
  parentCategoryId: { target: 'parentCategoryId', isId: true },
  isSystem: { target: 'isSystem' },
  isDeleted: { target: 'isDeleted' },
};

const AssetCategory = buildTenantModel({
  name: 'AssetCategory',
  collection: 'assetcategories',
  delegateName: 'assetCategory',
  fieldMap: FIELD_MAP,
  toApi: assetCategoryToApi,
  translateCreate: assetCategoryTranslateCreate,
  translateUpdate: assetCategoryTranslateUpdate,
  mutable: true,
});

AssetCategory.seedDefaults = seedAssetCategoryDefaults;
AssetCategory.syncDefaultAccounts = syncDefaultAssetCategoryAccounts;

module.exports = AssetCategory;