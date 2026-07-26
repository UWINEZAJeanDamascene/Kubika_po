/**
 * APPayment — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  apPaymentToApi,
  apPaymentTranslateCreate,
  apPaymentTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  supplier: { target: 'supplierId', isId: true },
  status: { target: 'status' },
  paymentDate: { target: 'paymentDate' },
};

module.exports = buildTenantModel({
  name: 'APPayment',
  collection: 'appayments',
  delegateName: 'aPPayment',
  fieldMap: FIELD_MAP,
  toApi: apPaymentToApi,
  translateCreate: apPaymentTranslateCreate,
  translateUpdate: apPaymentTranslateUpdate,
  mutable: true,
});
