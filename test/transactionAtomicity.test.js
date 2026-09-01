/**
 * Critical Gap 1 — transaction atomicity.
 *
 * POSTGRES_MIGRATION_COMPLETION.md §3 step 3: "verify atomicity with a failure
 * test per domain: force an error after the stock write but before the journal
 * write, and assert nothing was persisted."
 *
 * Two layers, because each catches a different class of regression:
 *
 *   1. Wiring (no database). Proves runInTransaction actually opens a Prisma
 *      transaction by default rather than falling through to `operation(null)`,
 *      that nested calls join the outer transaction instead of deadlocking,
 *      and that the compat layer / aggregate shim / raw-SQL helper all resolve
 *      the ambient transaction client. A regression in any of these produces a
 *      transaction that is opened and then silently bypassed by its own body —
 *      which looks correct and is not.
 *
 *   2. Rollback (needs DATABASE_URL). Proves the real thing end to end: a
 *      multi-row write that throws partway leaves nothing behind.
 *
 * Layer 2 skips when DATABASE_URL is unset, matching the other phase tests.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

describe('Gap 1 wiring — runInTransaction defaults to Postgres', () => {
  let calls;

  /**
   * Minimal stand-in for the Prisma client: $transaction hands the callback a
   * tx client and rejects (i.e. rolls back) if the callback throws.
   */
  function fakePrisma() {
    const tx = {
      __isTx: true,
      // Real Prisma delegates do not expose a model `.name`; the explicit
      // delegateName supplied by the compat model must select this delegate.
      stockMovement: { __onTx: true },
      $queryRawUnsafe: jest.fn(async (sql) =>
        /statement_timeout/i.test(sql) ? [{ statement_timeout: '30s' }] : [],
      ),
      $executeRawUnsafe: jest.fn(async () => 0),
    };
    return {
      tx,
      client: {
        stockMovement: { __onTx: false },
        $transaction: jest.fn(async (fn) => {
          calls.transactions += 1;
          return fn(tx);
        }),
      },
    };
  }

  let fake;

  beforeEach(() => {
    jest.resetModules();
    calls = { transactions: 0 };
    fake = fakePrisma();
    jest.doMock('../lib/prisma', () => ({ prisma: fake.client }));
  });

  afterEach(() => {
    jest.dontMock('../lib/prisma');
  });

  test('no options: opens a Prisma transaction and passes the tx client', async () => {
    const { runInTransaction } = require('../services/transactionService');

    const handle = await runInTransaction(async (tx) => tx);

    // The pre-fix behaviour was `return operation(null)` whenever Mongo was
    // disabled. A null handle here means every multi-step write is uncommitted
    // -per-statement again.
    expect(handle).not.toBeNull();
    expect(handle.__isTx).toBe(true);
    expect(calls.transactions).toBe(1);
  });

  test('a throw inside propagates and does not swallow the rollback', async () => {
    const { runInTransaction } = require('../services/transactionService');

    await expect(
      runInTransaction(async () => {
        throw new Error('boom after first write');
      }),
    ).rejects.toThrow('boom after first write');

    expect(calls.transactions).toBe(1);
  });

  test('nested runInTransaction joins the outer transaction', async () => {
    const { runInTransaction } = require('../services/transactionService');

    const { outer, inner } = await runInTransaction(async (outerTx) => {
      const innerTx = await runInTransaction(async (tx) => tx);
      return { outer: outerTx, inner: innerTx };
    });

    // Prisma cannot nest interactive transactions; the inner call must reuse
    // the outer client, not open a second one against the pool.
    expect(inner).toBe(outer);
    expect(calls.transactions).toBe(1);
  });

  test("backend: 'mongo' still bypasses Postgres when Mongo is disabled", async () => {
    const { runInTransaction } = require('../services/transactionService');

    const handle = await runInTransaction(async (session) => session, { backend: 'mongo' });

    expect(handle).toBeNull();
    expect(calls.transactions).toBe(0);
  });

  test('the tx client is published on the async context for the whole callback', async () => {
    const { runInTransaction } = require('../services/transactionService');
    const { getActiveTx } = require('../lib/txContext');

    expect(getActiveTx()).toBeNull();

    const seen = await runInTransaction(async () => {
      // Deliberately read the ambient client rather than the handle: this is
      // how every compat model resolves its delegate.
      await Promise.resolve();
      return getActiveTx();
    });

    expect(seen).toBe(fake.tx);
    expect(getActiveTx()).toBeNull();
  });
});

