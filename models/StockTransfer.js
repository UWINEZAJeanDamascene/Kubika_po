/**
 * StockTransfer — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  stockTransferToApi,
  stockTransferTranslateCreate,
  stockTransferTranslateUpdate,
} = require('../utils/inventoryJournalMappers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  transferNumber: { target: 'transferNumber' },
  fromWarehouse: { target: 'fromWarehouseId', isId: true },
  toWarehouse: { target: 'toWarehouseId', isId: true },
  status: { target: 'status' },
  transferDate: { target: 'transferDate' },
  reason: { target: 'reason' },
  journalEntry: { target: 'journalEntryId', isId: true },
  createdBy: { target: 'createdById', isId: true },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

function buildInclude(populate = []) {
  const omitLines = populate.some((p) => {
    const path = typeof p === 'object' ? p.path : p;
    return path === '-lines' || path === '-items';
  });
  const inc = omitLines
    ? { _count: { select: { lines: true } } }
    : {
      lines: {
        select: {
          id: true, companyId: true, transferId: true, productId: true,
          qty: true, unitCost: true, notes: true, createdById: true,
          createdAt: true, updatedAt: true,
          product: { select: { id: true, name: true, sku: true, unit: true } },
        },
      },
    };
  for (const p of populate) {
    const path = typeof p === 'object' ? p.path : p;
    if (path === 'fromWarehouse') inc.fromWarehouse = { select: { id: true, name: true, code: true } };
    if (path === 'toWarehouse') inc.toWarehouse = { select: { id: true, name: true, code: true } };
    if (path === 'items') inc.lines = inc.lines || { select: { id: true, productId: true, qty: true, unitCost: true } };
  }
  return inc;
}

module.exports = buildTenantModel({
  name: 'StockTransfer',
  collection: 'stocktransfers',
  delegateName: 'stockTransfer',
  fieldMap: FIELD_MAP,
  toApi: stockTransferToApi,
  translateCreate: stockTransferTranslateCreate,
  translateUpdate: stockTransferTranslateUpdate,
  include: buildInclude,
  mutable: true,
});
