'use strict';

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function freshnessFromFacts(evidenceFacts = [], now = Date.now()) {
  if (!evidenceFacts.length) return 0.35;
  const ages = evidenceFacts
    .map((fact) => new Date(fact.observedAt || 0).getTime())
    .filter(Number.isFinite)
    .map((timestamp) => Math.max(0, now - timestamp));
  if (!ages.length) return 0.35;
  const oldestDays = Math.max(...ages) / (24 * 60 * 60 * 1000);
  if (oldestDays <= 1) return 1;
  if (oldestDays <= 7) return 0.9;
  if (oldestDays <= 30) return 0.75;
  if (oldestDays <= 90) return 0.6;
  return 0.4;
}

function scoreConfidence({
  evidenceCount = 0,
  evidenceFacts = [],
  ruleCertainty = 0.8,
  dataFreshness,
  completeness,
  expectedEvidenceCount,
  historicalConsistency = 0.65,
  modelUncertainty = 0,
} = {}) {
  const evidenceScore = clamp(evidenceCount / 3, 0.25, 1);
  const actualFreshness = dataFreshness == null ? freshnessFromFacts(evidenceFacts) : clamp(dataFreshness);
  const actualCompleteness = completeness == null
    ? (expectedEvidenceCount ? clamp(evidenceCount / expectedEvidenceCount) : (evidenceCount ? 0.75 : 0.25))
    : clamp(completeness);
  const score = (evidenceScore * 0.2)
    + (clamp(ruleCertainty) * 0.35)
    + (actualFreshness * 0.2)
    + (actualCompleteness * 0.1)
    + (clamp(historicalConsistency) * 0.15)
    - (clamp(modelUncertainty) * 0.1);
  return Number(clamp(score).toFixed(2));
}

module.exports = {
  scoreConfidence,
  freshnessFromFacts,
};
