'use strict';

const AIActionProposal = require('../models/AIActionProposal');
const AuditLogService = require('./AuditLogService');
const {
  PROPOSAL_STATUSES,
  buildActionProposalDraft,
  assertCanApprove,
  assertCanReject,
  assertCanExecute,
} = require('../ai-engine/action-engine');

function entityId(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value._id) return String(value._id);
  if (value.id) return String(value.id);
  return String(value);
}

function serializeProposal(doc) {
  if (!doc) return null;
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: plain.proposalId,
    companyId: String(plain.company),
    createdBy: plain.createdBy,
    type: plain.type,
    status: plain.status,
    payload: plain.payload || {},
    evidenceFactIds: plain.evidenceFactIds || [],
    sourceRecommendationIds: plain.sourceRecommendationIds || [],
    sourceFindingIds: plain.sourceFindingIds || [],
    riskLevel: plain.riskLevel,
    approvalRequiredByRole: plain.approvalRequiredByRole || [],
    approvedBy: plain.approvedBy || null,
    approvedAt: plain.approvedAt || null,
    rejectedBy: plain.rejectedBy || null,
    rejectedAt: plain.rejectedAt || null,
    rejectionReason: plain.rejectionReason || null,
    executedBy: plain.executedBy || null,
    executedAt: plain.executedAt || null,
    executionResult: plain.executionResult || null,
    metadata: plain.metadata || {},
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
}

async function audit(event, { companyId, userId, proposal, status = 'success', errorMessage = null, req = null }) {
  await AuditLogService.log({
    companyId,
    userId,
    action: `ai_action_proposal.${event}`,
    entityType: 'ai_action_proposal',
    entityId: proposal && proposal.id,
    changes: proposal,
    ipAddress: req && req.ip,
    userAgent: req && req.headers && req.headers['user-agent'],
    status,
    errorMessage,
  });
}

async function createProposal({ companyId, user, input, req = null }) {
  const userId = entityId(user);
  const proposal = buildActionProposalDraft({
    companyId,
    createdBy: userId,
    type: input.type,
    actionType: input.actionType,
    payload: input.payload || {},
    evidenceFactIds: input.evidenceFactIds || [],
    sourceRecommendationIds: input.sourceRecommendationIds || [],
    sourceFindingIds: input.sourceFindingIds || [],
    status: input.submitForApproval ? PROPOSAL_STATUSES.PENDING_APPROVAL : PROPOSAL_STATUSES.DRAFT,
    metadata: input.metadata || {},
  });

  const created = await AIActionProposal.create({
    proposalId: proposal.id,
    company: companyId,
    createdBy: userId,
    type: proposal.type,
    status: proposal.status,
    payload: proposal.payload,
    evidenceFactIds: proposal.evidenceFactIds,
    sourceRecommendationIds: proposal.sourceRecommendationIds,
    sourceFindingIds: proposal.sourceFindingIds,
    riskLevel: proposal.riskLevel,
    approvalRequiredByRole: proposal.approvalRequiredByRole,
    metadata: proposal.metadata,
  });

  const serialized = serializeProposal(created);
  await audit('create', { companyId, userId, proposal: serialized, req });
  return serialized;
}

async function listProposals(companyId, options = {}) {
  const query = { company: companyId };
  if (options.status) query.status = options.status;
  if (options.type) query.type = options.type;
  if (options.riskLevel) query.riskLevel = options.riskLevel;

  const limit = Math.min(Number(options.limit) || 50, 200);
  const docs = await AIActionProposal.find(query)
    .sort({ updatedAt: -1 })
    .limit(limit);

  return docs.map(serializeProposal);
}

async function getProposal(companyId, proposalId) {
  const doc = await AIActionProposal.findOne({ company: companyId, proposalId });
  return serializeProposal(doc);
}

async function approveProposal(companyId, proposalId, user, req = null) {
  const existing = await getProposal(companyId, proposalId);
  if (!existing) return null;
  assertCanApprove(existing, user);

  const userId = entityId(user);
  const updated = await AIActionProposal.findOneAndUpdate(
    { company: companyId, proposalId },
    {
      $set: {
        status: PROPOSAL_STATUSES.APPROVED,
        approvedBy: userId,
        approvedAt: new Date(),
      },
    },
    { new: true }
  );

  const serialized = serializeProposal(updated);
  await audit('approve', { companyId, userId, proposal: serialized, req });
  return serialized;
}

async function rejectProposal(companyId, proposalId, user, reason = null, req = null) {
  const existing = await getProposal(companyId, proposalId);
  if (!existing) return null;
  assertCanReject(existing, user);

  const userId = entityId(user);
  const updated = await AIActionProposal.findOneAndUpdate(
    { company: companyId, proposalId },
    {
      $set: {
        status: PROPOSAL_STATUSES.REJECTED,
        rejectedBy: userId,
        rejectedAt: new Date(),
        rejectionReason: reason || null,
      },
    },
    { new: true }
  );

  const serialized = serializeProposal(updated);
  await audit('reject', { companyId, userId, proposal: serialized, req });
  return serialized;
}

async function executeProposal(companyId, proposalId, user, req = null) {
  const existing = await getProposal(companyId, proposalId);
  if (!existing) return null;
  assertCanExecute(existing, user);

  const userId = entityId(user);
  const executionResult = {
    ok: false,
    code: 'EXECUTOR_NOT_IMPLEMENTED',
    message: 'This AI proposal type is approved, but no ERP executor has been connected yet.',
    executedBusinessOperation: false,
  };

  const updated = await AIActionProposal.findOneAndUpdate(
    { company: companyId, proposalId },
    {
      $set: {
        status: PROPOSAL_STATUSES.FAILED,
        executedBy: userId,
        executedAt: new Date(),
        executionResult,
      },
    },
    { new: true }
  );

  const serialized = serializeProposal(updated);
  await audit('execute_failed', {
    companyId,
    userId,
    proposal: serialized,
    status: 'failure',
    errorMessage: executionResult.message,
    req,
  });
  return serialized;
}

module.exports = {
  serializeProposal,
  createProposal,
  listProposals,
  getProposal,
  approveProposal,
  rejectProposal,
  executeProposal,
};
