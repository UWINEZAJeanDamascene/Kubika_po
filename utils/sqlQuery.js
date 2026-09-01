/**
 * PostgreSQL raw-query helpers — the SQL counterpart of utils/mongoAggregation.js.
 *
 * As domains migrate off MongoDB, aggregation pipelines become SQL (CTEs,
 * GROUP BY, window functions). Use these helpers instead of calling
 * prisma.$queryRawUnsafe directly so every raw query gets a statement timeout,
 * mirroring the maxTimeMS discipline the Mongo wrapper enforces.
 *
 * Timeout resolution matches getMaxTimeMS(): QUERY_TIMEOUT_MS env override,
 * otherwise 5000ms for dashboards and 10000ms for reports/financials.
 */

const { prisma } = require('../lib/prisma');
const { getMaxTimeMS } = require('./mongoAggregation');
const { getActiveTx } = require('../lib/txContext');

/**
 * Run `fn` against a transaction client carrying a LOCAL statement timeout.
 *
 * Inside runInTransaction the ambient client is reused: opening a nested
 * prisma.$transaction there would take a second pool connection for a query
 * that must see the outer transaction's uncommitted writes, and would not see
 * them. Outside a transaction a short one is opened, as before — SET LOCAL only
 * has effect within a transaction.
 */
function withTimeoutTx(timeoutMs, fn) {
  // timeoutMs comes from getMaxTimeMS (parseInt-validated) — safe to inline.
  const ms = Math.floor(timeoutMs);
  const active = getActiveTx();

  if (!active) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${ms}`);
      return fn(tx);
    });
  }

  // SET LOCAL is scoped to the whole transaction, not to the next statement, so
  // inside a caller's transaction it must be restored — otherwise a 5s report
  // timeout would silently apply to every write that follows in that block.
  return (async () => {
    const [{ statement_timeout: previous } = {}] = await active.$queryRawUnsafe(
      'SHOW statement_timeout',
    );
    await active.$executeRawUnsafe(`SET LOCAL statement_timeout = ${ms}`);
    try {
      return await fn(active);
    } finally {
      try {
        await active.$executeRawUnsafe(
          `SET LOCAL statement_timeout = '${String(previous || '0').replace(/'/g, "''")}'`,
        );
      } catch (_err) {
        // The query failing aborts the transaction, so the restore cannot run.
        // Swallow it: rethrowing here would mask the error the caller needs.
      }
    }
  })();
}

/**
 * Run a parameterized raw SQL query inside a transaction with a LOCAL
 * statement timeout. Placeholders use Postgres positional syntax ($1, $2...).
 *
 * @param {string} sql
 * @param {unknown[]} [params]
 * @param {'report'|'dashboard'} [kind]
 * @returns {Promise<unknown[]>} rows
 */
async function queryWithTimeout(sql, params = [], kind = 'report') {
  return withTimeoutTx(getMaxTimeMS(kind), (tx) => tx.$queryRawUnsafe(sql, ...params));
}

/**
 * Same as queryWithTimeout for statements that return no rows
 * (INSERT/UPDATE/DELETE/DDL). Returns the affected row count.
 *
 * @param {string} sql
 * @param {unknown[]} [params]
 * @param {'report'|'dashboard'} [kind]
 * @returns {Promise<number>}
 */
async function executeWithTimeout(sql, params = [], kind = 'report') {
  return withTimeoutTx(getMaxTimeMS(kind), (tx) => tx.$executeRawUnsafe(sql, ...params));
}

module.exports = { queryWithTimeout, executeWithTimeout };
