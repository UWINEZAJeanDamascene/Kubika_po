'use strict';

jest.mock('../lib/prisma', () => ({
  prisma: {
    aIActionProposal: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

jest.mock('../services/AuditLogService', () => ({ log: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/purchaseOrderService', () => ({ createAIDraft: jest.fn() }));
jest.mock('../services/aiOperationalMetricsService', () => ({ recordEvent: jest.fn().mockResolvedValue(true) }));

const { prisma } = require('../lib/prisma');
const AuditLogService = require('../services/AuditLogService');
const PurchaseOrderService = require('../services/purchaseOrderService');
const service = require('../services/aiActionProposalService');

function row(overrides = {}) {
  return {
    id: '012345678901234567890123',
    proposalId: 'proposal_1',
    company: 'company_a',
    createdBy: 'user_1',
    type: 'purchase_order_draft',
    status: 'draft',
    payload: { supplierId: 'supplier_1', items: [{ productId: 'product_1', quantity: 1 }] },
    evidenceFactIds: [],
    sourceRecommendationIds: [],
    sourceFindingIds: [],
    riskLevel: 'medium',
    approvalRequiredByRole: ['admin', 'manager', 'procurement_manager'],
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectionReason: null,
    executedBy: null,
    executedAt: null,
    executionResult: null,
    metadata: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('AI Action Proposal Service (PostgreSQL)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('gets proposals using the tenant and external proposal ID composite key', async () => {
    prisma.aIActionProposal.findUnique.mockResolvedValue(null);

    const result = await service.getProposal('company_a', 'proposal_1');

    expect(result).toBeNull();
    expect(prisma.aIActionProposal.findUnique).toHaveBeenCalledWith({
      where: { company_proposalId: { company: 'company_a', proposalId: 'proposal_1' } },
    });
  });

  test('creates a tenant-scoped draft in PostgreSQL and audits creation', async () => {
    prisma.aIActionProposal.create.mockImplementation(async ({ data }) => row(data));

    const result = await service.createProposal({
      companyId: 'company_a',
      user: { id: 'user_1' },
      input: {
        type: 'purchase_order_draft',
        payload: { supplierId: 'supplier_1', items: [{ productId: 'product_1', quantity: 2 }] },
      },
    });

    expect(prisma.aIActionProposal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ company: 'company_a', createdBy: 'user_1', status: 'draft' }),
    });
    expect(result).toEqual(expect.objectContaining({ companyId: 'company_a', status: 'draft' }));
    expect(AuditLogService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai_action_proposal.create' }));
  });

  test('lists only records belonging to the current company', async () => {
    prisma.aIActionProposal.findMany.mockResolvedValue([row()]);
    await service.listProposals('company_a', { status: 'draft', limit: '25' });
    expect(prisma.aIActionProposal.findMany).toHaveBeenCalledWith({
      where: { company: 'company_a', status: 'draft' },
      orderBy: { updatedAt: 'desc' },
      take: 25,
    });
  });

  test('approval uses an atomic status transition and audits it', async () => {
    prisma.aIActionProposal.findUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ status: 'approved', approvedBy: 'user_admin' }));
    prisma.aIActionProposal.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.approveProposal('company_a', 'proposal_1', {
      id: 'user_admin', roles: [{ name: 'admin' }],
    });

    expect(prisma.aIActionProposal.updateMany).toHaveBeenCalledWith({
      where: { company: 'company_a', proposalId: 'proposal_1', status: { in: ['draft', 'pending_approval'] } },
      data: expect.objectContaining({ status: 'approved', approvedBy: 'user_admin' }),
    });
    expect(result.status).toBe('approved');
    expect(AuditLogService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai_action_proposal.approve' }));
  });

  test('does not allow an unapproved proposal to execute', async () => {
    prisma.aIActionProposal.findUnique.mockResolvedValue(row({ status: 'rejected' }));

    await expect(service.executeProposal('company_a', 'proposal_1', {
      id: 'user_admin', permissions: ['*'], roles: [{ name: 'admin' }],
    })).rejects.toThrow('must be approved');
    expect(prisma.aIActionProposal.updateMany).not.toHaveBeenCalled();
  });

  test('fails closed when an approved type has no ERP executor and keeps it approved', async () => {
    prisma.aIActionProposal.findUnique.mockResolvedValue(row({
      type: 'supplier_follow_up_task',
      payload: { supplierId: 'supplier_1' },
      status: 'approved', approvedBy: 'user_admin',
    }));

    const result = await service.executeProposal('company_a', 'proposal_1', {
      id: 'user_admin', permissions: ['suppliers.update'], roles: [{ name: 'admin' }],
    });

    expect(result.status).toBe('approved');
    expect(result.executionResult).toEqual(expect.objectContaining({
      ok: false,
      code: 'EXECUTOR_NOT_IMPLEMENTED',
      executedBusinessOperation: false,
    }));
    expect(prisma.aIActionProposal.updateMany).not.toHaveBeenCalled();
    expect(AuditLogService.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai_action_proposal.execute_unavailable', status: 'failure',
    }));
  });

  test('executes an approved purchase order proposal as an idempotent draft inside one transaction', async () => {
    const tx = {
      aIActionProposal: {
        findUnique: jest.fn()
          .mockResolvedValueOnce(row({ status: 'approved', approvedBy: 'user_admin' }))
          .mockResolvedValueOnce(row({
            status: 'executed', approvedBy: 'user_admin', executedBy: 'user_admin',
            executionResult: { ok: true, purchaseOrderId: 'po_1', purchaseOrderReference: 'PO-1' },
          })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.aIActionProposal.findUnique.mockResolvedValue(row({ status: 'approved', approvedBy: 'user_admin' }));
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    PurchaseOrderService.createAIDraft.mockResolvedValue({ _id: 'po_1', referenceNo: 'PO-1' });

    const result = await service.executeProposal('company_a', 'proposal_1', {
      id: 'user_admin', permissions: ['purchases.create'], roles: [{ name: 'admin' }],
    });

    expect(PurchaseOrderService.createAIDraft).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company_a', createdBy: 'user_admin', proposalId: 'proposal_1',
    }));
    expect(tx.aIActionProposal.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { company: 'company_a', proposalId: 'proposal_1', status: 'approved' },
      data: expect.objectContaining({ status: 'executed', executedBy: 'user_admin' }),
    }));
    expect(result.status).toBe('executed');
    expect(result.executionResult.purchaseOrderId).toBe('po_1');
    expect(AuditLogService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai_action_proposal.execute' }));
  });

  test('returns the saved result on an execution retry without creating another purchase order', async () => {
    prisma.aIActionProposal.findUnique.mockResolvedValue(row({
      status: 'executed',
      executionResult: { ok: true, purchaseOrderId: 'po_1', purchaseOrderReference: 'PO-1' },
    }));

    const result = await service.executeProposal('company_a', 'proposal_1', {
      id: 'user_admin', permissions: ['purchases.create'], roles: [{ name: 'admin' }],
    });

    expect(result.executionResult.purchaseOrderId).toBe('po_1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(PurchaseOrderService.createAIDraft).not.toHaveBeenCalled();
  });

  test('does not permit a stale approval transition after another lifecycle update', async () => {
    prisma.aIActionProposal.findUnique.mockResolvedValueOnce(row());
    prisma.aIActionProposal.updateMany.mockResolvedValue({ count: 0 });
    prisma.aIActionProposal.findUnique.mockResolvedValueOnce(row({ status: 'rejected' }));

    await expect(service.approveProposal('company_a', 'proposal_1', {
      id: 'user_admin', roles: [{ name: 'admin' }],
    })).rejects.toThrow('changed concurrently');
  });
});
