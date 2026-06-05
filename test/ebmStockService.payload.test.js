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
});
