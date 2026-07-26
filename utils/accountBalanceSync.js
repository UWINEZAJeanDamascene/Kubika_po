/**
 * Keep AccountBalance in sync with posted journal entries.
 */

const { prisma } = require('../lib/prisma');
const AccountBalance = require('../models/AccountBalance');
const { decimalToNumber } = require('./decimalHelpers');
const { toIdString } = require('./objectId');

function coerceLineAmount(value) {
  return decimalToNumber(value, 0);
}

/**
 * Apply journal line deltas to AccountBalance (direction 1 = post, -1 = undo).
 */
async function applyJournalLinesToAccountBalances(companyId, lines = [], direction = 1) {
  const cid = toIdString(companyId);
  if (!cid || !Array.isArray(lines)) return;

  for (const line of lines) {
    const code = line.accountCode;
    if (!code) continue;
    const debit = coerceLineAmount(line.debit) * direction;
    const credit = coerceLineAmount(line.credit) * direction;
    if (!debit && !credit) continue;
    await AccountBalance.adjust(cid, code, debit, credit);
  }
}

/**
 * Rebuild AccountBalance rows from posted, non-reversed journal entries.
 */
async function rebuildAccountBalancesFromJournal(companyId) {
  const cid = toIdString(companyId);
  if (!cid) throw new Error('companyId is required');

  await prisma.accountBalance.deleteMany({ where: { companyId: cid } });

  const entries = await prisma.journalEntry.findMany({
    where: {
      companyId: cid,
      status: 'posted',
      NOT: { reversed: true },
    },
    include: { lines: { orderBy: { lineOrder: 'asc' } } },
    orderBy: [{ date: 'asc' }, { entryNumber: 'asc' }],
  });

  for (const entry of entries) {
    await applyJournalLinesToAccountBalances(cid, entry.lines || [], 1);
  }

  const count = await prisma.accountBalance.count({ where: { companyId: cid } });
  return { companyId: cid, journalEntries: entries.length, accountBalanceRows: count };
}

module.exports = {
  applyJournalLinesToAccountBalances,
  rebuildAccountBalancesFromJournal,
};
