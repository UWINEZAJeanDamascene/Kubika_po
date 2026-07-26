/**
 * MongoDB aggregation helpers — maxTimeMS from QUERY_TIMEOUT_MS (and dashboard defaults).
 */

const { isMongoConnected } = require('./mongoConnection');

/**
 * @param {'report'|'dashboard'} kind — report/financial: default 10000ms; dashboards: default 5000ms
 * @returns {number}
 */
function getMaxTimeMS(kind = 'report') {
  const raw = process.env.QUERY_TIMEOUT_MS;
  if (raw !== undefined && raw !== '') {
    const v = parseInt(raw, 10);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return kind === 'dashboard' ? 5000 : 10000;
}

function isThenable(value) {
  return value != null && typeof value.then === 'function';
}

/**
 * Run aggregate on a model, returning [] when Mongo is unavailable for dashboard queries.
 * Prisma shims expose aggregate() as an async function and bypass Mongo connection checks.
 *
 * @param {import('mongoose').Model} model
 * @param {object[]} pipeline
 * @param {'report'|'dashboard'} kind
 * @returns {Promise<object[]>}
 */
async function aggregateWithTimeout(model, pipeline, kind = 'report') {
  const maxTimeMS = getMaxTimeMS(kind);
  const empty = kind === 'dashboard' ? [] : null;

  if (typeof model?.aggregate !== 'function') {
    return empty ?? [];
  }

  let result;
  try {
    result = model.aggregate(pipeline, { maxTimeMS });
  } catch (err) {
    if (kind === 'dashboard') return [];
    throw err;
  }

  if (isThenable(result)) {
    try {
      return await result;
    } catch (err) {
      if (kind === 'dashboard') return [];
      throw err;
    }
  }

  if (!isMongoConnected()) {
    return empty ?? [];
  }

  if (result && typeof result.option === 'function') {
    return result.option({ maxTimeMS }).exec();
  }
  if (result && typeof result.exec === 'function') {
    return result.exec();
  }
  return result;
}

/**
 * Safe aggregate for legacy Mongoose models when Mongo may be offline (Postgres-only deploy).
 * @param {import('mongoose').Model} model
 * @param {object[]} pipeline
 * @param {object[]} [fallback=[]]
 * @returns {Promise<object[]>}
 */
async function safeAggregate(model, pipeline, fallback = []) {
  if (typeof model?.aggregate !== 'function') return fallback;
  try {
    const result = model.aggregate(pipeline);
    if (isThenable(result)) return await result;
    if (!isMongoConnected()) return fallback;
    if (result && typeof result.exec === 'function') return await result.exec();
    return result ?? fallback;
  } catch (_err) {
    return fallback;
  }
}

module.exports = {
  getMaxTimeMS,
  aggregateWithTimeout,
  safeAggregate,
};
