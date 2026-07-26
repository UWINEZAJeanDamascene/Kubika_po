const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  invoiceToApi,
  invoiceLineToApi,
  quotationToApi,
  purchaseOrderToApi,
  grnToApi,
  arReceiptAllocationToApi,
} = require('../utils/salesApMappers');

describe('Phase 5+6 sales/AP mappers', () => {
  test('invoiceToApi embeds lines and items alias', () => {
    const api = invoiceToApi({
      id: 'inv1',
      companyId: 'c1',
      referenceNo: 'INV-2026-00001',
      clientId: 'cl1',
      status: 'confirmed',
      currencyCode: 'RWF',
      exchangeRate: 1,
      subtotal: 1000,
      taxAmount: 180,
      totalAmount: 1180,
      amountPaid: 0,
      amountOutstanding: 1180,
      totalAEx: 0,
      totalB18: 0,
      totalDiscount: 0,
      invoiceDate: new Date(),
      dueDate: new Date(),
      stockDeducted: false,
      autoConfirm: false,
      payments: [],
      ebm: {},
      lines: [{
        id: 'l1',
        lineOrder: 0,
        productId: 'p1',
        productName: 'Widget',
        qty: 2,
        unitPrice: 500,
        discountPct: 0,
        taxRate: 18,
        taxCode: 'A',
        lineSubtotal: 1000,
        lineTax: 180,
        lineTotal: 1180,
        unitCost: 300,
        cogsAmount: 600,
        qtyCredited: 0,
      }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.lines).toHaveLength(1);
    expect(api.items).toHaveLength(1);
    expect(api.lines[0].quantity).toBe(2);
    expect(api.totalAmount).toBe('1180.00');
  });

  test('invoiceLineToApi preserves product populate shape', () => {
    const line = invoiceLineToApi({
      id: 'l1',
      productId: 'p1',
      product: { id: 'p1', name: 'A', sku: 'SKU1', unit: 'pcs' },
      qty: 1,
      unitPrice: 10,
      discountPct: 0,
      taxRate: 0,
      taxCode: 'A',
      lineSubtotal: 10,
      lineTax: 0,
      lineTotal: 10,
      unitCost: 5,
      cogsAmount: 5,
      qtyCredited: 0,
    });
    expect(line.product.name).toBe('A');
  });

  test('purchaseOrderToApi maps lines', () => {
    const api = purchaseOrderToApi({
      id: 'po1',
      companyId: 'c1',
      referenceNo: 'PO-2026-001',
      supplierId: 's1',
      orderDate: new Date(),
      status: 'approved',
      source: 'MANUAL',
      currencyCode: 'RWF',
      exchangeRate: 1,
      subtotal: 500,
      taxAmount: 90,
      totalAmount: 590,
      amountPaid: 0,
      balance: 590,
      paymentStatus: 'unpaid',
      payments: [],
      freight: {},
      ebm: {},
      lines: [{ id: 'pl1', lineOrder: 0, productId: 'p1', qtyOrdered: 10, qtyReceived: 0, unitCost: 50, taxRate: 18, taxAmount: 90, lineTotal: 590 }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.lines[0].qtyOrdered).toBe(10);
  });

  test('grnToApi AP fields as money strings', () => {
    const api = grnToApi({
      id: 'g1',
      companyId: 'c1',
      referenceNo: 'GRN-001',
      purchaseOrderId: 'po1',
      warehouseId: 'w1',
      supplierId: 's1',
      receivedDate: new Date(),
      status: 'confirmed',
      totalAmount: 590,
      balance: 590,
      amountPaid: 0,
      paymentStatus: 'pending',
      freight: {},
      ebm: {},
      lines: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.totalAmount).toBe('590.00');
  });

  test('arReceiptAllocationToApi', () => {
    const api = arReceiptAllocationToApi({
      id: 'a1',
      companyId: 'c1',
      receiptId: 'r1',
      invoiceId: 'inv1',
      amountAllocated: 500,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.amountAllocated).toBe('500.00');
  });
});

describe('document reference numbers', () => {
  const { withReferenceNo } = require('../utils/referenceNumbers');

  test('a caller-supplied number wins, under any legacy alias', async () => {
    const translate = withReferenceNo('INV', (d) => ({ companyId: d.company }), { model: 'invoice' });

    expect(await translate({ company: 'c1', referenceNo: 'INV-2026-00042' }))
      .toEqual({ companyId: 'c1', referenceNo: 'INV-2026-00042' });
    expect(await translate({ company: 'c1', invoiceNumber: 'MANUAL-7' }))
      .toEqual({ companyId: 'c1', referenceNo: 'MANUAL-7' });
  });

  test('a mapper that already emits the number is left alone', async () => {
    const translate = withReferenceNo('SO', () => ({ companyId: 'c1', referenceNo: 'SO-2026-00003' }));
    expect((await translate({})).referenceNo).toBe('SO-2026-00003');
  });

  test('without a company there is nothing to number against', async () => {
    const translate = withReferenceNo('INV', () => ({ companyId: null }));
    expect(await translate({})).toEqual({ companyId: null });
  });

  test('a custom field is honoured (StockTransfer.transferNumber)', async () => {
    const translate = withReferenceNo('TRF', (d) => ({ companyId: d.company }), { field: 'transferNumber' });
    expect(await translate({ company: 'c1', transferNumber: 'TRF-2026-00009' }))
      .toEqual({ companyId: 'c1', transferNumber: 'TRF-2026-00009' });
  });
});

describe('Phase 5+6 Neon integration', () => {
  const hasDb = Boolean(process.env.DATABASE_URL);

  (hasDb ? test : test.skip)('invoices table + index exist on Neon', async () => {
    const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
    await connectPrisma();
    const tables = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('invoices', 'invoice_lines')`,
    );
    expect(tables.length).toBeGreaterThanOrEqual(2);
    await disconnectPrisma();
  });

  (hasDb ? test : test.skip)('purchase_orders table exists on Neon', async () => {
    const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
    await connectPrisma();
    const tables = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('purchase_orders', 'goods_received_notes')`,
    );
    expect(tables.length).toBeGreaterThanOrEqual(2);
    await disconnectPrisma();
  });

  (hasDb ? test : test.skip)('ar_receipt_allocations table exists on Neon', async () => {
    const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
    await connectPrisma();
    const tables = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ar_receipt_allocations'`,
    );
    expect(tables.length).toBe(1);
    await disconnectPrisma();
  });
});
