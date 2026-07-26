/**
 * InventoryBatch — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  inventoryBatchToApi,
  inventoryBatchTranslateCreate,
  inventoryBatchTranslateUpdate,
} = require('../utils/inventoryJournalMappers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  product: { target: 'productId', isId: true },
  warehouse: { target: 'warehouseId', isId: true },
  batchNumber: { target: 'batchNumber' },
  lotNumber: { target: 'lotNumber' },
  status: { target: 'status' },
  expiryDate: { target: 'expiryDate' },
  supplier: { target: 'supplierId', isId: true },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

function buildInclude(populate = []) {
  const inc = {};
  for (const p of populate) {
    const path = typeof p === 'object' ? p.path : p;
    if (path === 'product') inc.product = true;
    if (path === 'warehouse') inc.warehouse = true;
    if (path === 'supplier') inc.supplier = true;
  }
  return Object.keys(inc).length ? inc : undefined;
}

module.exports = buildTenantModel({
  name: 'InventoryBatch',
  collection: 'inventorybatches',
  delegateName: 'inventoryBatch',
  fieldMap: FIELD_MAP,
  toApi: inventoryBatchToApi,
  translateCreate: inventoryBatchTranslateCreate,
  translateUpdate: inventoryBatchTranslateUpdate,
  include: buildInclude,
  mutable: true,
});
