jest.mock('../models/EBMCode', () => ({
  findOne: jest.fn(() => ({
    lean: jest.fn(async () => ({ code: 'M' })),
  })),
}));
const EBMStockService = require('../services/ebmStockService');

describe('EBM stock item payload', () => {
  it('includes RRA VSDC stock item discount, barcode, and expiry fields', () => {
    const payload = EBMStockService.__test__.buildItemPayload(
      {
        name: 'Batch Item',
        sku: 'ITEM-001',
        barcode: '1234567890123456789012345',
        taxCode: 'B',
        ebm: {
          ebmItemCode: 'RW1NTXU0000001',
          itemClassCd: '5059690800',
          pkgUnitCd: 'NI',
          qtyUnitCd: 'U',
          taxTyCd: 'B',
        },
      },
      {
        qty: 10,
        unitPrice: 3500,
        totalAmount: 35000,
        discount: 250,
        expiryDate: '2026-12-31',
      },
      1,
    );

    expect(payload).toMatchObject({
      itemSeq: 1,
      itemCd: 'RW1NTXU0000001',
      bcd: '12345678901234567890',
      itemExprDt: '20261231',
      totDcAmt: 250,
      taxTyCd: 'B',
      totAmt: 35000,
    });
  });

  it('uses required zero discount and nullable expiry when source values are absent', () => {
    const payload = EBMStockService.__test__.buildItemPayload(
      {
        name: 'No Batch Item',
        sku: 'ITEM-002',
        ebm: {
          itemClassCd: '5059690800',
          pkgUnitCd: 'NI',
          qtyUnitCd: 'U',
          taxTyCd: 'D',
        },
      },
      {
        qty: 1,
        unitPrice: 1000,
      },
      1,
    );

    expect(payload).toMatchObject({
      bcd: '',
      itemExprDt: null,
      totDcAmt: 0,
    });
  });

  it('uses allocated fiscal sarNo and rejects unallocated stock payloads', async () => {
    const product = {
      name: 'Fiscal Stock Item',
      sku: 'ITEM-003',
      ebm: {
        ebmItemCode: 'RW1NTXU0000003',
        itemClassCd: '5059690800',
        pkgUnitCd: 'NI',
        qtyUnitCd: 'U',
        taxTyCd: 'D',
      },
    };
    const company = {
      _id: 'company-1',
      name: 'Test Company',
      tax_identification_number: '999991130',
    };
    const branch = { rraBranchId: '00' };

    await expect(EBMStockService.__test__.buildMovementPayload(
      {
        referenceNo: 'ADJ-2026-0001',
        sarTyCd: '11',
        items: [{ product, qty: 1, unitPrice: 1000 }],
      },
      company,
      branch,
    )).rejects.toMatchObject({ code: 'EBM_STOCK_SAR_NO_MISSING' });

    const payload = await EBMStockService.__test__.buildMovementPayload(
      {
        sarNo: 41,
        referenceNo: 'ADJ-2026-0001',
        sarTyCd: '11',
        items: [{ product, qty: 1, unitPrice: 1000 }],
      },
      company,
      branch,
    );

    expect(payload.sarNo).toBe(41);
  });

  it('classifies stock master reconciliation rows against VSDC residual quantities', () => {
    const comparison = EBMStockService.__test__.buildStockReconciliationRows(
      [
        { _id: 'p1', name: 'Matched', sku: 'SKU1', currentStock: 5, ebm: { ebmItemCode: 'RW1NTXU0000001' } },
        { _id: 'p2', name: 'Different', sku: 'SKU2', currentStock: 9, ebm: { ebmItemCode: 'RW1NTXU0000002' } },
        { _id: 'p3', name: 'Local Only', sku: 'SKU3', currentStock: 4, ebm: { ebmItemCode: 'RW1NTXU0000003' } },
      ],
      [
        { itemCd: 'RW1NTXU0000001', itemNm: 'Matched', rsdQty: 5, bhfId: '00' },
        { itemCd: 'RW1NTXU0000002', itemNm: 'Different', rsdQty: 6, bhfId: '00' },
        { itemCd: 'RW1NTXU0000004', itemNm: 'RRA Only', rsdQty: 2, bhfId: '00' },
      ],
      '00',
    );

    expect(comparison.summary).toMatchObject({
      total: 4,
      matched: 1,
      discrepancy: 1,
      missing_vsdc: 1,
      missing_local: 1,
    });
    expect(comparison.rows.find((row) => row.itemCd === 'RW1NTXU0000002')).toMatchObject({
      status: 'discrepancy',
      localQty: 9,
      vsdcQty: 6,
      difference: 3,
    });
  });
});
