const mongoose = require('mongoose');
const env = require('../src/config/environment');

const TX_DEFAULTS = { maxWait: 5000, timeout: 30000 };

/**
 * True when MongoDB is configured and the driver connection is open.
 */
function isMongoEnabled() {
  const uri = env.getConfig().db.uri;
  return Boolean(uri) && mongoose.connection.readyState === 1;
}

/**
 * Run an operation inside a Prisma interactive transaction (PostgreSQL).
 * Pass the transaction client `tx` to downstream Postgres writes.
 *
 * @template T
 * @param {(tx: import('@prisma/client').Prisma.TransactionClient) => Promise<T>} operation
 * @param {{ maxWait?: number, timeout?: number }} [options]
 * @returns {Promise<T>}
 */
async function runInPrismaTransaction(operation, options = {}) {
  const { prisma } = require('../lib/prisma');
  const { getActiveTx, runWithTx } = require('../lib/txContext');

  // Prisma cannot nest interactive transactions — opening a second one inside
  // the first deadlocks against the pool. Join the existing transaction so an
  // inner runInTransaction() is a no-op wrapper rather than an error.
  const existing = getActiveTx();
  if (existing) return operation(existing);

  return prisma.$transaction(
    // The tx client is published on the async context so every compat-model
    // read/write in this scope resolves to it automatically. Without this the
    // transaction would be opened and then bypassed by its own body.
    async (tx) => runWithTx(tx, () => operation(tx)),
    {
      maxWait: options.maxWait ?? TX_DEFAULTS.maxWait,
      timeout: options.timeout ?? TX_DEFAULTS.timeout,
    },
  );
}

/**
 * Run an operation inside a MongoDB session/transaction when available.
 * Falls back to non-transactional execution when transactions are unsupported
 * (single-node dev) or MongoDB is disabled.
 *
 * @template T
 * @param {(session: import('mongoose').ClientSession | null) => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function runInMongoTransaction(operation) {
  if (!isMongoEnabled()) {
    return operation(null);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async (trx) => {
      result = await operation(trx);
    });
    return result;
  } catch (err) {
    if (err && /Transaction numbers are only allowed/.test(err.message)) {
      console.warn(
        'Mongo transaction unsupported, falling back to non-transactional execution:',
        err.message,
      );
      return operation(null);
    }
    throw err;
  } finally {
    session.endSession();
  }
}

/**
 * Run an operation in a database transaction.
 *
 * - `{ backend: 'prisma' }` — always use PostgreSQL (Step 8 path).
 * - `{ backend: 'mongo' }`   — always use MongoDB session (legacy, opt-in).
 * - default                  — PostgreSQL, the system of record.
 *
 * The handle passed to `operation` is the Prisma transaction client. Call sites
 * do not need to use it directly: compat models resolve the active transaction
 * from the async context, so any Model.find/create/update inside the callback
 * joins it automatically. Nested calls reuse the outer transaction.
 *
 * @template T
 * @param {(handle: import('@prisma/client').Prisma.TransactionClient | import('mongoose').ClientSession | null) => Promise<T>} operation
 * @param {{ backend?: 'prisma' | 'mongo', maxWait?: number, timeout?: number }} [options]
 * @returns {Promise<T>}
 */
async function runInTransaction(operation, options = {}) {
  if (options.backend === 'prisma') {
    return runInPrismaTransaction(operation, options);
  }
  if (options.backend === 'mongo') {
    return runInMongoTransaction(operation);
  }
  // PostgreSQL is the system of record, so it is the default. This previously
  // fell through to `operation(null)` whenever Mongo was disabled, which meant
  // every multi-step write — stock receipt, invoice + journal posting, GRN,
  // transfers — ran with no transaction at all and could half-commit.
  return runInPrismaTransaction(operation, options);
}

module.exports = {
  runInTransaction,
  runInPrismaTransaction,
  runInMongoTransaction,
  isMongoEnabled,
};
