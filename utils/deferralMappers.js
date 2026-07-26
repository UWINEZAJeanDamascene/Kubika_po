/**
 * Maps Prisma deferred_revenues / prepaid_expenses rows to the legacy Mongoose
 * shape their services and pages read.
 *
 * The recognition (revenue) and amortization (expense) schedules were Mongoose
 * subdocument arrays; they live in a JSON column now, keeping the `_id` per row
 * so `postRecognition(itemId, recognitionId)` still addresses a single period.
 */

const { generateObjectId, toIdString } = require('./objectId');
const { decimalToNumber, mapTimestamps } = require('./decimalHelpers');
const { mergeUpdatePayload } = require('./masterDataMappers');

function scheduleRowToApi(row = {}) {
  return {
    _id: row._id || row.id || null,
    amount: decimalToNumber(row.amount, 0),
    date: row.date ?? null,
    description: row.description ?? '',
    status: row.status || 'pending',
    journalEntryId: row.journalEntryId ?? null,
    createdAt: row.createdAt ?? null,
  };
}

/** Schedule rows arrive from the services without ids; mint one per period. */
function scheduleToDb(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    ...scheduleRowToApi(row),
    _id: toIdString(row._id || row.id) || generateObjectId(),
    date: row.date ? new Date(row.date).toISOString() : null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
    journalEntryId: toIdString(row.journalEntryId) || null,
  }));
}

const SHARED_TEXT = ['referenceNo', 'description', 'paymentMethod', 'frequency', 'status', 'notes'];

function toApi(row, { party, partyField, scheduleField, totalField }) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    [party]: row[party] ?? '',
    description: row.description,
    totalAmount: decimalToNumber(row.totalAmount, 0),
    [partyField]: row[partyField],
    paymentMethod: row.paymentMethod,
    bankAccountId: row.bankAccountId ?? null,
    startDate: row.startDate,
    endDate: row.endDate,
    frequency: row.frequency,
    status: row.status,
    remainingBalance: decimalToNumber(row.remainingBalance, 0),
    [totalField]: decimalToNumber(row[totalField], 0),
    [scheduleField]: (row[scheduleField] || []).map(scheduleRowToApi),
    journalEntryId: row.journalEntryId ?? null,
    notes: row.notes ?? '',
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

function translateCreate(data, { party, partyField, scheduleField, totalField }) {
  const out = {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId: toIdString(data.company ?? data.companyId ?? data.company_id),
    referenceNo: data.referenceNo,
    [party]: data[party] ?? '',
    description: data.description,
    totalAmount: decimalToNumber(data.totalAmount, 0),
    [partyField]: data[partyField],
    paymentMethod: data.paymentMethod || 'cash',
    bankAccountId: toIdString(data.bankAccountId) || null,
    startDate: data.startDate ? new Date(data.startDate) : null,
    endDate: data.endDate ? new Date(data.endDate) : null,
    frequency: data.frequency || 'monthly',
    status: data.status || 'active',
    remainingBalance: decimalToNumber(data.remainingBalance, 0),
    [totalField]: decimalToNumber(data[totalField], 0),
    [scheduleField]: scheduleToDb(data[scheduleField]),
    journalEntryId: toIdString(data.journalEntryId) || null,
    notes: data.notes ?? null,
    createdById: toIdString(data.createdBy ?? data.createdById) || null,
  };
  return out;
}

function translateUpdate(update, { party, partyField, scheduleField, totalField }) {
  const merged = mergeUpdatePayload(update);
  const out = {};

  for (const field of [...SHARED_TEXT, party, partyField]) {
    if (merged[field] !== undefined) out[field] = merged[field];
  }
  for (const field of ['totalAmount', 'remainingBalance', totalField]) {
    if (merged[field] !== undefined) out[field] = decimalToNumber(merged[field], 0);
  }
  for (const field of ['startDate', 'endDate']) {
    if (merged[field] !== undefined) out[field] = merged[field] ? new Date(merged[field]) : null;
  }
  if (merged[scheduleField] !== undefined) out[scheduleField] = scheduleToDb(merged[scheduleField]);
  if (merged.bankAccountId !== undefined) out.bankAccountId = toIdString(merged.bankAccountId) || null;
  if (merged.journalEntryId !== undefined) out.journalEntryId = toIdString(merged.journalEntryId) || null;
  const createdBy = merged.createdBy ?? merged.createdById;
  if (createdBy !== undefined) out.createdById = toIdString(createdBy) || null;

  return out;
}

const DEFERRED = { party: 'customer', partyField: 'revenueAccountCode', scheduleField: 'recognitions', totalField: 'totalRecognized' };
const PREPAID = { party: 'vendor', partyField: 'expenseAccountCode', scheduleField: 'amortizations', totalField: 'totalAmortized' };

module.exports = {
  deferredRevenueToApi: (row) => toApi(row, DEFERRED),
  deferredRevenueTranslateCreate: (data = {}) => translateCreate(data, DEFERRED),
  deferredRevenueTranslateUpdate: (update = {}) => translateUpdate(update, DEFERRED),
  prepaidExpenseToApi: (row) => toApi(row, PREPAID),
  prepaidExpenseTranslateCreate: (data = {}) => translateCreate(data, PREPAID),
  prepaidExpenseTranslateUpdate: (update = {}) => translateUpdate(update, PREPAID),
};
