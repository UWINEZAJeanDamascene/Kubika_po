'use strict';

const {
  ACTION_ENGINE_VERSION,
  PROPOSAL_STATUSES,
  PROPOSAL_TYPES,
  buildActionProposalDraft,
  assertCanApprove,
  assertCanReject,
  assertCanExecute,
  hasPermission,
} = require('../../action-engine');

const adminUser = {
  _id: 'user_admin',
  roles: [{ name: 'admin', permissions: ['*'] }],
  permissions: ['*'],
};

const stockUser = {
  _id: 'user_stock',
  roles: [{ name: 'inventory_manager', permissions: ['inventory:update'] }],
  permissions: ['inventory:update'],
};

const staffUser = {
  _id: 'user_staff',
  roles: [{ name: 'staff', permissions: ['reports.read'] }],
  permissions: ['reports.read'],
};

function proposal(overrides = {}) {
  return buildActionProposalDraft({
    companyId: 'company_1',
    createdBy: 'user_1',
    actionType: 'create_purchase_order',
    payload: { supplierId: 'supplier_1', items: [] },
    evidenceFactIds: ['fact_1'],
    ...overrides,
  });
}

describe('AI Action Engine', () => {
  test('builds a draft proposal without executing business operations', () => {
    const draft = proposal();

    expect(draft).toEqual(expect.objectContaining({
      companyId: 'company_1',
      type: PROPOSAL_TYPES.PURCHASE_ORDER_DRAFT,
      status: PROPOSAL_STATUSES.DRAFT,
      riskLevel: 'medium',
      approvedBy: null,
      executedAt: null,
      executionResult: null,
    }));
    expect(draft.metadata.actionEngineVersion).toBe(ACTION_ENGINE_VERSION);
  });

  test('rejects unsupported proposal types and invalid payloads', () => {
    expect(() => proposal({ actionType: 'delete_or_void' })).toThrow('Unsupported AI action proposal type');
    expect(() => proposal({
      actionType: 'adjust_stock',
      payload: { adjustments: [{ quantity: 'not-a-number' }] },
    })).toThrow('quantity must be numeric');
  });

  test('approval requires an allowed role or AI approval permission', () => {
    const draft = proposal({ status: PROPOSAL_STATUSES.PENDING_APPROVAL });

    expect(() => assertCanApprove(draft, staffUser)).toThrow('not allowed to approve');
    expect(assertCanApprove(draft, adminUser)).toBe(true);
  });

  test('execution is blocked until approval and rejected proposals cannot execute', () => {
    const draft = proposal();
    const rejected = { ...draft, status: PROPOSAL_STATUSES.REJECTED };
    const approved = { ...draft, status: PROPOSAL_STATUSES.APPROVED };

    expect(() => assertCanExecute(draft, adminUser)).toThrow('must be approved');
    expect(() => assertCanExecute(rejected, adminUser)).toThrow('must be approved');
    expect(assertCanExecute(approved, adminUser)).toBe(true);
  });

  test('permission helper accepts colon and dot permission styles', () => {
    expect(hasPermission(stockUser, 'inventory.update')).toBe(true);
    expect(hasPermission(staffUser, 'inventory.update')).toBe(false);
  });

  test('rejecting executed proposals is blocked', () => {
    const executed = proposal({ status: PROPOSAL_STATUSES.EXECUTED });
    expect(() => assertCanReject(executed, adminUser)).toThrow('cannot be rejected');
  });
});
