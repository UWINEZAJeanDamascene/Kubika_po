/**
 * ARBadDebtWriteoff — PostgreSQL (Prisma) backed.
 *
 * The legacy Mongoose schema represented this table as a Mongo-only model even
 * though bad-debt posting already updates PostgreSQL invoices and journals.
 */
const { buildTenantModel } = require('../utils/masterDataCommon');
const { decimalToNumber, decimalToString, mapTimestamps } = require('../utils/decimalHelpers');
const { toIdString, generateObjectId } = require('../utils/objectId');
const { mergeUpdatePayload } = require('../utils/masterDataMappers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  invoice: { target: 'invoiceId', isId: true },
  client: { target: 'clientId', isId: true },
  writeoffDate: { target: 'writeoffDate' },
  amount: { target: 'amount' },
  reason: { target: 'reason' },
  notes: { target: 'notes' },
  journalEntry: { target: 'journalEntryId', isId: true },
  postedBy: { target: 'postedById', isId: true },
  status: { target: 'status' },
  reversedAt: { target: 'reversedAt' },
  reversedBy: { target: 'reversedById', isId: true },
  reversalReason: { target: 'reversalReason' },
  reverseJournalEntry: { target: 'reverseJournalEntryId', isId: true },
  createdBy: { target: 'createdById', isId: true },
  referenceNo: { target: 'referenceNo' },
};

function toApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    invoice: row.invoiceId,
    client: row.clientId,
    writeoffDate: row.writeoffDate,
    amount: decimalToString(row.amount, 2),
    amountValue: decimalToNumber(row.amount, 0),
    reason: row.reason,
    notes: row.notes ?? null,
    journalEntry: row.journalEntryId ?? null,
    postedBy: row.postedById ?? null,
    status: row.status,
    reversedAt: row.reversedAt ?? null,
    reversedBy: row.reversedById ?? null,
    reversalReason: row.reversalReason ?? null,
    reverseJournalEntry: row.reverseJournalEntryId ?? null,
    createdBy: row.createdById,
    ...mapTimestamps(row),
  };
}

async function toCreate(data = {}) {
  const companyId = toIdString(data.company || data.companyId);
  let referenceNo = data.referenceNo;
  if (!referenceNo && process.env.DATABASE_URL) {
    const { generateUniqueNumber } = require('./utils/autoIncrement');
    referenceNo = await generateUniqueNumber('BDW', null, companyId, 'referenceNo');
  }
  if (!referenceNo) referenceNo = `BDW-${Date.now()}-${generateObjectId().slice(-6)}`;
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId,
    referenceNo,
    invoiceId: toIdString(data.invoice || data.invoiceId),
    clientId: toIdString(data.client || data.clientId),
    writeoffDate: data.writeoffDate ? new Date(data.writeoffDate) : new Date(),
    amount: data.amount ?? 0,
    reason: data.reason,
    notes: data.notes ?? null,
    journalEntryId: toIdString(data.journalEntry || data.journalEntryId),
    postedById: toIdString(data.postedBy || data.postedById),
    status: data.status || 'draft',
    reversedAt: data.reversedAt ? new Date(data.reversedAt) : null,
    reversedById: toIdString(data.reversedBy || data.reversedById),
    reversalReason: data.reversalReason ?? null,
    reverseJournalEntryId: toIdString(data.reverseJournalEntry || data.reverseJournalEntryId),
    createdById: toIdString(data.createdBy || data.createdById),
  };
}

function toUpdate(update = {}) {
  const data = mergeUpdatePayload(update);
  const out = {};
  for (const [key, mapping] of Object.entries(FIELD_MAP)) {
    if (data[key] === undefined || key === '_id' || key === 'id' || key === 'company') continue;
    out[mapping.target] = mapping.isId ? toIdString(data[key]) : data[key];
  }
  return out;
}

module.exports = buildTenantModel({
  name: 'ARBadDebtWriteoff',
  collection: 'ar_bad_debt_writeoffs',
  delegateName: 'arBadDebtWriteoff',
  fieldMap: FIELD_MAP,
  toApi,
  translateCreate: async (data) => toCreate(data),
  translateUpdate: toUpdate,
  mutable: true,
});
