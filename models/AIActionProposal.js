'use strict';

const { buildGlobalModel } = require('../utils/masterDataCommon');
const { generateObjectId, toIdString } = require('../utils/objectId');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  proposalId: { target: 'proposalId' },
  company: { target: 'company' },
  createdBy: { target: 'createdBy' },
  evidenceFactIds: { target: 'evidenceFactIds' },
  sourceRecommendationIds: { target: 'sourceRecommendationIds' },
  sourceFindingIds: { target: 'sourceFindingIds' },
  riskLevel: { target: 'riskLevel' },
  approvalRequiredByRole: { target: 'approvalRequiredByRole' },
  approvedBy: { target: 'approvedBy' },
  approvedAt: { target: 'approvedAt' },
  rejectedBy: { target: 'rejectedBy' },
  rejectedAt: { target: 'rejectedAt' },
  rejectionReason: { target: 'rejectionReason' },
  executedBy: { target: 'executedBy' },
  executedAt: { target: 'executedAt' },
  executionResult: { target: 'executionResult' },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

function toApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    proposalId: row.proposalId,
    company: row.company,
    createdBy: row.createdBy,
    type: row.type,
    status: row.status,
    payload: row.payload || {},
    evidenceFactIds: row.evidenceFactIds || [],
    sourceRecommendationIds: row.sourceRecommendationIds || [],
    sourceFindingIds: row.sourceFindingIds || [],
    riskLevel: row.riskLevel,
    approvalRequiredByRole: row.approvalRequiredByRole || [],
    approvedBy: row.approvedBy ?? null,
    approvedAt: row.approvedAt ?? null,
    rejectedBy: row.rejectedBy ?? null,
    rejectedAt: row.rejectedAt ?? null,
    rejectionReason: row.rejectionReason ?? null,
    executedBy: row.executedBy ?? null,
    executedAt: row.executedAt ?? null,
    executionResult: row.executionResult ?? null,
    metadata: row.metadata || {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function translateCreate(data = {}) {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    proposalId: data.proposalId,
    company: toIdString(data.company),
    createdBy: toIdString(data.createdBy),
    type: data.type,
    status: data.status || 'draft',
    payload: data.payload || {},
    evidenceFactIds: data.evidenceFactIds || [],
    sourceRecommendationIds: data.sourceRecommendationIds || [],
    sourceFindingIds: data.sourceFindingIds || [],
    riskLevel: data.riskLevel,
    approvalRequiredByRole: data.approvalRequiredByRole || [],
    approvedBy: data.approvedBy ? toIdString(data.approvedBy) : null,
    approvedAt: data.approvedAt || null,
    rejectedBy: data.rejectedBy ? toIdString(data.rejectedBy) : null,
    rejectedAt: data.rejectedAt || null,
    rejectionReason: data.rejectionReason ?? null,
    executedBy: data.executedBy ? toIdString(data.executedBy) : null,
    executedAt: data.executedAt || null,
    executionResult: data.executionResult ?? null,
    metadata: data.metadata || {},
  };
}

function translateUpdate(update = {}) {
  const source = update.$set ? { ...update, ...update.$set } : { ...update };
  delete source.$set;
  delete source.$setOnInsert;
  delete source.$inc;
  delete source.$unset;
  const data = {};
  const fields = ['proposalId', 'company', 'createdBy', 'type', 'status', 'payload', 'evidenceFactIds', 'sourceRecommendationIds', 'sourceFindingIds', 'riskLevel', 'approvalRequiredByRole', 'rejectionReason', 'metadata'];
  for (const field of fields) {
    if (source[field] !== undefined) data[field] = ['company', 'createdBy'].includes(field) ? toIdString(source[field]) : source[field];
  }
  for (const field of ['approvedBy', 'rejectedBy', 'executedBy']) {
    if (source[field] !== undefined) data[field] = source[field] ? toIdString(source[field]) : null;
  }
  for (const field of ['approvedAt', 'rejectedAt', 'executedAt', 'executionResult']) {
    if (source[field] !== undefined) data[field] = source[field];
  }
  return data;
}

module.exports = buildGlobalModel({
  name: 'AIActionProposal',
  collection: 'ai_action_proposals',
  delegateName: 'aIActionProposal',
  fieldMap: FIELD_MAP,
  toApi,
  translateCreate,
  translateUpdate,
  mutable: true,
});
