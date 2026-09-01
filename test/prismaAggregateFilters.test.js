/**
 * utils/prismaAggregate.js — in-memory filter semantics.
 *
 * The shim re-applies the pipeline's `$match` in JavaScript after Postgres has
 * already filtered, "for fields Prisma couldn't express". That re-match used
 * toNumber() to order values, which cannot rank a Date: it falls through to
 * parseFloat(date.toString()) — NaN — and returns 0. With both operands at 0,
 * `$lt`/`$gt` rejected every row and `$gte`/`$lte` accepted every row.
 *
 * Only the strict operators showed symptoms, because the loose ones were
 * accidentally agreeing with the Postgres filter that ran before them. Any
 * aggregate with a strict date bound silently returned nothing — the monthly
 * cash-flow statement's "beginning cash" among them.
 *
 * These run fully in memory, so they need no database.
 */

const { runPipeline } = require('../utils/prismaAggregate');

const CONFIG = { delegate: () => null, fieldMap: {}, toApi: (r) => r };

/** Run a pipeline over `docs` without touching Postgres. */
function inMemory(pipeline, docs) {
  return runPipeline(pipeline, docs, CONFIG, { inMemory: true });
}

const CUTOFF = new Date('2091-03-01T00:00:00.000Z');
const docs = [
  { _id: 'a', date: new Date('2091-01-15T10:00:00.000Z'), amount: 20 },
  { _id: 'b', date: new Date('2091-03-01T00:00:00.000Z'), amount: 5 },
  { _id: 'c', date: new Date('2091-06-15T10:00:00.000Z'), amount: 7 },
];

const ids = (rows) => rows.map((r) => r._id).sort();

describe('prismaAggregate — date ordering in $match', () => {
  test('$lt on a Date keeps only earlier rows', async () => {
    expect(ids(await inMemory([{ $match: { date: { $lt: CUTOFF } } }], docs))).toEqual(['a']);
  });

  test('$lte on a Date includes the boundary row', async () => {
    expect(ids(await inMemory([{ $match: { date: { $lte: CUTOFF } } }], docs))).toEqual(['a', 'b']);
  });

  test('$gt on a Date keeps only later rows', async () => {
    expect(ids(await inMemory([{ $match: { date: { $gt: CUTOFF } } }], docs))).toEqual(['c']);
  });

  test('$gte on a Date includes the boundary row', async () => {
    expect(ids(await inMemory([{ $match: { date: { $gte: CUTOFF } } }], docs))).toEqual(['b', 'c']);
  });

  test('a date range keeps only the rows inside it', async () => {
    const rows = await inMemory(
      [{ $match: { date: { $gte: new Date('2091-02-01'), $lte: new Date('2091-04-01') } } }],
      docs,
    );
    expect(ids(rows)).toEqual(['b']);
  });

  test('ISO date strings order chronologically, not by parseFloat', async () => {
    // parseFloat('2091-01-15…') is 2091 for every row in the year, so string
    // dates collapsed to one value and ranged badly against a Date operand.
    const stringDocs = docs.map((d) => ({ ...d, date: d.date.toISOString() }));
    expect(ids(await inMemory([{ $match: { date: { $lt: CUTOFF } } }], stringDocs))).toEqual(['a']);
  });

  test('numeric comparisons are unchanged', async () => {
    expect(ids(await inMemory([{ $match: { amount: { $gt: 6 } } }], docs))).toEqual(['a', 'c']);
    expect(ids(await inMemory([{ $match: { amount: { $lte: 5 } } }], docs))).toEqual(['b']);
  });

  test('numeric strings still compare as numbers', async () => {
    const priced = [{ _id: 'x', total: '9.50' }, { _id: 'y', total: '100.00' }];
    expect(ids(await inMemory([{ $match: { total: { $gt: 10 } } }], priced))).toEqual(['y']);
  });

  test('$expr comparisons rank dates too', async () => {
    const rows = await inMemory(
      [{ $match: { $expr: { $lt: ['$date', CUTOFF] } } }],
      docs,
    );
    expect(ids(rows)).toEqual(['a']);
  });
});
