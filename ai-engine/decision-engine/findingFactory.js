'use strict';

const crypto = require('crypto');
const { FINDING_SEVERITIES } = require('../shared/interfaces');
const { scoreConfidence, freshnessFromFacts } = require('./confidence');

const FINDING_STATUSES = Object.freeze({
  OPEN: 'open',
  ACKNOWLEDGED: 'acknowledged',
  DISMISSED: 'dismissed',
  RESOLVED: 'resolved',
});

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 14);
}

function makeFindingId({ companyId, ruleId, evidenceFactIds }) {
  return `finding_${stableHash({ companyId, ruleId, evidenceFactIds })}`;
}

function createFinding({
  companyId,
  ruleId,
  domain,
  title,
  summary,
  severity = FINDING_SEVERITIES.INFO,
  evidenceFacts = [],
  recommendedNextStep,
  confidence,
  status = FINDING_STATUSES.OPEN,
  metadata = {},
}) {
  const evidenceFactIds = evidenceFacts.map((fact) => fact && fact.id).filter(Boolean);
  const confidenceFactors = {
    evidenceCount: evidenceFactIds.length,
    evidenceCompleteness: metadata.evidenceCompleteness == null
      ? (metadata.expectedEvidenceCount ? Math.min(1, evidenceFactIds.length / metadata.expectedEvidenceCount) : (evidenceFactIds.length ? 0.75 : 0.25))
      : metadata.evidenceCompleteness,
    dataFreshness: metadata.dataFreshness == null ? freshnessFromFacts(evidenceFacts) : metadata.dataFreshness,
    ruleCertainty: metadata.ruleCertainty == null ? 0.8 : metadata.ruleCertainty,
    historicalConsistency: metadata.historicalConsistency == null ? 0.65 : metadata.historicalConsistency,
    modelUncertainty: metadata.modelUncertainty == null ? 0 : metadata.modelUncertainty,
  };
  const computedConfidence = confidence == null
    ? scoreConfidence({
      evidenceCount: evidenceFactIds.length,
      evidenceFacts,
      ruleCertainty: confidenceFactors.ruleCertainty,
      completeness: confidenceFactors.evidenceCompleteness,
      dataFreshness: confidenceFactors.dataFreshness,
      historicalConsistency: confidenceFactors.historicalConsistency,
      modelUncertainty: confidenceFactors.modelUncertainty,
    })
    : confidence;

  return {
    id: makeFindingId({ companyId, ruleId, evidenceFactIds }),
    companyId: String(companyId),
    domain,
    ruleId,
    title,
    summary,
    severity,
    confidence: computedConfidence,
    evidenceFactIds,
    recommendedNextStep,
    status,
    createdAt: new Date().toISOString(),
    metadata: { ...metadata, confidenceFactors },
  };
}

module.exports = {
  FINDING_STATUSES,
  createFinding,
};
