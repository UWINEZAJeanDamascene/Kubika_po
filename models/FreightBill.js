/**
 * FreightBill — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  freightBillToApi,
  freightBillTranslateCreate,
  freightBillTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  supplier: { target: 'supplierId', isId: true },
  status: { target: 'status' },
  invoiceDate: { target: 'invoiceDate' },
};

module.exports = buildTenantModel({
  name: 'FreightBill',
  collection: 'freightbills',
  delegateName: 'freightBill',
  fieldMap: FIELD_MAP,
  toApi: freightBillToApi,
  translateCreate: freightBillTranslateCreate,
  translateUpdate: freightBillTranslateUpdate,
  mutable: true,
});
