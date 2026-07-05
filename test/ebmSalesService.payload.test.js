jest.mock('../models/EBMCode', () => ({
  find: jest.fn((query) => {
    const className = String(query?.codeClassName?.$regex || '').toLowerCase();
    const codeByClass = {
      payment: { code: '02', name: 'Credit', description: 'Credit' },
      receipt: { code: 'S', name: 'Sale', description: 'Sale receipt' },
      transaction: { code: 'N', name: 'Normal', description: 'Normal sale' },
      currency: { code: 'RWF', name: 'Rwandan franc', description: 'Rwandan franc' },
      country: { code: 'RW', name: 'Rwanda', description: 'Rwanda' },
    };
    const result = Object.entries(codeByClass)
      .filter(([key]) => className.includes(key))
      .map(([, value]) => value);

    return {
      sort: jest.fn(() => ({
        lean: jest.fn(async () => result),
      })),
    };
  }),
}));

const { buildSalesTrnPayload } = require('../services/ebmSalesService');

describe('EBM sales payload', () => {
  it('uses RRA VSDC sales fields and date formats', async () => {
    const payload = await buildSalesTrnPayload(
      {
        company: 'company-1',
        referenceNo: '1001',
        customerTin: '999991130',
        invoiceDate: new Date('2026-06-04T10:00:00Z'),
        createdAt: new Date('2026-06-04T10:00:00Z'),
        ebm: {
          invcNo: 1001,
          curRcptNo: 2001,
          totRcptNo: 2001,
          rptNo: 3001,
        },
        deliveryNote: { status: 'dispatched' },
        lpoNumber: 'LPO-123456',
        currencyCode: 'USD',
        exchangeRate: 1300,
        items: [
          {
            quantity: 1,
            unitPrice: 1180,
            lineTotal: 1180,
            product: {
              name: 'Test Item',
              sku: 'ITEM-001',
              ebm: {
                ebmItemCode: 'ITEM-001',
                itemClassCd: '50202200',
                taxTyCd: 'B',
                pkgUnitCd: 'NT',
                qtyUnitCd: 'U',
              },
            },
          },
        ],
      },
      {
        _id: 'company-1',
        name: 'Test Company',
        tax_identification_number: '999991130',
      },
      {
        rraBranchId: '00',
      },
    );

    expect(payload.salesSttsCd).toBe('02');
    expect(payload.pmtTyCd).toBe('02');
    expect(payload.prcOrdCd).toBe('LPO-1');
    expect(payload).not.toHaveProperty('invcSttsCd');
    expect(payload).not.toHaveProperty('saleCtyCd');
    expect(payload).not.toHaveProperty('lpoNumber');
    expect(payload).not.toHaveProperty('currencyTyCd');
    expect(payload).not.toHaveProperty('exchangeRt');
    expect(payload).not.toHaveProperty('payList');
    expect(payload.salesDt).toMatch(/^\d{8}$/);
    expect(payload.cfmDt).toMatch(/^\d{14}$/);
    expect(payload.invcNo).toBe('1001');
    expect(payload.receipt.curRcptNo).toBe(2001);
    expect(payload.receipt.totRcptNo).toBe(2001);
    expect(payload.receipt.rptNo).toBe(3001);
    expect(payload.receipt.rcptPbctDt).toMatch(/^\d{14}$/);
    expect(payload.receipt.totItemCnt).toBe(1);
    expect(payload.prchrAcptcYn).toBe('N');
    expect(payload.receipt.prchrAcptcYn).toBe('N');
    expect(payload.stockRlsDt).toBeNull();
    expect(payload.receipt).not.toHaveProperty('custTin');
    expect(payload.receipt).not.toHaveProperty('custMblNo');
    expect(payload.receipt).not.toHaveProperty('intrlData');
    expect(payload.receipt).not.toHaveProperty('rcptSign');
    expect(payload.receipt).not.toHaveProperty('sdcId');
  });

  it('uses delivery state for purchaser acceptance and EBM report number when present', async () => {
    const payload = await buildSalesTrnPayload(
      {
        company: 'company-1',
        referenceNo: '1002',
        invoiceDate: new Date('2026-06-04T10:00:00Z'),
        createdAt: new Date('2026-06-04T10:00:00Z'),
        deliveryNote: {
          status: 'delivered',
          actualDeliveryDate: new Date('2026-06-05T08:30:00Z'),
        },
        ebm: {
          invcNo: 1002,
          rptNo: 42,
          curRcptNo: 77,
          totRcptNo: 80,
        },
        items: [
          {
            quantity: 1,
            unitPrice: 1180,
            lineTotal: 1180,
            product: {
              name: 'Delivered Item',
              sku: 'ITEM-002',
              ebm: {
                ebmItemCode: 'ITEM-002',
                itemClassCd: '50202200',
                taxTyCd: 'B',
                pkgUnitCd: 'NT',
                qtyUnitCd: 'U',
              },
            },
          },
        ],
      },
      {
        _id: 'company-1',
        name: 'Test Company',
        tax_identification_number: '999991130',
      },
      {
        rraBranchId: '00',
      },
    );

    expect(payload.prchrAcptcYn).toBe('Y');
    expect(payload.receipt.prchrAcptcYn).toBe('Y');
    expect(payload.stockRlsDt).toMatch(/^20260605\d{6}$/);
    expect(payload.receipt.curRcptNo).toBe(77);
    expect(payload.receipt.totRcptNo).toBe(80);
    expect(payload.receipt.rptNo).toBe(42);
  });
});
