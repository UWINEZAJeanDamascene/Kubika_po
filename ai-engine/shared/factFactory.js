'use strict';

const crypto = require('crypto');
const { AI_DOMAINS, assertValidFactRecord } = require('./interfaces');

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

function buildFactId(parts) {
  return `fact_${stableHash(parts)}`;
}

function sourceIdsFrom(items, fallback) {
  if (!Array.isArray(items)) return fallback ? [String(fallback)] : [];
  const ids = items
    .map((item) => item && (item.id || item._id || item.invoiceNumber || item.purchaseNumber || item.name))
    .filter(Boolean)
    .map(String);
  return ids.length ? ids.slice(0, 50) : (fallback ? [String(fallback)] : []);
}

function createFact({
  companyId,
  domain = AI_DOMAINS.GENERAL,
  label,
  value,
  unit = null,
  sourceService = 'AIToolService',
  sourceMethod,
  sourceIds = [],
  computed = false,
  formula = null,
  permissions = [],
  observedAt = new Date().toISOString(),
  metadata = {},
}) {
  const fact = {
    id: buildFactId({ companyId, domain, label, sourceMethod, sourceIds, value, metadata }),
    companyId: String(companyId),
    domain,
    label,
    value,
    unit,
    sourceType: 'service',
    sourceService,
    sourceMethod,
    sourceIds: sourceIds.map(String),
    computed,
    formula,
    permissions,
    observedAt,
  };

  return assertValidFactRecord(fact);
}

function addNumericFact(facts, config) {
  if (typeof config.value === 'number' && Number.isFinite(config.value)) {
    facts.push(createFact(config));
  }
}

module.exports = {
  createFact,
  addNumericFact,
  sourceIdsFrom,
};

