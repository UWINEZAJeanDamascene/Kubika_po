'use strict';

const { buildTenantModel } = require('../utils/masterDataCommon');
const { generateObjectId, toIdString } = require('../utils/objectId');
const { decimalToNumber } = require('../utils/decimalHelpers');

const map = { company: 'companyId', purchase: 'purchaseId', supplier: 'supplierId', installmentNumber: 'installmentNumber', scheduledAmount: 'scheduledAmount', scheduledDate: 'scheduledDate', paidAmount: 'paidAmount', paidDate: 'paidDate', paymentMethod: 'paymentMethod', paymentReference: 'paymentReference', paymentNotes: 'paymentNotes', earlyPaymentDiscount: 'earlyPaymentDiscount', notes: 'notes', createdBy: 'createdBy', updatedBy: 'updatedBy' };
const FIELD_MAP = { _id: { target: 'id', isId: true }, id: { target: 'id', isId: true } };
for (const [source, target] of Object.entries(map)) FIELD_MAP[source] = { target, isId: /Id$/.test(target) };

function toApi(row) {
  if (!row) return null;
  const result = { _id: row.id };
  for (const [source, target] of Object.entries(map)) result[source] = row[target];
  result.scheduledAmount = decimalToNumber(row.scheduledAmount, 0);
  result.paidAmount = decimalToNumber(row.paidAmount, 0);
  result.createdAt = row.createdAt;
  result.updatedAt = row.updatedAt;
  return result;
}

function translateCreate(data = {}) {
  const result = { id: toIdString(data._id || data.id) || generateObjectId() };
  for (const [source, target] of Object.entries(map)) {
    if (data[source] !== undefined) result[target] = /Id$/.test(target) ? (data[source] ? toIdString(data[source]) : null) : data[source];
  }
  return result;
}

function translateUpdate(update = {}) {
  const sourceData = update.$set ? { ...update, ...update.$set } : { ...update };
  delete sourceData.$set;
  delete sourceData.$unset;
  const result = {};
  for (const [sourceKey, target] of Object.entries(map)) {
    if (sourceData[sourceKey] !== undefined) result[target] = /Id$/.test(target) ? (sourceData[sourceKey] ? toIdString(sourceData[sourceKey]) : null) : sourceData[sourceKey];
  }
  return result;
}

module.exports = buildTenantModel({
  name: 'PaymentSchedule',
  collection: 'payment_schedules',
  delegateName: 'paymentSchedule',
  fieldMap: FIELD_MAP,
  toApi,
  translateCreate,
  translateUpdate,
  mutable: true,
});
