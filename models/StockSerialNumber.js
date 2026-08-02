/**
 * StockSerialNumber — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  stockSerialNumberToApi,
  stockSerialNumberTranslateCreate,
  stockSerialNumberTranslateUpdate,
} = require('../utils/inventoryJournalMappers');


function buildStockSerialNumberInclude(populate = []) {
  if (!populate || !populate.length) return undefined;
  const inc = {};
  for (const p of populate) {
    const path = typeof p === 'object' ? p.path : p;
    if (path === 'product') inc.product = { select: { id: true, name: true, sku: true, unit: true, trackingType: true } };
    if (path === 'warehouse') inc.warehouse = { select: { id: true, name: true, code: true } };
    if (path === 'batch') inc.batch = { select: { id: true, batchNo: true, expiryDate: true } };
  }
  return Object.keys(inc).length ? inc : undefined;
}
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
  include: buildStockSerialNumberInclude,
});
