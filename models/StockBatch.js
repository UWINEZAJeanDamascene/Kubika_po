/**
 * StockBatch — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  stockBatchToApi,
  stockBatchTranslateCreate,
  stockBatchTranslateUpdate,
} = require('../utils/inventoryJournalMappers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  batchNo: { target: 'batchNo' },
  product: { target: 'productId', isId: true },
  warehouse: { target: 'warehouseId', isId: true },
  grn: { target: 'grnId', isId: true },
  isQuarantined: { target: 'isQuarantined' },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

module.exports = buildTenantModel({
  name: 'StockBatch',
  collection: 'stockbatches',
  delegateName: 'stockBatch',
  fieldMap: FIELD_MAP,
  toApi: stockBatchToApi,
  translateCreate: stockBatchTranslateCreate,
  translateUpdate: stockBatchTranslateUpdate,
  mutable: true,
});
