/**
 * PurchaseReturn — PostgreSQL (Prisma) backed.
 */

const { buildDocumentModel, buildLineInclude } = require('../utils/salesApCommon');
const {
  purchaseReturnToApi,
  purchaseReturnTranslateCreate,
  purchaseReturnTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  grn: { target: 'grnId', isId: true },
  supplier: { target: 'supplierId', isId: true },
  warehouse: { target: 'warehouseId', isId: true },
  status: { target: 'status' },
  returnDate: { target: 'returnDate' },
};

module.exports = buildDocumentModel({
  name: 'PurchaseReturn',
  collection: 'purchasereturns',
  delegateName: 'purchaseReturn',
  fieldMap: FIELD_MAP,
  toApi: purchaseReturnToApi,
  translateCreate: purchaseReturnTranslateCreate,
  translateUpdate: purchaseReturnTranslateUpdate,
  include: buildLineInclude(),
});
