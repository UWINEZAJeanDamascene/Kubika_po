'use strict';

function normalizeLabel(value) {
  return String(value || '').trim().toLowerCase();
}

function latestFactByLabel(facts, label) {
  const normalized = normalizeLabel(label);
  const matches = (facts || []).filter((fact) => normalizeLabel(fact.label) === normalized);
  matches.sort((a, b) => new Date(b.observedAt || 0) - new Date(a.observedAt || 0));
  return matches[0] || null;
}

function numericValue(fact) {
  if (!fact) return null;
  const value = Number(fact.value);
  return Number.isFinite(value) ? value : null;
}

function requireNumericFact(facts, label) {
  const fact = latestFactByLabel(facts, label);
  const value = numericValue(fact);
  if (!fact || value === null) {
    return { value: null, fact: null, missing: label };
  }
  return { value, fact, missing: null };
}

function collectSourceIds(inputFacts) {
  const ids = [];
  for (const fact of inputFacts) {
    if (!fact) continue;
    ids.push(fact.id);
  }
  return Array.from(new Set(ids));
}

function collectSourceRecordIds(inputFacts) {
  const ids = [];
  for (const fact of inputFacts) {
    if (!fact || !Array.isArray(fact.sourceIds)) continue;
    ids.push(...fact.sourceIds);
  }
  return Array.from(new Set(ids));
}

module.exports = {
  latestFactByLabel,
  numericValue,
  requireNumericFact,
  collectSourceIds,
  collectSourceRecordIds,
};

