/**
 * Gap 4 step 3 — parity between the JS aggregation shim and the SQL rewrite.
 *
 * POSTGRES_MIGRATION_COMPLETION.md §10 is explicit that row counts are not a
 * sufficient check and that "financial totals reconciliation ... is the check
 * that actually proves the migration". The same applies to moving a pipeline
 * out of Node and into SQL: the risk is not that it breaks loudly, it is that
 * it returns a slightly different number on a balance sheet.
 *
 * So every shape used by a converted call site is asserted here against the
 * pipeline it replaces, over a seeded ledger that deliberately contains the
 * rows the filters are supposed to include and exclude: draft, voided and
 * reversed entries, entries either side of the period boundary, and several
 * account codes.
 *
 * Needs DATABASE_URL. Seeds into a throwaway company and deletes it afterwards.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const hasDb = Boolean(process.env.DATABASE_URL);

const { prisma } = require('../lib/prisma');
const tenantContext = require('../lib/tenantContext');
const { generateObjectId } = require('../utils/objectId');
const { sumJournalLines } = require('../services/journalAggregationService');
const JournalEntry = require('../models/JournalEntry');

const ACCOUNT_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const IN_PERIOD_START = new Date('2091-03-01T00:00:00.000Z');
const IN_PERIOD_END = new Date('2091-03-31T23:59:59.999Z');

let companyId;
let authorId;
let seeded = false;

/** One entry plus its lines, written straight to the tables both paths read. */
async function seedEntry({ entryNumber, date, status, reversed, sourceType = null, lines }) {
  const id = generateObjectId();
  await prisma.journalEntry.create({
    data: {
      id,
      companyId,
      entryNumber,
      date,
      description: `parity ${entryNumber}`,
      status,
      reversed,
      sourceType,
      createdById: authorId,
      totalDebit: lines.reduce((s, l) => s + l.debit, 0),
      totalCredit: lines.reduce((s, l) => s + l.credit, 0),
      updatedAt: new Date(),
    },
  });
  await prisma.journalEntryLine.createMany({
    data: lines.map((l, i) => ({
      id: generateObjectId(),
      companyId,
      journalEntryId: id,
      lineOrder: i,
      accountCode: l.accountCode,
      accountName: l.accountName || `Account ${l.accountCode}`,
      accountId: l.accountId || null,
      debit: l.debit,
      credit: l.credit,
    })),
  });
}

beforeAll(async () => {
  if (!hasDb) return;

  // journal_entries.created_by is NOT NULL; any existing user satisfies the FK.
  const author = await prisma.user.findFirst({ select: { id: true } });
  if (!author) return;
  authorId = author.id;

  companyId = generateObjectId();
  await prisma.company.create({
    data: {
      id: companyId,
      name: `_jest_parity_${Date.now()}`,
      code: `PAR${String(Date.now()).slice(-8)}`,
      email: `parity_${Date.now()}@example.test`,
      updatedAt: new Date(),
    },
  });

  await seedEntry({
    entryNumber: 'P-IN-1', date: new Date('2091-03-05T10:00:00.000Z'),
    status: 'posted', reversed: false, sourceType: 'invoice',
    lines: [
      { accountCode: '1010', debit: 100.25, credit: 0, accountId: ACCOUNT_A },
      { accountCode: '4000', debit: 0, credit: 100.25 },
    ],
  });
  await seedEntry({
    entryNumber: 'P-IN-2', date: new Date('2091-03-20T10:00:00.000Z'),
    status: 'posted', reversed: false, sourceType: 'payment',
    lines: [
      { accountCode: '1110', debit: 50.5, credit: 0 },
      { accountCode: '1010', debit: 7.75, credit: 0, accountId: ACCOUNT_A },
      { accountCode: '5000', debit: 0, credit: 58.25 },
    ],
  });
  // Reversed but still posted: sumLinesByAccountCode would drop this, the JS
  // pipelines did not. The excludeReversed option has to be able to do both.
  await seedEntry({
    entryNumber: 'P-IN-REV', date: new Date('2091-03-22T10:00:00.000Z'),
    status: 'posted', reversed: true,
    lines: [{ accountCode: '1010', debit: 11.11, credit: 0 }],
  });
  await seedEntry({
    entryNumber: 'P-IN-DRAFT', date: new Date('2091-03-23T10:00:00.000Z'),
    status: 'draft', reversed: false,
    lines: [{ accountCode: '1010', debit: 999.99, credit: 0 }],
  });
  await seedEntry({
    entryNumber: 'P-IN-VOID', date: new Date('2091-03-24T10:00:00.000Z'),
    status: 'voided', reversed: false,
    lines: [{ accountCode: '4000', debit: 0, credit: 777.77 }],
  });
  // Before the period: only the "prior activity" shapes should see it.
  await seedEntry({
    entryNumber: 'P-PRIOR', date: new Date('2091-01-15T10:00:00.000Z'),
    status: 'posted', reversed: false,
    lines: [
      { accountCode: '1010', debit: 20, credit: 5 },
      { accountCode: '4000', debit: 0, credit: 15 },
    ],
  });
  // After the period.
  await seedEntry({
    entryNumber: 'P-AFTER', date: new Date('2091-06-15T10:00:00.000Z'),
    status: 'posted', reversed: false,
    lines: [{ accountCode: '1010', debit: 33, credit: 0 }],
  });

  seeded = true;
});

