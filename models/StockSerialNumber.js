/**
 * StockSerialNumber — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  stockSerialNumberToApi,
  stockSerialNumberTranslateCreate,
  stockSerialNumberTranslateUpdate,
} = require('../utils/inventoryJournalMappers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  serialNo: { target: 'serialNo' },
  product: { target: 'productId', isId: true },
  warehouse: { target: 'warehouseId', isId: true },
  batch: { target: 'batchId', isId: true },
  status: { target: 'status' },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

module.exports = buildTenantModel({
  name: 'StockSerialNumber',
  collection: 'stockserialnumbers',
  delegateName: 'stockSerialNumber',
  fieldMap: FIELD_MAP,
  toApi: stockSerialNumberToApi,
  translateCreate: stockSerialNumberTranslateCreate,
  translateUpdate: stockSerialNumberTranslateUpdate,
  mutable: true,
});
