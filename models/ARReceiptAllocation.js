/**
 * ARReceiptAllocation — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  arReceiptAllocationToApi,
  arReceiptAllocationTranslateCreate,
  arReceiptAllocationTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  receipt: { target: 'receiptId', isId: true },
  invoice: { target: 'invoiceId', isId: true },
  amountAllocated: { target: 'amountAllocated' },
};

module.exports = buildTenantModel({
  name: 'ARReceiptAllocation',
  collection: 'arreceiptallocations',
  delegateName: 'aRReceiptAllocation',
  fieldMap: FIELD_MAP,
  toApi: arReceiptAllocationToApi,
  translateCreate: arReceiptAllocationTranslateCreate,
  translateUpdate: arReceiptAllocationTranslateUpdate,
  mutable: true,
});
