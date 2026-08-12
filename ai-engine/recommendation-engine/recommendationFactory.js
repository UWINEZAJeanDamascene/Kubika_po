'use strict';

const crypto = require('crypto');
const { RECOMMENDATION_TYPES } = require('../shared/interfaces');
const { confidenceLabel } = require('./recommendationTypes');

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 14);
}

function createRecommendation({
  companyId,
  kind,
  type = RECOMMENDATION_TYPES.INFORMATIONAL,
  title,
  rationale,
  priorityScore,
  confidence,
  evidenceFactIds = [],
  sourceFindingIds = [],
  recommendedNextStep,
  actionIntent = null,
  metadata = {},
}) {
  return {
    id: `rec_${stableHash({ companyId, kind, sourceFindingIds, evidenceFactIds })}`,
    companyId: String(companyId),
    kind,
    type,
    title,
    rationale,
    priorityScore,
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    lowConfidence: Number(confidence || 0) < 0.65,
    evidenceFactIds,
    sourceFindingIds,
    recommendedNextStep,
    actionIntent,
    createdAt: new Date().toISOString(),
    metadata,
  };
}

module.exports = {
  createRecommendation,
};
