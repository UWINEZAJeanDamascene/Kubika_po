/**
 * StockTransferLine — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  stockTransferLineToApi,
  stockTransferLineTranslateCreate,
  stockTransferLineTranslateUpdate,
} = require('../utils/inventoryJournalMappers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  transfer: { target: 'transferId', isId: true },
  product: { target: 'productId', isId: true },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

module.exports = buildTenantModel({
  name: 'StockTransferLine',
  collection: 'stocktransferlines',
  delegateName: 'stockTransferLine',
  fieldMap: FIELD_MAP,
  toApi: stockTransferLineToApi,
  translateCreate: stockTransferLineTranslateCreate,
  translateUpdate: stockTransferLineTranslateUpdate,
  mutable: true,
});
