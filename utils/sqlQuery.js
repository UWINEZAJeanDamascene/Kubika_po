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
  const timeoutMs = getMaxTimeMS(kind);
  return prisma.$transaction(async (tx) => {
    // timeoutMs comes from getMaxTimeMS (parseInt-validated) — safe to inline.
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    return tx.$queryRawUnsafe(sql, ...params);
  });
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
  const timeoutMs = getMaxTimeMS(kind);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    return tx.$executeRawUnsafe(sql, ...params);
  });
}

module.exports = { queryWithTimeout, executeWithTimeout };
