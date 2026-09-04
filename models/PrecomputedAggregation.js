'use strict';

const { buildGlobalModel } = require('../utils/masterDataCommon');
const { generateObjectId, toIdString } = require('../utils/objectId');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  company: { target: 'company' },
  asOfDate: { target: 'asOfDate' },
  computedAt: { target: 'computedAt' },
  computationTimeMs: { target: 'computationTimeMs' },
  errorMessage: { target: 'errorMessage' },
};

function toApi(row) {
  if (!row) return null;
  return { ...row, _id: row.id, id: undefined };
}

function translateCreate(data = {}) {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    company: toIdString(data.company),
    type: data.type,
    period: data.period,
    asOfDate: data.asOfDate || new Date(),
    data: data.data,
    computedAt: data.computedAt || new Date(),
    computationTimeMs: data.computationTimeMs ?? null,
    status: data.status || 'success',
    errorMessage: data.errorMessage || null,
  };
}

function translateUpdate(update = {}) {
  const source = update.$set ? { ...update, ...update.$set } : { ...update };
  delete source.$set;
  delete source.$unset;
  const result = {};
  for (const field of ['company', 'type', 'period', 'asOfDate', 'data', 'computedAt', 'computationTimeMs', 'status', 'errorMessage']) {
    if (source[field] !== undefined) result[field] = field === 'company' ? toIdString(source[field]) : source[field];
  }
  return result;
}

const PrecomputedAggregation = buildGlobalModel({
  name: 'PrecomputedAggregation',
  collection: 'precomputed_aggregations',
  delegateName: 'precomputedAggregation',
  fieldMap: FIELD_MAP,
  toApi,
  translateCreate,
  translateUpdate,
  mutable: true,
});

PrecomputedAggregation.getLatest = async function getLatest(companyId, type, period = 'latest') {
  const query = { company: companyId, type, status: 'success' };
  if (period !== 'latest') query.period = period;
  return PrecomputedAggregation.findOne(query).sort({ asOfDate: -1 });
};

PrecomputedAggregation.store = async function store(companyId, type, period, data, computationTimeMs) {
  return PrecomputedAggregation.findOneAndUpdate(
    { company: companyId, type, period },
    { $set: { company: companyId, type, period, asOfDate: new Date(), data, computedAt: new Date(), computationTimeMs, status: 'success' } },
    { upsert: true, new: true },
  );
};

PrecomputedAggregation.getBalanceSheet = async function getBalanceSheet(companyId, options = {}) {
  const { useCache = true, cacheAge = 15 } = options;
  if (useCache) {
    const cached = await PrecomputedAggregation.getLatest(companyId, 'balance-sheet');
    if (cached) {
      const age = (Date.now() - new Date(cached.computedAt).getTime()) / (1000 * 60);
      if (age < cacheAge) return { data: cached.data, fromCache: true, computedAt: cached.computedAt };
    }
  }
  return { fromCache: false };
};

PrecomputedAggregation.cleanOld = async function cleanOld(companyId, olderThanDays = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);
  return PrecomputedAggregation.deleteMany({ company: companyId, computedAt: { $lt: cutoff } });
};

module.exports = PrecomputedAggregation;
