/**
 * ARReceipt — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  arReceiptToApi,
  arReceiptTranslateCreate,
  arReceiptTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  client: { target: 'clientId', isId: true },
  status: { target: 'status' },
  receiptDate: { target: 'receiptDate' },
};

module.exports = buildTenantModel({
  name: 'ARReceipt',
  collection: 'arreceipts',
  delegateName: 'aRReceipt',
  fieldMap: FIELD_MAP,
  toApi: arReceiptToApi,
  translateCreate: arReceiptTranslateCreate,
  translateUpdate: arReceiptTranslateUpdate,
  mutable: true,
});
