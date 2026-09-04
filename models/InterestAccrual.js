'use strict';

const { buildTenantModel } = require('../utils/masterDataCommon');
const { generateObjectId, toIdString } = require('../utils/objectId');
const { decimalToNumber } = require('../utils/decimalHelpers');

const map = { company: 'companyId', bankAccount: 'bankAccountId', fixedDeposit: 'fixedDepositId', principal: 'principal', rate: 'rate', daysInPeriod: 'daysInPeriod', calculatedInterest: 'calculatedInterest', method: 'method', status: 'status', accrualJournalEntryId: 'accrualJournalEntryId', receiptJournalEntryId: 'receiptJournalEntryId', journalEntryId: 'journalEntryId', source: 'source', sourceTag: 'sourceTag', confirmedAt: 'confirmedAt', confirmedBy: 'confirmedBy', notes: 'notes', withholdingTax: 'withholdingTax', grossInterest: 'grossInterest', createdBy: 'createdBy' };
const FIELD_MAP = { _id: { target: 'id', isId: true }, id: { target: 'id', isId: true }, 'period.month': { target: 'periodMonth' }, 'period.year': { target: 'periodYear' } };
for (const [source, target] of Object.entries(map)) FIELD_MAP[source] = { target, isId: /Id$/.test(target) || target === 'companyId' };

function toApi(row) {
  if (!row) return null;
  const result = { _id: row.id, period: { month: row.periodMonth, year: row.periodYear } };
  for (const [source, target] of Object.entries(map)) result[source] = row[target];
  for (const field of ['principal', 'calculatedInterest', 'withholdingTax', 'grossInterest']) result[field] = decimalToNumber(row[field], 0);
  result.createdAt = row.createdAt;
  result.updatedAt = row.updatedAt;
  return result;
}

function translateCreate(data = {}) {
  const period = data.period || {};
  const result = { id: toIdString(data._id || data.id) || generateObjectId(), periodMonth: period.month, periodYear: period.year };
  for (const [source, target] of Object.entries(map)) {
    if (data[source] !== undefined) result[target] = /Id$/.test(target) || target === 'companyId' ? (data[source] ? toIdString(data[source]) : null) : data[source];
  }
  return result;
}

function translateUpdate(update = {}) {
  const source = update.$set ? { ...update, ...update.$set } : { ...update };
  delete source.$set;
  delete source.$unset;
  const result = {};
  if (source.period?.month !== undefined) result.periodMonth = source.period.month;
  if (source.period?.year !== undefined) result.periodYear = source.period.year;
  for (const [sourceKey, target] of Object.entries(map)) {
    if (source[sourceKey] !== undefined) result[target] = /Id$/.test(target) || target === 'companyId' ? (source[sourceKey] ? toIdString(source[sourceKey]) : null) : source[sourceKey];
  }
  return result;
}

module.exports = buildTenantModel({
  name: 'InterestAccrual',
  collection: 'interest_accruals',
  delegateName: 'interestAccrual',
  fieldMap: FIELD_MAP,
  toApi,
  translateCreate,
  translateUpdate,
  tenantField: 'companyId',
  mutable: true,
});
