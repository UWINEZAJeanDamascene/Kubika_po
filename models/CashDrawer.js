'use strict';

const { buildTenantModel } = require('../utils/masterDataCommon');
const { generateObjectId, toIdString } = require('../utils/objectId');
const { decimalToNumber } = require('../utils/decimalHelpers');

const map = { company: 'companyId', drawerId: 'drawerId', status: 'status', openedBy: 'openedBy', openedAt: 'openedAt', closedBy: 'closedBy', closedAt: 'closedAt', openingBalance: 'openingBalance', closingBalance: 'closingBalance', transactions: 'transactions', notes: 'notes' };
const FIELD_MAP = { _id: { target: 'id', isId: true }, id: { target: 'id', isId: true } };
for (const [source, target] of Object.entries(map)) FIELD_MAP[source] = { target, isId: /By$/.test(target) || target === 'companyId' };

function toApi(row) {
  if (!row) return null;
  const result = { _id: row.id };
  for (const [source, target] of Object.entries(map)) result[source] = row[target];
  result.openingBalance = decimalToNumber(row.openingBalance, 0);
  result.closingBalance = decimalToNumber(row.closingBalance, 0);
  result.transactions = row.transactions || [];
  result.createdAt = row.createdAt;
  result.updatedAt = row.updatedAt;
  return result;
}

function translateCreate(data = {}) {
  const result = { id: toIdString(data._id || data.id) || generateObjectId() };
  for (const [source, target] of Object.entries(map)) {
    if (data[source] !== undefined) result[target] = /By$/.test(target) || target === 'companyId' ? (data[source] ? toIdString(data[source]) : null) : data[source];
  }
  return result;
}

function translateUpdate(update = {}) {
  const sourceData = update.$set ? { ...update, ...update.$set } : { ...update };
  delete sourceData.$set;
  delete sourceData.$unset;
  const result = {};
  for (const [source, target] of Object.entries(map)) {
    if (sourceData[source] !== undefined) result[target] = /By$/.test(target) || target === 'companyId' ? (sourceData[source] ? toIdString(sourceData[source]) : null) : sourceData[source];
  }
  return result;
}

module.exports = buildTenantModel({
  name: 'CashDrawer',
  collection: 'cash_drawers',
  delegateName: 'cashDrawer',
  fieldMap: FIELD_MAP,
  toApi,
  translateCreate,
  translateUpdate,
  mutable: true,
});
