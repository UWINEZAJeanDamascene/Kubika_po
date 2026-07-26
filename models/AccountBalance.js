/**
 * AccountBalance — PostgreSQL (Prisma) backed.
 * Atomic adjust() via upsert + increment for fast trial balance reads.
 */

const mongoose = require('mongoose');
const { prisma } = require('../lib/prisma');
const { makeCompatModel, translateFilter, IMPOSSIBLE, toId } = require('../utils/prismaCompat');
const { generateObjectId } = require('../utils/objectId');
const { accountBalanceToApi } = require('../utils/inventoryJournalMappers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  accountCode: { target: 'accountCode' },
};

if (!mongoose.models.AccountBalance) {
  mongoose.model('AccountBalance', new mongoose.Schema({}, { strict: false, collection: 'accountbalances' }));
}

const base = makeCompatModel({
  delegate: () => prisma.accountBalance,
  fieldMap: FIELD_MAP,
  toApi: accountBalanceToApi,
  translateCreate: async (data) => ({
    id: toId(data._id) || generateObjectId(),
    companyId: toId(data.company || data.companyId),
    accountCode: data.accountCode,
    debit: data.debit ?? 0,
    credit: data.credit ?? 0,
  }),
  translateUpdate: (update) => {
    const data = update.$set ? { ...update, ...update.$set } : { ...update };
    const out = {};
    if (data.debit !== undefined) out.debit = data.debit;
    if (data.credit !== undefined) out.credit = data.credit;
    if (data.updatedAt !== undefined) out.updatedAt = data.updatedAt;
    return out;
  },
  tenantField: 'companyId',
});

base.adjust = async function adjust(companyId, accountCode, deltaDebit = 0, deltaCredit = 0) {
  const cid = toId(companyId);
  const code = String(accountCode);
  const existing = await prisma.accountBalance.findUnique({
    where: { companyId_accountCode: { companyId: cid, accountCode: code } },
  });
  if (existing) {
    const row = await prisma.accountBalance.update({
      where: { id: existing.id },
      data: {
        debit: { increment: deltaDebit },
        credit: { increment: deltaCredit },
        updatedAt: new Date(),
      },
    });
    return accountBalanceToApi(row);
  }
  const row = await prisma.accountBalance.create({
    data: {
      id: generateObjectId(),
      companyId: cid,
      accountCode: code,
      debit: deltaDebit,
      credit: deltaCredit,
      updatedAt: new Date(),
    },
  });
  return accountBalanceToApi(row);
};

module.exports = base;
