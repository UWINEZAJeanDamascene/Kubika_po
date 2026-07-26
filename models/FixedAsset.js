/**
 * FixedAsset — PostgreSQL (Prisma) backed.
 * Also exports DepreciationEntry (legacy export pattern preserved).
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  fixedAssetToApi,
  fixedAssetTranslateCreate,
  fixedAssetTranslateUpdate,
  depreciationEntryToApi,
  depreciationEntryTranslateCreate,
  depreciationEntryTranslateUpdate,
} = require('../utils/phase10Mappers');
const {
  generateFixedAssetReferenceNo,
  ensureFixedAssetReferenceNo,
} = require('../utils/fixedAssetReference');
const { buildFixedAssetInstanceMethods } = require('../utils/fixedAssetDepreciation');

const FIXED_ASSET_FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  name: { target: 'name' },
  categoryId: { target: 'categoryId', isId: true },
  status: { target: 'status' },
  assetAccountCode: { target: 'assetAccountCode' },
  departmentId: { target: 'departmentId', isId: true },
  isDeleted: { target: 'isDeleted' },
};

const DEPRECIATION_ENTRY_FIELD_MAP = {
  asset: { target: 'assetId', isId: true },
  periodDate: { target: 'periodDate' },
  journalEntryId: { target: 'journalEntryId', isId: true },
  isReversed: { target: 'isReversed' },
  isDeleted: { target: 'isDeleted' },
};

const fixedAssetInclude = (populate = []) => {
  const paths = (Array.isArray(populate) ? populate : [populate])
    .map((entry) => (typeof entry === 'object' ? entry?.path : entry))
    .filter(Boolean);
  const inc = {};
  if (paths.some((p) => p === 'categoryId' || p === 'category')) {
    inc.category = {
      select: {
        id: true,
        name: true,
        description: true,
        defaultUsefulLifeMonths: true,
        defaultDepreciationMethod: true,
      },
    };
  }
  return Object.keys(inc).length ? inc : undefined;
};

const FixedAsset = buildTenantModel({
  name: 'FixedAsset',
  collection: 'fixedassets',
  delegateName: 'fixedAsset',
  fieldMap: FIXED_ASSET_FIELD_MAP,
  toApi: fixedAssetToApi,
  translateCreate: fixedAssetTranslateCreate,
  translateUpdate: fixedAssetTranslateUpdate,
  mutable: true,
  instanceMethods: buildFixedAssetInstanceMethods(),
  include: fixedAssetInclude,
});

FixedAsset.generateReferenceNo = generateFixedAssetReferenceNo;
FixedAsset.ensureReferenceNo = ensureFixedAssetReferenceNo;

const DepreciationEntry = buildTenantModel({
  name: 'DepreciationEntry',
  collection: 'depreciationentries',
  delegateName: 'depreciationEntry',
  fieldMap: DEPRECIATION_ENTRY_FIELD_MAP,
  toApi: depreciationEntryToApi,
  translateCreate: depreciationEntryTranslateCreate,
  translateUpdate: depreciationEntryTranslateUpdate,
  mutable: true,
});

module.exports = FixedAsset;
module.exports.FixedAsset = FixedAsset;
module.exports.DepreciationEntry = DepreciationEntry;
