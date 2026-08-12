'use strict';

const crypto = require('crypto');
const {
  ACTION_ENGINE_VERSION,
  PROPOSAL_TYPES,
  PROPOSAL_POLICY,
  PROPOSAL_STATUSES,
  normalizeProposalType,
} = require('./actionTypes');
const { validatePayload } = require('./payloadValidation');
const { hasPermission, hasAnyRole } = require('./permissionChecks');

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 14);
}

function buildProposalId({ companyId, createdBy, type, payload, evidenceFactIds }) {
  return `proposal_${stableHash({ companyId, createdBy, type, payload, evidenceFactIds, at: Date.now() })}`;
}

function buildActionProposalDraft({
  companyId,
  createdBy,
  type,
  actionType,
  payload = {},
  evidenceFactIds = [],
  sourceRecommendationIds = [],
  sourceFindingIds = [],
  status = PROPOSAL_STATUSES.DRAFT,
  metadata = {},
}) {
  const proposalType = normalizeProposalType(type || actionType);
  if (!proposalType || !Object.values(PROPOSAL_TYPES).includes(proposalType)) {
    throw new Error('Unsupported AI action proposal type');
  }

  const validationErrors = validatePayload(proposalType, payload);
  if (validationErrors.length) {
    throw new Error(`Invalid AI action proposal payload: ${validationErrors.join('; ')}`);
  }

  const policy = PROPOSAL_POLICY[proposalType];
  return {
    id: buildProposalId({ companyId, createdBy, type: proposalType, payload, evidenceFactIds }),
    companyId: String(companyId),
    createdBy: String(createdBy),
    type: proposalType,
    status,
    payload,
    evidenceFactIds: evidenceFactIds.map(String),
    sourceRecommendationIds: sourceRecommendationIds.map(String),
    sourceFindingIds: sourceFindingIds.map(String),
    riskLevel: policy.riskLevel,
    approvalRequiredByRole: policy.approvalRequiredByRole,
    approvedBy: null,
    executedAt: null,
    executionResult: null,
    createdAt: new Date().toISOString(),
    metadata: {
      ...metadata,
      actionEngineVersion: ACTION_ENGINE_VERSION,
    },
  };
}

function assertCanApprove(proposal, user) {
  const policy = PROPOSAL_POLICY[proposal.type];
  if (!policy) throw new Error('Unsupported AI action proposal type');
  if (![PROPOSAL_STATUSES.DRAFT, PROPOSAL_STATUSES.PENDING_APPROVAL].includes(proposal.status)) {
    throw new Error(`Proposal cannot be approved from status ${proposal.status}`);
  }
  if (!hasAnyRole(user, policy.approvalRequiredByRole) && !hasPermission(user, 'ai.actions.approve')) {
    throw new Error('User is not allowed to approve this AI action proposal');
  }
  return true;
}

function assertCanReject(proposal, user) {
  if ([PROPOSAL_STATUSES.EXECUTED, PROPOSAL_STATUSES.FAILED].includes(proposal.status)) {
    throw new Error(`Proposal cannot be rejected from status ${proposal.status}`);
  }
  if (!hasPermission(user, 'ai.actions.reject') && !hasAnyRole(user, proposal.approvalRequiredByRole || [])) {
    throw new Error('User is not allowed to reject this AI action proposal');
  }
  return true;
}

function assertCanExecute(proposal, user) {
  const policy = PROPOSAL_POLICY[proposal.type];
  if (!policy) throw new Error('Unsupported AI action proposal type');
  if (proposal.status !== PROPOSAL_STATUSES.APPROVED) {
    throw new Error('AI action proposal must be approved before execution');
  }
  const validationErrors = validatePayload(proposal.type, proposal.payload || {});
  if (validationErrors.length) {
    throw new Error(`AI action proposal payload is no longer valid: ${validationErrors.join('; ')}`);
  }
  if (!hasPermission(user, policy.requiredExecutionPermission) && !hasPermission(user, 'ai.actions.execute')) {
    throw new Error('User is not allowed to execute this AI action proposal');
  }
  return true;
}

module.exports = {
  ACTION_ENGINE_VERSION,
  buildActionProposalDraft,
  assertCanApprove,
  assertCanReject,
  assertCanExecute,
};
