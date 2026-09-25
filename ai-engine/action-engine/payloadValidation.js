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
    if (typeof payload.supplierId !== 'string' || !payload.supplierId.trim()) errors.push('supplierId is required');
    const lines = payload.lines ?? payload.items;
    if (!Array.isArray(lines) || lines.length === 0) errors.push('lines must contain at least one item');
    if (Array.isArray(lines)) lines.forEach((line, index) => {
      if (!line || typeof line !== 'object' || Array.isArray(line)) errors.push(`lines[${index}] must be an object`);
      else {
        if (typeof (line.productId || line.product) !== 'string' || !(line.productId || line.product).trim()) errors.push(`lines[${index}].productId is required`);
        const quantity = Number(line.qtyOrdered ?? line.quantity ?? line.qty);
        if (!Number.isFinite(quantity) || quantity <= 0) errors.push(`lines[${index}].quantity must be greater than zero`);
        if (line.unitCost != null && (!Number.isFinite(Number(line.unitCost)) || Number(line.unitCost) < 0)) errors.push(`lines[${index}].unitCost must be zero or greater`);
      }
    });
  }

  if (type === PROPOSAL_TYPES.PAYMENT_REMINDER_DRAFT || type === PROPOSAL_TYPES.CUSTOMER_FOLLOW_UP_TASK) {
    if (typeof payload.customerId !== 'string' || !payload.customerId.trim()) errors.push('customerId is required');
    if (payload.message != null && String(payload.message).length > 2000) {
      errors.push('message must be 2000 characters or less');
    }
  }

  if (type === PROPOSAL_TYPES.STOCK_ADJUSTMENT_REVIEW) {
    if (!Array.isArray(payload.adjustments) || payload.adjustments.length === 0) errors.push('adjustments must contain at least one item');
    if (Array.isArray(payload.adjustments)) {
      payload.adjustments.forEach((adjustment, index) => {
        if (!adjustment || typeof adjustment !== 'object' || Array.isArray(adjustment)) errors.push(`adjustments[${index}] must be an object`);
        if (adjustment && (typeof (adjustment.productId || adjustment.product) !== 'string' || !(adjustment.productId || adjustment.product).trim())) errors.push(`adjustments[${index}].productId is required`);
        if (adjustment && (!Number.isFinite(Number(adjustment.quantity)) || Number(adjustment.quantity) === 0)) {
          errors.push(`adjustments[${index}].quantity must be a non-zero number`);
        }
      });
    }
  }

  if (type === PROPOSAL_TYPES.SUPPLIER_FOLLOW_UP_TASK
    && (typeof payload.supplierId !== 'string' || !payload.supplierId.trim())) errors.push('supplierId is required');

  if ([PROPOSAL_TYPES.SUPPLIER_FOLLOW_UP_TASK, PROPOSAL_TYPES.CUSTOMER_FOLLOW_UP_TASK].includes(type)
    && payload.title != null && (typeof payload.title !== 'string' || payload.title.trim().length === 0 || payload.title.length > 200)) {
    errors.push('title must be a non-empty string of 200 characters or less');
  }

  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 64 * 1024) errors.push('payload must be 64 KB or less');

  return errors;
}

module.exports = {
  validatePayload,
};
