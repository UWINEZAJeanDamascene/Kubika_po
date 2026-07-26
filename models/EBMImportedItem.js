/**
 * EBMImportedItem — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  ebmImportedItemToApi,
  ebmImportedItemTranslateCreate,
  ebmImportedItemTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  branchId: { target: 'branchId' },
  importTaskCode: { target: 'importTaskCode' },
  confirmationStatus: { target: 'confirmationStatus' },
  product: { target: 'productId', isId: true },
  warehouse: { target: 'warehouseId', isId: true },
  grn: { target: 'grnId', isId: true },
};

module.exports = buildTenantModel({
  name: 'EBMImportedItem',
  collection: 'ebmimporteditems',
  delegateName: 'ebmImportedItem',
  fieldMap: FIELD_MAP,
  toApi: ebmImportedItemToApi,
  translateCreate: ebmImportedItemTranslateCreate,
  translateUpdate: ebmImportedItemTranslateUpdate,
  mutable: true,
});
