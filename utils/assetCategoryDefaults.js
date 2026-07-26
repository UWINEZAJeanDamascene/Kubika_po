/**
 * Default fixed-asset categories (RRA/IFRS-aligned).
 * These are NOT product/inventory categories.
 */

const { prisma } = require('../lib/prisma');
const { generateObjectId, toIdString } = require('./objectId');
const {
  assetCategoryToApi,
  assetCategoryTranslateCreate,
} = require('./phase10Mappers');

const DEFAULT_ASSET_CATEGORIES = [
  {
    name: 'Land',
    categoryCode: 'LAND',
    description: 'Land (non-depreciable)',
    isDepreciable: false,
    rraAssetClass: 'land_non_depreciable',
    defaultUsefulLifeMonths: 0,
    defaultDepreciationMethod: 'none',
    defaultAssetAccountCode: '1750',
    defaultAccumDepreciationAccountCode: null,
    defaultDepreciationExpenseAccountCode: null,
    isSystem: true,
  },
  {
    name: 'Buildings & Structures',
    categoryCode: 'BLDG',
    description: 'Buildings, warehouses, factories',
    isDepreciable: true,
    rraAssetClass: 'class_1_buildings',
    rraUsefulLifeYears: 20,
    rraDepreciationMethod: 'straight_line',
    defaultUsefulLifeMonths: 240,
    defaultDepreciationMethod: 'straight_line',
    defaultAssetAccountCode: '1740',
    defaultAccumDepreciationAccountCode: '1850',
    defaultDepreciationExpenseAccountCode: '5800',
    isSystem: true,
  },
  {
    name: 'Plant & Machinery',
    categoryCode: 'MACH',
    description: 'Production equipment and heavy machinery',
    isDepreciable: true,
    rraAssetClass: 'class_3_plant_machinery',
    rraUsefulLifeYears: 5,
    rraDepreciationMethod: 'declining_balance',
    defaultUsefulLifeMonths: 120,
    defaultDepreciationMethod: 'straight_line',
    defaultDecliningRate: 20,
    defaultAssetAccountCode: '1760',
    defaultAccumDepreciationAccountCode: '1860',
    defaultDepreciationExpenseAccountCode: '5800',
    isSystem: true,
  },
  {
    name: 'Computer Equipment & Software',
    categoryCode: 'COMP',
    description: 'Computers, servers, and software licenses',
    isDepreciable: true,
    rraAssetClass: 'class_4_computers_equipment',
    rraUsefulLifeYears: 4,
    rraDepreciationMethod: 'declining_balance',
    defaultUsefulLifeMonths: 48,
    defaultDepreciationMethod: 'straight_line',
    defaultDecliningRate: 25,
    defaultAssetAccountCode: '1710',
    defaultAccumDepreciationAccountCode: '1820',
    defaultDepreciationExpenseAccountCode: '5800',
    isSystem: true,
  },
  {
    name: 'Motor Vehicles',
    categoryCode: 'VEH',
    description: 'Cars, trucks, and motorcycles',
    isDepreciable: true,
    rraAssetClass: 'class_5_motor_vehicles',
    rraUsefulLifeYears: 4,
    rraDepreciationMethod: 'declining_balance',
    defaultUsefulLifeMonths: 60,
    defaultDepreciationMethod: 'straight_line',
    defaultDecliningRate: 25,
    defaultAssetAccountCode: '1720',
    defaultAccumDepreciationAccountCode: '1830',
    defaultDepreciationExpenseAccountCode: '5800',
    isSystem: true,
  },
  {
    name: 'Office Furniture & Fittings',
    categoryCode: 'FURN',
    description: 'Desks, chairs, cabinets, and fittings',
    isDepreciable: true,
    rraAssetClass: 'class_6_furniture_fittings',
    rraUsefulLifeYears: 5,
    rraDepreciationMethod: 'declining_balance',
    defaultUsefulLifeMonths: 84,
    defaultDepreciationMethod: 'straight_line',
    defaultDecliningRate: 20,
    defaultAssetAccountCode: '1730',
    defaultAccumDepreciationAccountCode: '1840',
    defaultDepreciationExpenseAccountCode: '5800',
    isSystem: true,
  },
  {
    name: 'Intangible Assets',
    categoryCode: 'INTANG',
    description: 'Patents, trademarks, and licenses',
    isDepreciable: true,
    rraAssetClass: 'class_7_intangible',
    rraDepreciationMethod: 'straight_line',
    defaultUsefulLifeMonths: 60,
    defaultDepreciationMethod: 'straight_line',
    defaultAssetAccountCode: '1790',
    defaultAccumDepreciationAccountCode: '1890',
    defaultDepreciationExpenseAccountCode: '5800',
    isSystem: true,
  },
];

async function seedAssetCategoryDefaults(companyId, createdById = null) {
  const company = toIdString(companyId);
  if (!company) return [];

  const existing = await prisma.assetCategory.count({
    where: { companyId: company, isDeleted: false },
  });
  if (existing > 0) return [];

  const created = [];
  for (const def of DEFAULT_ASSET_CATEGORIES) {
    const payload = assetCategoryTranslateCreate({
      ...def,
      company,
      companyId: company,
      createdBy: createdById,
      isDeleted: false,
    });
    const row = await prisma.assetCategory.create({
      data: {
        id: generateObjectId(),
        ...payload,
      },
    });
    created.push(assetCategoryToApi(row));
  }

  return created;
}

async function syncDefaultAssetCategoryAccounts(companyId) {
  const company = toIdString(companyId);
  if (!company) return;

  for (const def of DEFAULT_ASSET_CATEGORIES) {
    if (!def.categoryCode) continue;
    await prisma.assetCategory.updateMany({
      where: { companyId: company, categoryCode: def.categoryCode, isSystem: true },
      data: {
        defaultAssetAccountCode: def.defaultAssetAccountCode,
        defaultAccumDepreciationAccountCode: def.defaultAccumDepreciationAccountCode,
        defaultDepreciationExpenseAccountCode: def.defaultDepreciationExpenseAccountCode,
      },
    });
  }
}

module.exports = {
  DEFAULT_ASSET_CATEGORIES,
  seedAssetCategoryDefaults,
  syncDefaultAssetCategoryAccounts,
};
