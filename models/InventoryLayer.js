/**
 * InventoryLayer — PostgreSQL (Prisma) backed (FIFO layers).
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  inventoryLayerToApi,
  inventoryLayerTranslateCreate,
  inventoryLayerTranslateUpdate,
} = require('../utils/inventoryJournalMappers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  product: { target: 'productId', isId: true },
  warehouse: { target: 'warehouseId', isId: true },
  qtyRemaining: { target: 'qtyRemaining' },
  receiptDate: { target: 'receiptDate' },
  createdAt: { target: 'createdAt' },
};

module.exports = buildTenantModel({
  name: 'InventoryLayer',
  collection: 'inventorylayers',
  delegateName: 'inventoryLayer',
  fieldMap: FIELD_MAP,
  toApi: inventoryLayerToApi,
  translateCreate: inventoryLayerTranslateCreate,
  translateUpdate: inventoryLayerTranslateUpdate,
  mutable: true,
});