describe('Gap 1 wiring — writes resolve the ambient transaction client', () => {
  let fake;
  let calls;

  beforeEach(() => {
    jest.resetModules();
    calls = { transactions: 0 };
    const tx = {
      __isTx: true,
      stockMovement: { __onTx: true },
      $queryRawUnsafe: jest.fn(async (sql) =>
        /statement_timeout/i.test(sql) ? [{ statement_timeout: '30s' }] : [{ ok: true }],
      ),
      $executeRawUnsafe: jest.fn(async () => 0),
    };
    fake = {
      tx,
      client: {
        stockMovement: { __onTx: false },
        $transaction: jest.fn(async (fn) => {
          calls.transactions += 1;
          return fn(tx);
        }),
      },
    };
    jest.doMock('../lib/prisma', () => ({ prisma: fake.client }));
  });

  afterEach(() => {
    jest.dontMock('../lib/prisma');
  });

  test('txDelegate returns the transaction-bound delegate inside a transaction', async () => {
    const { runInTransaction } = require('../services/transactionService');
    const { txDelegate } = require('../utils/prismaCompat');

    const config = {
      delegate: () => fake.client.stockMovement,
      delegateName: 'stockMovement',
    };

    expect(txDelegate(config).__onTx).toBe(false);

    const inside = await runInTransaction(async () => txDelegate(config));
    expect(inside.__onTx).toBe(true);
  });

  test('queryWithTimeout reuses the ambient transaction instead of nesting one', async () => {
    const { runInTransaction } = require('../services/transactionService');
    const { queryWithTimeout } = require('../utils/sqlQuery');

    await runInTransaction(async () => {
      await queryWithTimeout('SELECT 1', []);
    });

    // One transaction total: the caller's. A nested prisma.$transaction here
    // would take a second pool connection and could not see the outer
    // transaction's uncommitted writes.
    expect(calls.transactions).toBe(1);
    expect(fake.tx.$queryRawUnsafe).toHaveBeenCalledWith('SELECT 1');
  });

  test('queryWithTimeout restores the caller statement_timeout it overrode', async () => {
    const { runInTransaction } = require('../services/transactionService');
    const { queryWithTimeout } = require('../utils/sqlQuery');

    await runInTransaction(async () => {
      await queryWithTimeout('SELECT 1', []);
    });

    const statements = fake.tx.$executeRawUnsafe.mock.calls.map(([sql]) => sql);
    // SET LOCAL is transaction-scoped, so a report timeout left in place would
    // silently apply to every write that follows in the caller's block.
    expect(statements.some((s) => /SET LOCAL statement_timeout = \d+/.test(s))).toBe(true);
    expect(statements[statements.length - 1]).toMatch(/SET LOCAL statement_timeout = '30s'/);
  });

  test('queryWithTimeout opens its own transaction when there is no ambient one', async () => {
    const { queryWithTimeout } = require('../utils/sqlQuery');

    await queryWithTimeout('SELECT 1', []);

    expect(calls.transactions).toBe(1);
  });
});

