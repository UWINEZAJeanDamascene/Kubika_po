'use strict';

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
jest.mock('../models/PurchaseOrder', () => ({ create: jest.fn(), findOne: jest.fn() }));

const { dbClient } = require('../lib/prisma');
const PurchaseOrder = require('../models/PurchaseOrder');
const service = require('../services/purchaseOrderService');

describe('AI purchase order draft ERP service', () => {
  const db = {
    supplier: { findFirst: jest.fn() },
    product: { findMany: jest.fn() },
    warehouse: { findFirst: jest.fn() },
  };
  const payload = {
    supplierId: 'supplier_1',
    warehouseId: 'warehouse_1',
    currencyCode: 'RWF',
    lines: [{ productId: 'product_1', quantity: 3, unitCost: 120, taxRate: 18 }],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    dbClient.mockReturnValue(db);
    PurchaseOrder.findOne.mockResolvedValue(null);
    db.supplier.findFirst.mockResolvedValue({ id: 'supplier_1' });
    db.product.findMany.mockResolvedValue([{ id: 'product_1' }]);
    db.warehouse.findFirst.mockResolvedValue({ id: 'warehouse_1' });
    PurchaseOrder.create.mockResolvedValue({ _id: 'po_1', referenceNo: 'PO-2026-00001' });
  });

  test('validates tenant-owned ERP references and creates only a draft PO without side effects', async () => {
    const result = await service.createAIDraft({
      companyId: 'company_1',
      createdBy: 'user_1',
      proposalId: 'proposal_1',
      payload,
    });

    expect(db.supplier.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'supplier_1', companyId: 'company_1', isActive: true },
    }));
    expect(db.product.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: 'company_1', isActive: true, isArchived: false, isStockable: true }),
    }));
    expect(db.warehouse.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'warehouse_1', companyId: 'company_1', isActive: true },
    }));
    expect(PurchaseOrder.create).toHaveBeenCalledWith(expect.objectContaining({
      company: 'company_1',
      createdBy: 'user_1',
      supplier: 'supplier_1',
      status: 'draft',
      source: 'AI_PROPOSAL',
      aiProposalId: 'proposal_1',
      subtotal: 360,
      taxAmount: 64.8,
      totalAmount: 424.8,
      balance: 424.8,
      lines: [{ product: 'product_1', qtyOrdered: 3, unitCost: 120, taxRate: 18, taxAmount: 64.8, lineTotal: 424.8 }],
    }));
    expect(result._id).toBe('po_1');
  });

  test('returns the existing tenant PO for the same proposal on retry', async () => {
    PurchaseOrder.findOne.mockResolvedValue({ _id: 'po_existing', referenceNo: 'PO-2026-00001' });

    const result = await service.createAIDraft({
      companyId: 'company_1', createdBy: 'user_1', proposalId: 'proposal_1', payload,
    });

    expect(result._id).toBe('po_existing');
    expect(PurchaseOrder.create).not.toHaveBeenCalled();
  });

  test('blocks references that are not active records in the current company', async () => {
    db.supplier.findFirst.mockResolvedValue(null);

    await expect(service.createAIDraft({
      companyId: 'company_1', createdBy: 'user_1', proposalId: 'proposal_1', payload,
    })).rejects.toThrow('outside this company');
    expect(PurchaseOrder.create).not.toHaveBeenCalled();
  });
});
