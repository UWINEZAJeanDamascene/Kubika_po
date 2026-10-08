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
  purchase: { target: 'purchaseId', isId: true },
  supplier: { target: 'supplierId', isId: true },
  warehouse: { target: 'warehouseId', isId: true },
  status: { target: 'status' },
  returnDate: { target: 'returnDate' },
  reason: { target: 'reason' },
  totalAmount: { target: 'totalAmount' },
  refundMethod: { target: 'refundMethod' },
  bankAccountId: { target: 'bankAccountId', isId: true },
  supplierCreditNoteNo: { target: 'supplierCreditNoteNo' },
  journalEntry: { target: 'journalEntryId', isId: true },
  refundJournalEntry: { target: 'refundJournalEntryId', isId: true },
  refundBankTransaction: { target: 'refundBankTransactionId', isId: true },
  bankRefundReference: { target: 'bankRefundReference' },
  refundedAt: { target: 'refundedAt' },
  confirmedAt: { target: 'confirmedAt' },
  confirmedBy: { target: 'confirmedById', isId: true },
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
