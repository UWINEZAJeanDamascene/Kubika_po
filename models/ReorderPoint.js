/**
 * ReorderPoint — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  reorderPointToApi,
  reorderPointTranslateCreate,
  reorderPointTranslateUpdate,
} = require('../utils/inventoryJournalMappers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  product: { target: 'productId', isId: true },
  supplier: { target: 'supplierId', isId: true },
  isActive: { target: 'isActive' },
  autoReorder: { target: 'autoReorder' },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

function buildInclude(populate = []) {
  const inc = {};
  for (const p of populate) {
    const path = typeof p === 'object' ? p.path : p;
    if (path === 'product') inc.product = true;
    if (path === 'supplier') inc.supplier = true;
  }
  return Object.keys(inc).length ? inc : undefined;
}

module.exports = buildTenantModel({
  name: 'ReorderPoint',
  collection: 'reorderpoints',
  delegateName: 'reorderPoint',
  fieldMap: FIELD_MAP,
  toApi: reorderPointToApi,
  translateCreate: reorderPointTranslateCreate,
  translateUpdate: reorderPointTranslateUpdate,
  include: buildInclude,
  mutable: true,
});