describe('Gap 1 rollback — multi-row writes are all-or-nothing (integration)', () => {
  const hasDb = Boolean(process.env.DATABASE_URL);
  const marker = `_jest_atomicity_${Date.now()}`;

  let prisma;
  let tenantContext;
  let runInTransaction;
  let StockMovement;
  let companyId;

  beforeAll(async () => {
    if (!hasDb) return;
    ({ prisma } = require('../lib/prisma'));
    tenantContext = require('../lib/tenantContext');
    ({ runInTransaction } = require('../services/transactionService'));
    StockMovement = require('../models/StockMovement');

    const company = await prisma.company.findFirst({ select: { id: true } });
    companyId = company && company.id;
  });

  afterAll(async () => {
    if (!hasDb || !companyId) return;
    // Belt and braces: a failed assertion must not leave test rows behind.
    await prisma.stockMovement.deleteMany({
      where: { companyId, referenceNumber: { startsWith: marker } },
    });
  });

  /** Run `fn` with a tenant, the way a request would. */
  function asTenant(fn) {
    return tenantContext.run({ companyId }, fn);
  }

  function movement(ref) {
    return {
      company: companyId,
      type: 'adjustment',
      reason: 'correction',
      quantity: 1,
      referenceType: 'test',
      referenceNumber: ref,
    };
  }

  function skipUnlessSeeded() {
    if (!hasDb) {
      console.warn('Skipping transaction rollback tests — DATABASE_URL not set');
      return true;
    }
    if (!companyId) {
      console.warn('Skipping transaction rollback tests — no company rows in the database');
      return true;
    }
    return false;
  }

  test('a throw after the first write persists neither row', async () => {
    if (skipUnlessSeeded()) return;
    const ref = `${marker}_rollback`;

    await asTenant(async () => {
      await expect(
        runInTransaction(async () => {
          await StockMovement.create(movement(`${ref}_a`));
          // Stand-in for "the journal posting failed after the stock write".
          throw new Error('forced failure between writes');
        }),
      ).rejects.toThrow('forced failure between writes');
    });

    const left = await prisma.stockMovement.count({
      where: { companyId, referenceNumber: { startsWith: ref } },
    });
    expect(left).toBe(0);
  });

  test('the same writes commit together when nothing throws', async () => {
    if (skipUnlessSeeded()) return;
    const ref = `${marker}_commit`;

    // Control case: without this a broken rollback test could pass simply
    // because the writes never happened at all.
    await asTenant(() =>
      runInTransaction(async () => {
        await StockMovement.create(movement(`${ref}_a`));
        await StockMovement.create(movement(`${ref}_b`));
      }),
    );

    const committed = await prisma.stockMovement.count({
      where: { companyId, referenceNumber: { startsWith: ref } },
    });
    expect(committed).toBe(2);

    await prisma.stockMovement.deleteMany({
      where: { companyId, referenceNumber: { startsWith: ref } },
    });
  });

  test('a write made by a nested runInTransaction rolls back with the outer one', async () => {
    if (skipUnlessSeeded()) return;
    const ref = `${marker}_nested`;

    await asTenant(async () => {
      await expect(
        runInTransaction(async () => {
          await StockMovement.create(movement(`${ref}_outer`));
          // e.g. a service that opens its own transaction, called from a
          // controller that already opened one.
          await runInTransaction(async () => {
            await StockMovement.create(movement(`${ref}_inner`));
          });
          throw new Error('forced failure after nested write');
        }),
      ).rejects.toThrow('forced failure after nested write');
    });

    const left = await prisma.stockMovement.count({
      where: { companyId, referenceNumber: { startsWith: ref } },
    });
    expect(left).toBe(0);
  });

  test('a journal entry created inside a failed transaction is rolled back', async () => {
    if (skipUnlessSeeded()) return;
    const JournalEntry = require('../models/JournalEntry');
    const ref = `${marker}_je`;

    const author = await prisma.user.findFirst({ where: { companyId }, select: { id: true } });
    if (!author) {
      console.warn('Skipping journal rollback test — no user rows for this company');
      return;
    }

    // The case POSTGRES_MIGRATION_COMPLETION.md §3 describes: "stock decremented
    // with no journal entry, or an invoice with no GL posting". JournalEntryDoc
    // has its own save() that held the plain client, so the entry it wrote
    // committed immediately and survived the caller's rollback.
    await asTenant(async () => {
      await expect(
        runInTransaction(async () => {
          const entry = new JournalEntry({
            company: companyId,
            entryNumber: ref,
            date: new Date(),
            description: 'atomicity probe',
            status: 'draft',
            createdBy: author.id,
            lines: [],
          });
          await entry.save();
          throw new Error('forced failure after journal write');
        }),
      ).rejects.toThrow('forced failure after journal write');
    });

    const left = await prisma.journalEntry.count({
      where: { companyId, entryNumber: ref },
    });
    expect(left).toBe(0);
  });

  test('Product.customFind sees the transaction its own writes are in', async () => {
    if (skipUnlessSeeded()) return;
    const Product = require('../models/Product');

    const existing = await prisma.product.findFirst({
      where: { companyId },
      select: { id: true, name: true },
    });
    if (!existing) {
      console.warn('Skipping customFind transaction test — no product rows for this company');
      return;
    }
    const renamed = `${marker}_product`;

    await asTenant(async () => {
      await expect(
        runInTransaction(async () => {
          await Product.updateOne({ _id: existing.id, company: companyId }, { $set: { name: renamed } });

          // An $or filter routes through productCustomFind, which issues its
          // own queries rather than going through the compat delegate. If those
          // run on the plain client they read the pre-transaction snapshot and
          // this returns nothing.
          const found = await Product.find({
            company: companyId,
            $or: [{ name: renamed }, { sku: '__no_such_sku__' }],
          });
          expect(found.map((p) => String(p._id))).toContain(existing.id);

          throw new Error('done reading product');
        }),
      ).rejects.toThrow('done reading product');
    });

    const after = await prisma.product.findUnique({
      where: { id: existing.id },
      select: { name: true },
    });
    expect(after.name).toBe(existing.name);
  });

  test('reads inside the transaction see its own uncommitted writes', async () => {
    if (skipUnlessSeeded()) return;
    const ref = `${marker}_readback`;

    await asTenant(async () => {
      await expect(
        runInTransaction(async () => {
          await StockMovement.create(movement(`${ref}_a`));

          // find() goes through the compat delegate...
          const found = await StockMovement.find({
            company: companyId,
            referenceNumber: `${ref}_a`,
          });
          expect(found.length).toBe(1);

          // ...and aggregate() through the pipeline shim, which reads via its
          // own delegate. Both must be bound to the transaction, or a total
          // recomputed mid-transaction silently uses the pre-transaction rows.
          const agg = await StockMovement.aggregate([
            { $match: { company: companyId, referenceNumber: `${ref}_a` } },
            { $group: { _id: null, n: { $sum: 1 } } },
          ]);
          expect(agg[0] && agg[0].n).toBe(1);

          throw new Error('done reading');
        }),
      ).rejects.toThrow('done reading');
    });

    const left = await prisma.stockMovement.count({
      where: { companyId, referenceNumber: { startsWith: ref } },
    });
    expect(left).toBe(0);
  });
});
