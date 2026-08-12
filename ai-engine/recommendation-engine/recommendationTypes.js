'use strict';

const RECOMMENDATION_KINDS = Object.freeze({
  REORDER_STOCK: 'reorder_stock',
  FOLLOW_UP_OVERDUE_RECEIVABLE: 'follow_up_overdue_receivable',
  INVESTIGATE_ANOMALY: 'investigate_anomaly',
  REDUCE_SLOW_MOVING_INVENTORY: 'reduce_slow_moving_inventory',
  REVIEW_SUPPLIER_PRICING: 'review_supplier_pricing',
  PREPARE_TAX_PAYMENT_REMINDER: 'prepare_tax_payment_reminder',
  REVIEW_CASH_SHORTAGE_RISK: 'review_cash_shortage_risk',
});

const CONFIDENCE_LABELS = Object.freeze({
  LOW: 'low_confidence',
  MEDIUM: 'medium_confidence',
  HIGH: 'high_confidence',
});

function confidenceLabel(confidence) {
  const value = Number(confidence || 0);
  if (value < 0.65) return CONFIDENCE_LABELS.LOW;
  if (value < 0.85) return CONFIDENCE_LABELS.MEDIUM;
  return CONFIDENCE_LABELS.HIGH;
}

module.exports = {
  RECOMMENDATION_KINDS,
  CONFIDENCE_LABELS,
  confidenceLabel,
};
