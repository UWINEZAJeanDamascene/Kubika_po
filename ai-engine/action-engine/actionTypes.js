'use strict';

const { PROPOSAL_STATUSES } = require('../shared/interfaces');

const ACTION_ENGINE_VERSION = 'action-engine-v1';

const PROPOSAL_TYPES = Object.freeze({
  PURCHASE_ORDER_DRAFT: 'purchase_order_draft',
  PAYMENT_REMINDER_DRAFT: 'payment_reminder_draft',
  STOCK_ADJUSTMENT_REVIEW: 'stock_adjustment_review_request',
  SUPPLIER_FOLLOW_UP_TASK: 'supplier_follow_up_task',
  CUSTOMER_FOLLOW_UP_TASK: 'customer_follow_up_task',
});

const RISK_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const ACTION_TO_PROPOSAL_TYPE = Object.freeze({
  create_purchase_order: PROPOSAL_TYPES.PURCHASE_ORDER_DRAFT,
  send_payment_reminder: PROPOSAL_TYPES.PAYMENT_REMINDER_DRAFT,
  adjust_stock: PROPOSAL_TYPES.STOCK_ADJUSTMENT_REVIEW,
});

const RECOMMENDATION_ACTION_TO_PROPOSAL_TYPE = Object.freeze({
  create_purchase_order: PROPOSAL_TYPES.PURCHASE_ORDER_DRAFT,
  send_payment_reminder: PROPOSAL_TYPES.PAYMENT_REMINDER_DRAFT,
  prepare_tax_payment_reminder: PROPOSAL_TYPES.SUPPLIER_FOLLOW_UP_TASK,
});

const PROPOSAL_POLICY = Object.freeze({
  [PROPOSAL_TYPES.PURCHASE_ORDER_DRAFT]: {
    riskLevel: RISK_LEVELS.MEDIUM,
    approvalRequiredByRole: ['admin', 'manager', 'procurement_manager'],
    requiredExecutionPermission: 'purchases.create',
  },
  [PROPOSAL_TYPES.PAYMENT_REMINDER_DRAFT]: {
    riskLevel: RISK_LEVELS.LOW,
    approvalRequiredByRole: ['admin', 'manager', 'accountant'],
    requiredExecutionPermission: 'customers.update',
  },
  [PROPOSAL_TYPES.STOCK_ADJUSTMENT_REVIEW]: {
    riskLevel: RISK_LEVELS.HIGH,
    approvalRequiredByRole: ['admin', 'inventory_manager'],
    requiredExecutionPermission: 'inventory.update',
  },
  [PROPOSAL_TYPES.SUPPLIER_FOLLOW_UP_TASK]: {
    riskLevel: RISK_LEVELS.LOW,
    approvalRequiredByRole: ['admin', 'manager', 'procurement_manager'],
    requiredExecutionPermission: 'suppliers.update',
  },
  [PROPOSAL_TYPES.CUSTOMER_FOLLOW_UP_TASK]: {
    riskLevel: RISK_LEVELS.LOW,
    approvalRequiredByRole: ['admin', 'manager', 'accountant'],
    requiredExecutionPermission: 'customers.update',
  },
});

function normalizeProposalType(input) {
  if (!input) return null;
  const value = String(input);
  if (Object.values(PROPOSAL_TYPES).includes(value)) return value;
  if (ACTION_TO_PROPOSAL_TYPE[value]) return ACTION_TO_PROPOSAL_TYPE[value];
  if (RECOMMENDATION_ACTION_TO_PROPOSAL_TYPE[value]) return RECOMMENDATION_ACTION_TO_PROPOSAL_TYPE[value];
  return null;
}

module.exports = {
  ACTION_ENGINE_VERSION,
  PROPOSAL_TYPES,
  RISK_LEVELS,
  PROPOSAL_STATUSES,
  PROPOSAL_POLICY,
  ACTION_TO_PROPOSAL_TYPE,
  RECOMMENDATION_ACTION_TO_PROPOSAL_TYPE,
  normalizeProposalType,
};
