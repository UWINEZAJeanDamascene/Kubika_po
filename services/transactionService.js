const TX_DEFAULTS = { maxWait: 5000, timeout: 30000 };

/**
 * True only when MongoDB is configured and actually connected.
 * This keeps the Postgres default while preserving explicit Mongo opt-ins.
 */
function isMongoEnabled() {
  try {
    const mongoose = require('mongoose');
    if (!process.env.MONGODB_URI || !String(process.env.MONGODB_URI).trim()) return false;
    return mongoose.connection && mongoose.connection.readyState === 1;
  } catch (_) {
    return false;
  }
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
 * Run an operation in a Mongo transaction if Mongo is both configured and live.
 * Otherwise the function intentionally keeps the caller in the Postgres path,
 * which is the migration end-state for this codebase.
 */
async function runInMongoTransaction(operation) {
  return operation(null);
}

/**
 * Run an operation in a database transaction.
 *
 * PostgreSQL is the default, but an explicit Mongo opt-in is still supported
 * when Mongo is enabled and connected.
 *
 * @template T
 * @param {(handle: import('@prisma/client').Prisma.TransactionClient) => Promise<T>} operation
 * @param {{ backend?: 'prisma' | 'mongo', maxWait?: number, timeout?: number }} [options]
 * @returns {Promise<T>}
 */
async function runInTransaction(operation, options = {}) {
  if (options.backend === 'mongo') {
    if (isMongoEnabled()) return runInMongoTransaction(operation, options);
    return operation(null);
  }

  return runInPrismaTransaction(operation, options);
}

module.exports = {
  runInTransaction,
  runInPrismaTransaction,
  runInMongoTransaction,
  isMongoEnabled,
};
