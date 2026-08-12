'use strict';

const { PROPOSAL_TYPES } = require('./actionTypes');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePayload(type, payload = {}) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return ['payload must be an object'];
  }

  if (type === PROPOSAL_TYPES.PURCHASE_ORDER_DRAFT) {
    if (payload.supplierId != null && String(payload.supplierId).trim() === '') {
      errors.push('supplierId cannot be blank when provided');
    }
    if (payload.items != null && !Array.isArray(payload.items)) {
      errors.push('items must be an array when provided');
    }
  }

  if (type === PROPOSAL_TYPES.PAYMENT_REMINDER_DRAFT || type === PROPOSAL_TYPES.CUSTOMER_FOLLOW_UP_TASK) {
    if (payload.customerId != null && String(payload.customerId).trim() === '') {
      errors.push('customerId cannot be blank when provided');
    }
    if (payload.message != null && String(payload.message).length > 2000) {
      errors.push('message must be 2000 characters or less');
    }
  }

  if (type === PROPOSAL_TYPES.STOCK_ADJUSTMENT_REVIEW) {
    if (payload.adjustments != null && !Array.isArray(payload.adjustments)) {
      errors.push('adjustments must be an array when provided');
    }
    if (Array.isArray(payload.adjustments)) {
      payload.adjustments.forEach((adjustment, index) => {
        if (!adjustment || typeof adjustment !== 'object') errors.push(`adjustments[${index}] must be an object`);
        if (adjustment && adjustment.quantity != null && !Number.isFinite(Number(adjustment.quantity))) {
          errors.push(`adjustments[${index}].quantity must be numeric`);
        }
      });
    }
  }

  return errors;
}

module.exports = {
  validatePayload,
};
