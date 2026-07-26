/**
 * EBMUnmatchedPurchase — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  ebmUnmatchedPurchaseToApi,
  ebmUnmatchedPurchaseTranslateCreate,
  ebmUnmatchedPurchaseTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  branchId: { target: 'branchId' },
  sellerInvoiceNo: { target: 'sellerInvoiceNo' },
  status: { target: 'status' },
  linkedDocument: { target: 'linkedDocumentId', isId: true },
};

module.exports = buildTenantModel({
  name: 'EBMUnmatchedPurchase',
  collection: 'ebmunmatchedpurchases',
  delegateName: 'ebmUnmatchedPurchase',
  fieldMap: FIELD_MAP,
  toApi: ebmUnmatchedPurchaseToApi,
  translateCreate: ebmUnmatchedPurchaseTranslateCreate,
  translateUpdate: ebmUnmatchedPurchaseTranslateUpdate,
  mutable: true,
});
