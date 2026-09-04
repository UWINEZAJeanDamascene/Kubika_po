'use strict';

const { buildGlobalModel } = require('../utils/masterDataCommon');
const { generateObjectId, toIdString } = require('../utils/objectId');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'company' },
  findingId: { target: 'findingId' },
  ruleId: { target: 'ruleId' },
  evidenceFactIds: { target: 'evidenceFactIds' },
  recommendedNextStep: { target: 'recommendedNextStep' },
  firstDetectedAt: { target: 'firstDetectedAt' },
  lastDetectedAt: { target: 'lastDetectedAt' },
  occurrenceCount: { target: 'occurrenceCount' },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

function toApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    findingId: row.findingId,
    company: row.company,
    domain: row.domain,
    ruleId: row.ruleId,
    title: row.title,
    summary: row.summary,
    severity: row.severity,
    confidence: row.confidence,
    evidenceFactIds: row.evidenceFactIds || [],
    recommendedNextStep: row.recommendedNextStep ?? null,
    status: row.status,
    metadata: row.metadata || {},
    firstDetectedAt: row.firstDetectedAt,
    lastDetectedAt: row.lastDetectedAt,
    occurrenceCount: row.occurrenceCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function translateCreate(data = {}) {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    findingId: data.findingId,
    company: toIdString(data.company),
    domain: data.domain,
    ruleId: data.ruleId,
    title: data.title,
    summary: data.summary,
    severity: data.severity,
    confidence: data.confidence,
    evidenceFactIds: data.evidenceFactIds || [],
    recommendedNextStep: data.recommendedNextStep ?? null,
    status: data.status || 'open',
    metadata: data.metadata || {},
    firstDetectedAt: data.firstDetectedAt || new Date(),
    lastDetectedAt: data.lastDetectedAt || new Date(),
    occurrenceCount: data.occurrenceCount || 1,
  };
}

function translateUpdate(update = {}) {
  const source = update.$set ? { ...update, ...update.$set } : { ...update };
  delete source.$set;
  delete source.$setOnInsert;
  delete source.$inc;
  delete source.$unset;
  const data = {};
  for (const field of ['company', 'findingId', 'domain', 'ruleId', 'title', 'summary', 'severity', 'confidence', 'evidenceFactIds', 'recommendedNextStep', 'status', 'metadata', 'firstDetectedAt', 'lastDetectedAt', 'occurrenceCount']) {
    if (source[field] !== undefined) data[field] = field === 'company' ? toIdString(source[field]) : source[field];
  }
  return data;
}

module.exports = buildGlobalModel({
  name: 'AIFinding',
  collection: 'ai_findings',
  delegateName: 'aIFinding',
  fieldMap: FIELD_MAP,
  toApi,
  translateCreate,
  translateUpdate,
  mutable: true,
});
