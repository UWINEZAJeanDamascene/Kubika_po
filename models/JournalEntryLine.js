/**
 * JournalEntryLine — PostgreSQL (Prisma) backed (normalized lines table).
 */

const { prisma } = require('../lib/prisma');
const { buildTenantModel } = require('../utils/masterDataCommon');
const { journalLineToApi, tenantCreateBase } = require('../utils/inventoryJournalMappers');
const { generateObjectId, toIdString } = require('../utils/objectId');

function lineRowToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company_id: row.companyId,
    journal_entry_id: row.journalEntryId,
    account_id: row.accountId ?? null,
    debit: Number(row.debit),
    credit: Number(row.credit),
    ...journalLineToApi(row),
  };
}

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company_id: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  journal_entry_id: { target: 'journalEntryId', isId: true },
  journalEntryId: { target: 'journalEntryId', isId: true },
  account_id: { target: 'accountId', isId: true },
  accountCode: { target: 'accountCode' },
};

module.exports = buildTenantModel({
  name: 'JournalEntryLine',
  collection: 'journalentrylines',
  delegateName: 'journalEntryLine',
  fieldMap: FIELD_MAP,
  toApi: lineRowToApi,
  translateCreate: async (data) => ({
    id: toIdString(data._id) || generateObjectId(),
    companyId: toIdString(data.company_id || data.companyId || data.company),
    journalEntryId: toIdString(data.journal_entry_id || data.journalEntryId),
    accountId: data.account_id ? toIdString(data.account_id) : null,
    accountCode: data.accountCode || '',
    accountName: data.accountName || data.accountCode || '',
    debit: data.debit ?? 0,
    credit: data.credit ?? 0,
  }),
  translateUpdate: (update) => {
    const data = update.$set ? { ...update, ...update.$set } : { ...update };
    const out = {};
    if (data.debit !== undefined) out.debit = data.debit;
    if (data.credit !== undefined) out.credit = data.credit;
    if (data.accountCode !== undefined) out.accountCode = data.accountCode;
    return out;
  },
  tenantField: 'companyId',
});
