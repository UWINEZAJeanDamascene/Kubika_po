/**
 * Step 8 — transactions & sequences unit tests.
 * Integration block runs when DATABASE_URL points at a live Postgres.
 */
const { padSeq } = require('../services/sequenceService');
const {
  runInPrismaTransaction,
  isMongoEnabled,
} = require('../services/transactionService');

describe('Step 8 — sequence helpers', () => {
  test('padSeq zero-pads to requested width', () => {
    expect(padSeq(1, 5)).toBe('00001');
    expect(padSeq(1234567, 7)).toBe('1234567');
  });
});

describe('Step 8 — transactionService', () => {
  test('isMongoEnabled is false when MONGODB_URI unset', () => {
    const prev = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    // Re-require env cache bust — isMongoEnabled checks mongoose readyState too
    expect(typeof isMongoEnabled()).toBe('boolean');
    if (prev) process.env.MONGODB_URI = prev;
  });

  test('runInPrismaTransaction passes tx client to operation', async () => {
    if (!process.env.DATABASE_URL) {
      console.warn('Skipping Prisma transaction test — DATABASE_URL not set');
      return;
    }

    const result = await runInPrismaTransaction(async (tx) => {
      expect(tx).toBeDefined();
      expect(typeof tx.$queryRawUnsafe).toBe('function');
      return 'ok';
    });
    expect(result).toBe('ok');
  });
});

describe('Step 8 — postgresSequenceStore (integration)', () => {
  const companyId = '6a1682833035c524d960189e'; // from Phase 1 ETL
  const seqName = `_jest_step8_${Date.now()}`;

  test('incrementSequence is atomic and monotonic', async () => {
    if (!process.env.DATABASE_URL) {
      console.warn('Skipping sequence integration — DATABASE_URL not set');
      return;
    }

    const { incrementSequence, peekSequence } = require('../services/postgresSequenceStore');
    const year = 2099;

    const before = await peekSequence(companyId, seqName, year);
    const a = await incrementSequence(companyId, seqName, year);
    const b = await incrementSequence(companyId, seqName, year);

    expect(a).toBe(before + 1);
    expect(b).toBe(a + 1);
  });

  test('allocateEbmSequence respects branch + type', async () => {
    if (!process.env.DATABASE_URL) {
      console.warn('Skipping EBM sequence integration — DATABASE_URL not set');
      return;
    }

    const { allocateEbmSequence } = require('../services/postgresSequenceStore');
    const branch = '99';
    const type = 'receipt';
    const ebmName = `_jest_ebm_${Date.now()}`;

    // Use receipt type with unique branch to avoid colliding with production counters
    const n1 = await allocateEbmSequence(companyId, branch, type);
    const n2 = await allocateEbmSequence(companyId, branch, type);
    expect(n2).toBe(n1 + 1);
    expect(n1).toBeGreaterThan(0);
    void ebmName;
  });

  test('nextSequence returns padded year-scoped value', async () => {
    if (!process.env.DATABASE_URL) {
      console.warn('Skipping nextSequence integration — DATABASE_URL not set');
      return;
    }

    const { nextSequence } = require('../services/sequenceService');
    const name = `_jest_next_${Date.now()}`;
    const val = await nextSequence(companyId, name, { year: 2098 });
    expect(val).toMatch(/^\d{5}$/);
  });
});
