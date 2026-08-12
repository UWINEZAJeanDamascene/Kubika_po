'use strict';

function normalizeLabel(value) {
  return String(value || '').trim().toLowerCase();
}

function latestFact(context, label) {
  const normalized = normalizeLabel(label);
  const facts = (context.facts || []).filter((fact) => normalizeLabel(fact.label) === normalized);
  facts.sort((a, b) => new Date(b.observedAt || 0) - new Date(a.observedAt || 0));
  return facts[0] || null;
}

function numberFact(context, label) {
  const fact = latestFact(context, label);
  if (!fact) return { fact: null, value: null };
  const value = Number(fact.value);
  return { fact, value: Number.isFinite(value) ? value : null };
}

function objectFact(context, label) {
  const fact = latestFact(context, label);
  return { fact, value: fact ? fact.value : null };
}

module.exports = {
  latestFact,
  numberFact,
  objectFact,
};

