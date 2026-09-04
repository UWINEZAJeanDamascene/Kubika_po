'use strict';

const { buildTenantModel } = require('../utils/masterDataCommon');
const { generateObjectId, toIdString } = require('../utils/objectId');
const { decimalToNumber } = require('../utils/decimalHelpers');

const map = { company_id: 'companyId', reference_no: 'referenceNo', name: 'name', type: 'type', lenderName: 'lenderName', principalAmount: 'principalAmount', outstandingBalance: 'outstandingBalance', interestRatePct: 'interestRatePct', interestMethod: 'interestMethod', durationMonths: 'durationMonths', liabilityAccountId: 'liabilityAccountId', interestExpenseAccountId: 'interestExpenseAccountId', startDate: 'startDate', endDate: 'endDate', status: 'status', transactions: 'transactions', journalEntryId: 'journalEntryId', notes: 'notes', createdBy: 'createdBy' };
const FIELD_MAP = { _id: { target: 'id', isId: true }, id: { target: 'id', isId: true }, company: { target: 'companyId', isId: true } };
for (const [source, target] of Object.entries(map)) FIELD_MAP[source] = { target, isId: /Id$/.test(target) || target === 'companyId' };

function toApi(row) {
  if (!row) return null;
  const result = { _id: row.id, company: row.companyId };
  for (const [source, target] of Object.entries(map)) result[source] = row[target];
  result.principalAmount = decimalToNumber(row.principalAmount, 0);
  result.outstandingBalance = decimalToNumber(row.outstandingBalance, 0);
  result.transactions = row.transactions || [];
  result.createdAt = row.createdAt;
  result.updatedAt = row.updatedAt;
  return result;
}

function translateCreate(data = {}) {
  const result = { id: toIdString(data._id || data.id) || generateObjectId() };
  for (const [source, target] of Object.entries(map)) {
    if (data[source] !== undefined) result[target] = /Id$/.test(target) || target === 'companyId' ? (data[source] ? toIdString(data[source]) : null) : data[source];
  }
  result.companyId = result.companyId || toIdString(data.company);
  result.referenceNo = result.referenceNo || `LIB-${Date.now().toString(36).toUpperCase()}`;
  result.outstandingBalance = result.outstandingBalance ?? result.principalAmount ?? 0;
  return result;
}

function translateUpdate(update = {}) {
  const source = update.$set ? { ...update, ...update.$set } : { ...update };
  delete source.$set;
  delete source.$unset;
  const result = {};
  for (const [sourceKey, target] of Object.entries(map)) {
    if (source[sourceKey] !== undefined) result[target] = /Id$/.test(target) || target === 'companyId' ? (source[sourceKey] ? toIdString(source[sourceKey]) : null) : source[sourceKey];
  }
  return result;
}

module.exports = buildTenantModel({
  name: 'Liability',
  collection: 'liabilities',
  delegateName: 'liability',
  fieldMap: FIELD_MAP,
  toApi,
  translateCreate,
  translateUpdate,
  tenantField: 'companyId',
  mutable: true,
});