afterAll(async () => {
  if (!hasDb || !companyId) return;
  // Lines and entries cascade from the company.
  await prisma.company.deleteMany({ where: { id: companyId } });
});

/** Both paths, normalized to a comparable {code -> {debit, credit}} map. */
function normalize(rows, key = 'accountCode') {
  const out = {};
  for (const r of rows || []) {
    const code = String((key === '_id' ? r._id : r[key]) ?? 'TOTAL').trim() || 'TOTAL';
    out[code] = {
      debit: Number(Number(r.debit).toFixed(2)),
      credit: Number(Number(r.credit).toFixed(2)),
    };
  }
  return out;
}

function runShim(pipeline) {
  return tenantContext.run({ companyId }, () => JournalEntry.aggregate(pipeline));
}

function guard() {
  if (!hasDb) {
    console.warn('Skipping journal aggregation parity — DATABASE_URL not set');
    return true;
  }
  if (!seeded) throw new Error('parity fixture failed to seed');
  return false;
}

describe('Gap 4 — sumJournalLines matches the pipeline it replaces', () => {
  test('group by account code over a period, posted only', async () => {
    if (guard()) return;

    const shim = await runShim([
      { $match: { company: companyId, date: { $gte: IN_PERIOD_START, $lte: IN_PERIOD_END }, status: 'posted' } },
      { $unwind: '$lines' },
      { $group: { _id: '$lines.accountCode', debit: { $sum: { $toDouble: '$lines.debit' } }, credit: { $sum: { $toDouble: '$lines.credit' } } } },
    ]);

    const sql = await sumJournalLines(companyId, {
      dateFrom: IN_PERIOD_START, dateTo: IN_PERIOD_END, status: 'posted',
    });

    expect(normalize(sql)).toEqual(normalize(shim, '_id'));
    // Guard against both sides being empty and the test proving nothing.
    expect(Object.keys(normalize(sql)).length).toBeGreaterThan(0);
    // The reversed entry is included, as the JS pipeline included it.
    expect(normalize(sql)['1010'].debit).toBeCloseTo(100.25 + 7.75 + 11.11, 2);
  });

  test('excludeReversed drops reversed entries and nothing else', async () => {
    if (guard()) return;

    const withReversed = await sumJournalLines(companyId, {
      dateFrom: IN_PERIOD_START, dateTo: IN_PERIOD_END, status: 'posted',
    });
    const withoutReversed = await sumJournalLines(companyId, {
      dateFrom: IN_PERIOD_START, dateTo: IN_PERIOD_END, status: 'posted', excludeReversed: true,
    });

    expect(normalize(withReversed)['1010'].debit).toBeCloseTo(119.11, 2);
    expect(normalize(withoutReversed)['1010'].debit).toBeCloseTo(108.0, 2);
    expect(normalize(withoutReversed)['4000']).toEqual(normalize(withReversed)['4000']);
  });

  test('exclusive lower bound + code prefixes (prior cash activity)', async () => {
    if (guard()) return;

    const shim = await runShim([
      { $match: { company: companyId, date: { $lt: IN_PERIOD_START }, status: 'posted' } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountCode': { $regex: '^10|^11' } } },
      { $group: { _id: null, debit: { $sum: { $toDouble: '$lines.debit' } }, credit: { $sum: { $toDouble: '$lines.credit' } } } },
    ]);

    const sql = await sumJournalLines(companyId, {
      dateTo: IN_PERIOD_START, dateToInclusive: false, status: 'posted',
      accountCodePrefixes: ['10', '11'], groupByAccountCode: false,
    });

    expect(normalize(sql)).toEqual(normalize(shim, '_id'));
    expect(sql[0].debit).toBeCloseTo(20, 2);
    expect(sql[0].credit).toBeCloseTo(5, 2);
  });

  test('single account code with a line count', async () => {
    if (guard()) return;

    const shim = await runShim([
      { $match: { company: companyId, date: { $gte: IN_PERIOD_START, $lte: IN_PERIOD_END }, status: 'posted' } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountCode': '1010' } },
      { $group: { _id: null, debit: { $sum: { $toDouble: '$lines.debit' } }, credit: { $sum: { $toDouble: '$lines.credit' } }, count: { $sum: 1 } } },
    ]);

    const sql = await sumJournalLines(companyId, {
      dateFrom: IN_PERIOD_START, dateTo: IN_PERIOD_END, status: 'posted',
      accountCodes: ['1010'], groupByAccountCode: false, withCount: true,
    });

    expect(normalize(sql)).toEqual(normalize(shim, '_id'));
    // $sum: 1 ran after $unwind, so it counted lines rather than entries.
    expect(sql[0].count).toBe(shim[0].count);
    expect(sql[0].count).toBe(3);
  });

  test('cumulative balance as of a date, codes filtered by $in', async () => {
    if (guard()) return;

    const codes = ['1010', '4000'];
    const shim = await runShim([
      { $match: { company: companyId, date: { $lte: IN_PERIOD_END }, status: 'posted' } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountCode': { $in: codes } } },
      { $group: { _id: '$lines.accountCode', debit: { $sum: { $toDouble: '$lines.debit' } }, credit: { $sum: { $toDouble: '$lines.credit' } } } },
    ]);

    const sql = await sumJournalLines(companyId, {
      dateTo: IN_PERIOD_END, status: 'posted', accountCodes: codes,
    });

    expect(normalize(sql)).toEqual(normalize(shim, '_id'));
    // Includes P-PRIOR, excludes P-AFTER.
    expect(normalize(sql)['1010'].debit).toBeCloseTo(100.25 + 7.75 + 11.11 + 20, 2);
  });

  test('no status filter includes draft and voided, as that pipeline did', async () => {
    if (guard()) return;

    const shim = await runShim([
      { $match: { company: companyId, date: { $gte: IN_PERIOD_START, $lte: IN_PERIOD_END } } },
      { $unwind: '$lines' },
      { $group: { _id: '$lines.accountCode', debit: { $sum: { $toDouble: '$lines.debit' } }, credit: { $sum: { $toDouble: '$lines.credit' } } } },
    ]);

    const sql = await sumJournalLines(companyId, {
      dateFrom: IN_PERIOD_START, dateTo: IN_PERIOD_END,
    });

    expect(normalize(sql)).toEqual(normalize(shim, '_id'));
    expect(normalize(sql)['1010'].debit).toBeCloseTo(119.11 + 999.99, 2);
    expect(normalize(sql)['4000'].credit).toBeCloseTo(100.25 + 777.77, 2);
  });

  test('an empty code list matches nothing rather than everything', async () => {
    if (guard()) return;
    expect(await sumJournalLines(companyId, { accountCodes: [] })).toEqual([]);
    expect(await sumJournalLines(companyId, { accountCodePrefixes: [] })).toEqual([]);
  });

  test('a grand total over no matching rows is empty, not a zero row', async () => {
    if (guard()) return;

    const shim = await runShim([
      { $match: { company: companyId, date: { $gte: new Date('2099-01-01'), $lte: new Date('2099-12-31') } } },
      { $unwind: '$lines' },
      { $group: { _id: null, debit: { $sum: { $toDouble: '$lines.debit' } }, credit: { $sum: { $toDouble: '$lines.credit' } } } },
    ]);

    const sql = await sumJournalLines(companyId, {
      dateFrom: new Date('2099-01-01'), dateTo: new Date('2099-12-31'), groupByAccountCode: false,
    });

    // Callers do `rows[0]?.debit - rows[0]?.credit || 0`; a zero row would be
    // harmless there but `rows.length` checks elsewhere would flip meaning.
    expect(sql).toEqual([]);
    expect(shim.length).toBe(0);
  });
});
