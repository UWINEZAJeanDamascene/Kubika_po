const { AsyncLocalStorage } = require('async_hooks');

/**
 * Holds the active Prisma interactive-transaction client for the current async
 * scope.
 *
 * Prisma has no ambient transactions: a write only joins a transaction if it is
 * issued against the `tx` client handed to `$transaction(async (tx) => ...)`.
 * The Mongoose-era call sites in this codebase were written to pass a session
 * around instead, so threading `tx` through every one of them by hand would
 * touch dozens of controllers and services — and any call site missed would
 * silently commit outside the transaction, which is worse than not having one.
 *
 * Storing `tx` here lets the Prisma compat layer resolve the right client on
 * its own (see resolveDelegate in utils/prismaCompat.js), so every model
 * operation performed inside runInPrismaTransaction joins that transaction
 * automatically.
 */
const txContext = new AsyncLocalStorage();

/** The active transaction client, or null when not inside a transaction. */
function getActiveTx() {
  try {
    return txContext.getStore() || null;
  } catch (_) {
    return null;
  }
}

/** Run `fn` with `tx` as the ambient transaction client. */
function runWithTx(tx, fn) {
  return txContext.run(tx, fn);
}

/**
 * Run `fn` with no ambient transaction, e.g. for a write that must survive a
 * rollback (audit logging of a failed attempt).
 */
function runWithoutTx(fn) {
  return txContext.run(null, fn);
}

module.exports = { txContext, getActiveTx, runWithTx, runWithoutTx };
