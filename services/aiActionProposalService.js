'use strict';

const { prisma } = require('../lib/prisma');
const { runWithTx } = require('../lib/txContext');
const { generateObjectId } = require('../utils/objectId');
const AuditLogService = require('./AuditLogService');
const PurchaseOrderService = require('./purchaseOrderService');
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

function serializeProposal(row) {
  if (!row) return null;
  return {
    id: row.proposalId,
    companyId: String(row.company),
    createdBy: row.createdBy,
    type: row.type,
    status: row.status,
    payload: row.payload || {},
    evidenceFactIds: row.evidenceFactIds || [],
    sourceRecommendationIds: row.sourceRecommendationIds || [],
    sourceFindingIds: row.sourceFindingIds || [],
    riskLevel: row.riskLevel,
    approvalRequiredByRole: row.approvalRequiredByRole || [],
    approvedBy: row.approvedBy || null,
    approvedAt: row.approvedAt || null,
    rejectedBy: row.rejectedBy || null,
    rejectedAt: row.rejectedAt || null,
    rejectionReason: row.rejectionReason || null,
    executedBy: row.executedBy || null,
    executedAt: row.executedAt || null,
    executionResult: row.executionResult || null,
    metadata: row.metadata || {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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

function proposalWhere(companyId, proposalId) {
  return { company: String(companyId), proposalId: String(proposalId) };
}

async function createProposal({ companyId, user, input, req = null }) {
  const tenantId = entityId(companyId);
  const userId = entityId(user);
  if (!tenantId || !userId) throw new Error('Company and authenticated user are required to create an AI proposal');
  const proposal = buildActionProposalDraft({
    companyId: tenantId,
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

  const created = await prisma.aIActionProposal.create({
    data: {
      id: generateObjectId(),
      proposalId: proposal.id,
      company: tenantId,
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
    },
  });

  const serialized = serializeProposal(created);
  await audit('create', { companyId: tenantId, userId, proposal: serialized, req });
  return serialized;
}

async function listProposals(companyId, options = {}) {
  const limitValue = Number.parseInt(options.limit, 10);
  const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(limitValue, 200)) : 50;
  const docs = await prisma.aIActionProposal.findMany({
    where: {
      company: String(companyId),
      ...(options.status ? { status: String(options.status) } : {}),
      ...(options.type ? { type: String(options.type) } : {}),
      ...(options.riskLevel ? { riskLevel: String(options.riskLevel) } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
  return docs.map(serializeProposal);
}

async function getProposal(companyId, proposalId) {
  const row = await prisma.aIActionProposal.findUnique({
    where: { company_proposalId: proposalWhere(companyId, proposalId) },
  });
  return serializeProposal(row);
}

async function transitionProposal(companyId, proposalId, allowedStatuses, data) {
  const where = { ...proposalWhere(companyId, proposalId), status: { in: allowedStatuses } };
  const changed = await prisma.aIActionProposal.updateMany({ where, data });
  if (changed.count !== 1) {
    const current = await getProposal(companyId, proposalId);
    if (!current) return null;
    throw new Error(`Proposal status changed concurrently or cannot transition from ${current.status}`);
  }
  return getProposal(companyId, proposalId);
}

async function approveProposal(companyId, proposalId, user, req = null) {
  const existing = await getProposal(companyId, proposalId);
  if (!existing) return null;
  assertCanApprove(existing, user);
  const userId = entityId(user);
  const serialized = await transitionProposal(companyId, proposalId,
    [PROPOSAL_STATUSES.DRAFT, PROPOSAL_STATUSES.PENDING_APPROVAL], {
      status: PROPOSAL_STATUSES.APPROVED,
      approvedBy: userId,
      approvedAt: new Date(),
    });
  await audit('approve', { companyId, userId, proposal: serialized, req });
  return serialized;
}

async function rejectProposal(companyId, proposalId, user, reason = null, req = null) {
  const existing = await getProposal(companyId, proposalId);
  if (!existing) return null;
  assertCanReject(existing, user);
  const userId = entityId(user);
  const serialized = await transitionProposal(companyId, proposalId,
    [PROPOSAL_STATUSES.DRAFT, PROPOSAL_STATUSES.PENDING_APPROVAL, PROPOSAL_STATUSES.APPROVED], {
      status: PROPOSAL_STATUSES.REJECTED,
      rejectedBy: userId,
      rejectedAt: new Date(),
      rejectionReason: reason || null,
    });
  await audit('reject', { companyId, userId, proposal: serialized, req });
  return serialized;
}

async function executeProposal(companyId, proposalId, user, req = null) {
  const existing = await getProposal(companyId, proposalId);
  if (!existing) return null;

  if (existing.status === PROPOSAL_STATUSES.EXECUTED && existing.executionResult?.ok === true) {
    const { PROPOSAL_POLICY } = require('../ai-engine/action-engine');
    const { hasPermission } = require('../ai-engine/action-engine');
    const requiredPermission = PROPOSAL_POLICY[existing.type]?.requiredExecutionPermission;
    if (!hasPermission(user, requiredPermission) && !hasPermission(user, 'ai.actions.execute')) {
      throw new Error('User is not allowed to execute this AI action proposal');
    }
    await audit('execute_replay', { companyId, userId: entityId(user), proposal: existing, req });
    return existing;
  }
  assertCanExecute(existing, user);

  const userId = entityId(user);
  if (existing.type === 'purchase_order_draft') {
    let executed;
    try {
      executed = await prisma.$transaction((tx) => runWithTx(tx, async () => {
        const current = await tx.aIActionProposal.findUnique({
          where: { company_proposalId: proposalWhere(companyId, proposalId) },
        });
        if (!current || current.status !== PROPOSAL_STATUSES.APPROVED) {
          throw new Error('AI action proposal must remain approved at execution time');
        }

        const purchaseOrder = await PurchaseOrderService.createAIDraft({
          companyId,
          createdBy: userId,
          proposalId,
          payload: current.payload || {},
        });
        const executionResult = {
          ok: true,
          code: 'PURCHASE_ORDER_DRAFT_CREATED',
          message: 'A draft purchase order was created. It was not approved or sent to the supplier.',
          executedBusinessOperation: true,
          purchaseOrderId: purchaseOrder._id || purchaseOrder.id,
          purchaseOrderReference: purchaseOrder.referenceNo || null,
        };
        const transitioned = await tx.aIActionProposal.updateMany({
          where: { ...proposalWhere(companyId, proposalId), status: PROPOSAL_STATUSES.APPROVED },
          data: {
            status: PROPOSAL_STATUSES.EXECUTED,
            executedBy: userId,
            executedAt: new Date(),
            executionResult,
          },
        });
        if (transitioned.count !== 1) throw new Error('AI proposal was executed or changed concurrently');
        const saved = await tx.aIActionProposal.findUnique({
          where: { company_proposalId: proposalWhere(companyId, proposalId) },
        });
        return serializeProposal(saved);
      }));
    } catch (error) {
      if (error.code !== 'P2002') throw error;
      const concurrentResult = await getProposal(companyId, proposalId);
      if (concurrentResult?.status !== PROPOSAL_STATUSES.EXECUTED || concurrentResult.executionResult?.ok !== true) {
        throw error;
      }
      await audit('execute_replay', { companyId, userId, proposal: concurrentResult, req });
      return concurrentResult;
    }
    await audit('execute', { companyId, userId, proposal: executed, req });
    return executed;
  }

  const executionResult = {
    ok: false,
    code: 'EXECUTOR_NOT_IMPLEMENTED',
    message: 'No ERP executor is registered for this AI proposal type. No business operation was performed.',
    executedBusinessOperation: false,
  };
  const blockedAttempt = { ...existing, executionResult };
  await audit('execute_unavailable', {
    companyId,
    userId,
    proposal: blockedAttempt,
    status: 'failure',
    errorMessage: executionResult.message,
    req,
  });
  return blockedAttempt;
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
