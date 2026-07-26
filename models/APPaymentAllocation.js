/**
 * APPaymentAllocation — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  apPaymentAllocationToApi,
  apPaymentAllocationTranslateCreate,
  apPaymentAllocationTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  payment: { target: 'paymentId', isId: true },
  grn: { target: 'grnId', isId: true },
  amountAllocated: { target: 'amountAllocated' },
};

module.exports = buildTenantModel({
  name: 'APPaymentAllocation',
  collection: 'appaymentallocations',
  delegateName: 'aPPaymentAllocation',
  fieldMap: FIELD_MAP,
  toApi: apPaymentAllocationToApi,
  translateCreate: apPaymentAllocationTranslateCreate,
  translateUpdate: apPaymentAllocationTranslateUpdate,
  mutable: true,
});
