'use strict';

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function scoreConfidence({ evidenceCount = 0, ruleCertainty = 0.8, dataFreshness = 1, completeness = 1 } = {}) {
  const evidenceScore = clamp(evidenceCount / 3, 0.35, 1);
  const score = (evidenceScore * 0.25) + (ruleCertainty * 0.4) + (dataFreshness * 0.2) + (completeness * 0.15);
  return Number(clamp(score).toFixed(2));
}

module.exports = {
  scoreConfidence,
};

