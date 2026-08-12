'use strict';

const AIFinding = require('../models/AIFinding');
const { FINDING_STATUSES } = require('../ai-engine/decision-engine');

function serializeFinding(doc) {
  if (!doc) return null;
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: plain.findingId,
    companyId: String(plain.company),
    domain: plain.domain,
    ruleId: plain.ruleId,
    title: plain.title,
    summary: plain.summary,
    severity: plain.severity,
    confidence: plain.confidence,
    evidenceFactIds: plain.evidenceFactIds || [],
    recommendedNextStep: plain.recommendedNextStep,
    status: plain.status,
    firstDetectedAt: plain.firstDetectedAt,
    lastDetectedAt: plain.lastDetectedAt,
    occurrenceCount: plain.occurrenceCount,
    metadata: plain.metadata || {},
  };
}

async function upsertFindings(companyId, findings = []) {
  const persisted = [];

  for (const finding of findings) {
    const updated = await AIFinding.findOneAndUpdate(
      { company: companyId, findingId: finding.id },
      {
        $set: {
          company: companyId,
          findingId: finding.id,
          domain: finding.domain,
          ruleId: finding.ruleId,
          title: finding.title,
          summary: finding.summary,
          severity: finding.severity,
          confidence: finding.confidence,
          evidenceFactIds: finding.evidenceFactIds || [],
          recommendedNextStep: finding.recommendedNextStep,
          metadata: finding.metadata || {},
          lastDetectedAt: new Date(),
        },
        $setOnInsert: {
          status: FINDING_STATUSES.OPEN,
          firstDetectedAt: new Date(),
        },
        $inc: {
          occurrenceCount: 1,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    persisted.push(serializeFinding(updated));
  }

  return persisted;
}

async function listFindings(companyId, options = {}) {
  const query = { company: companyId };
  if (options.status) query.status = options.status;
  if (options.domain) query.domain = options.domain;
  if (options.severity) query.severity = options.severity;

  const limit = Math.min(Number(options.limit) || 50, 200);
  const docs = await AIFinding.find(query)
    .sort({ severity: -1, lastDetectedAt: -1 })
    .limit(limit);

  return docs.map(serializeFinding);
}

async function updateFindingStatus(companyId, findingId, status) {
  if (!Object.values(FINDING_STATUSES).includes(status)) {
    const allowed = Object.values(FINDING_STATUSES).join(', ');
    throw new Error(`Invalid finding status. Expected one of: ${allowed}`);
  }

  const updated = await AIFinding.findOneAndUpdate(
    { company: companyId, findingId },
    { $set: { status } },
    { new: true }
  );

  return serializeFinding(updated);
}

module.exports = {
  serializeFinding,
  upsertFindings,
  listFindings,
  updateFindingStatus,
};
