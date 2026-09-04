'use strict';

const { buildTenantModel } = require('../utils/masterDataCommon');
const { generateObjectId, toIdString } = require('../utils/objectId');
const { decimalToNumber } = require('../utils/decimalHelpers');

const sourceToTarget = {
  company: 'companyId', bankAccount: 'bankAccountId', depositReference: 'depositReference', bankName: 'bankName',
  principalAmount: 'principalAmount', interestRate: 'interestRate', startDate: 'startDate', maturityDate: 'maturityDate',
  interestPaymentFrequency: 'interestPaymentFrequency', linkedAssetAccount: 'linkedAssetAccount', linkedIncomeAccount: 'linkedIncomeAccount',
  linkedAccrualAccount: 'linkedAccrualAccount', autoRollover: 'autoRollover', status: 'status', totalInterestAccrued: 'totalInterestAccrued',
  totalInterestReceived: 'totalInterestReceived', notes: 'notes', createdBy: 'createdBy',
};
const FIELD_MAP = { _id: { target: 'id', isId: true }, id: { target: 'id', isId: true } };
for (const [source, target] of Object.entries(sourceToTarget)) FIELD_MAP[source] = { target, isId: /Id$/.test(target) };

function toApi(row) {
  if (!row) return null;
  const result = { _id: row.id };
  for (const [source, target] of Object.entries(sourceToTarget)) result[source] = row[target];
  result.principalAmount = decimalToNumber(row.principalAmount, 0);
  result.totalInterestAccrued = decimalToNumber(row.totalInterestAccrued, 0);
  result.totalInterestReceived = decimalToNumber(row.totalInterestReceived, 0);
  result.createdAt = row.createdAt;
  result.updatedAt = row.updatedAt;
  return result;
}

function translateCreate(data = {}) {
  const result = { id: toIdString(data._id || data.id) || generateObjectId() };
  for (const [source, target] of Object.entries(sourceToTarget)) {
    if (data[source] !== undefined) result[target] = /Id$/.test(target) ? (data[source] ? toIdString(data[source]) : null) : data[source];
  }
  return result;
}

function translateUpdate(update = {}) {
  const source = update.$set ? { ...update, ...update.$set } : { ...update };
  delete source.$set;
  delete source.$unset;
  const result = {};
  for (const [sourceKey, target] of Object.entries(sourceToTarget)) {
    if (source[sourceKey] !== undefined) result[target] = /Id$/.test(target) ? (source[sourceKey] ? toIdString(source[sourceKey]) : null) : source[sourceKey];
  }
  return result;
}

module.exports = buildTenantModel({
  name: 'FixedDeposit',
  collection: 'fixed_deposits',
  delegateName: 'fixedDeposit',
  fieldMap: FIELD_MAP,
  toApi,
  translateCreate,
  translateUpdate,
  mutable: true,
});
