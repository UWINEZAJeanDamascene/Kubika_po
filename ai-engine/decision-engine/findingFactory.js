'use strict';

const crypto = require('crypto');
const { FINDING_SEVERITIES } = require('../shared/interfaces');
const { scoreConfidence } = require('./confidence');

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
  const computedConfidence = confidence == null
    ? scoreConfidence({ evidenceCount: evidenceFactIds.length, ruleCertainty: metadata.ruleCertainty || 0.8 })
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
    metadata,
  };
}

module.exports = {
  FINDING_STATUSES,
  createFinding,
};

