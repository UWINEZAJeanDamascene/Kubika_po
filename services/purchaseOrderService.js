'use strict';

const PurchaseOrder = require('../models/PurchaseOrder');
const { dbClient } = require('../lib/prisma');
const { validatePayload } = require('../ai-engine/action-engine/payloadValidation');
const { PROPOSAL_TYPES } = require('../ai-engine/action-engine/actionTypes');

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/** Create the ERP purchase-order draft produced by an approved AI proposal. */
async function createAIDraft({ companyId, createdBy, proposalId, payload }) {
  const company = String(companyId || '');
  const creator = String(createdBy || '');
  const proposal = String(proposalId || '');
  const validationErrors = validatePayload(PROPOSAL_TYPES.PURCHASE_ORDER_DRAFT, payload || {});
  if (!company || !creator || !proposal) throw fail('Company, creator, and proposal IDs are required');
  if (validationErrors.length) throw fail(`Invalid purchase order proposal: ${validationErrors.join('; ')}`);

  const db = dbClient();
  const existing = await PurchaseOrder.findOne({ company, aiProposalId: proposal });
  if (existing) return existing;

  const supplierId = String(payload.supplierId);
  const supplier = await db.supplier.findFirst({
    where: { id: supplierId, companyId: company, isActive: true },
    select: { id: true },
  });
  if (!supplier) throw fail('Supplier is missing, inactive, or outside this company', 409);

  const rawLines = payload.lines || payload.items;
  const lines = rawLines.map((line) => ({
    productId: String(line.productId || line.product),
    quantity: Number(line.qtyOrdered ?? line.quantity ?? line.qty),
    unitCost: Number(line.unitCost ?? 0),
    taxRate: Number(line.taxRate ?? 0),
  }));
  if (lines.some((line) => !Number.isFinite(line.unitCost) || line.unitCost < 0
    || !Number.isFinite(line.taxRate) || line.taxRate < 0 || line.taxRate > 100)) {
    throw fail('Purchase order costs and tax rates must be valid non-negative numbers');
  }
  const amount2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
  const pricedLines = lines.map((line) => {
    const subtotal = amount2(line.quantity * line.unitCost);
    const taxAmount = amount2(subtotal * line.taxRate / 100);
    return { ...line, subtotal, taxAmount, lineTotal: amount2(subtotal + taxAmount) };
  });
  const subtotal = amount2(pricedLines.reduce((sum, line) => sum + line.subtotal, 0));
  const taxAmount = amount2(pricedLines.reduce((sum, line) => sum + line.taxAmount, 0));
  const totalAmount = amount2(subtotal + taxAmount);

  const currencyCode = String(payload.currencyCode || 'RWF').toUpperCase();
  const exchangeRate = Number(payload.exchangeRate ?? 1);
  if (!/^[A-Z]{3}$/.test(currencyCode) || !Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    throw fail('Currency code and exchange rate must be valid');
  }
  if (payload.expectedDeliveryDate != null && Number.isNaN(new Date(payload.expectedDeliveryDate).getTime())) {
    throw fail('Expected delivery date must be valid');
  }

  const productIds = [...new Set(lines.map((line) => line.productId))];
  const products = await db.product.findMany({
    where: { id: { in: productIds }, companyId: company, isActive: true, isArchived: false, isStockable: true },
    select: { id: true },
  });
  if (products.length !== productIds.length) {
    throw fail('One or more products are missing, inactive, non-stockable, or outside this company', 409);
  }

  const warehouseId = payload.warehouseId || payload.warehouse || null;
  if (warehouseId) {
    const warehouse = await db.warehouse.findFirst({
      where: { id: String(warehouseId), companyId: company, isActive: true },
      select: { id: true },
    });
    if (!warehouse) throw fail('Warehouse is missing, inactive, or outside this company', 409);
  }

  return PurchaseOrder.create({
    company,
    createdBy: creator,
    supplier: supplier.id,
    warehouse: warehouseId ? String(warehouseId) : undefined,
    status: 'draft',
    source: 'AI_PROPOSAL',
    aiProposalId: proposal,
    currencyCode,
    exchangeRate,
    subtotal,
    taxAmount,
    totalAmount,
    balance: totalAmount,
    amountPaid: 0,
    paymentStatus: 'unpaid',
    expectedDeliveryDate: payload.expectedDeliveryDate || undefined,
    notes: typeof payload.notes === 'string' ? payload.notes.slice(0, 2000) : 'Draft created from an approved AI proposal.',
    freight: {},
    lines: pricedLines.map((line) => ({
      product: line.productId,
      qtyOrdered: line.quantity,
      unitCost: line.unitCost,
      taxRate: line.taxRate,
      taxAmount: line.taxAmount,
      lineTotal: line.lineTotal,
    })),
  });
}

module.exports = { createAIDraft };
