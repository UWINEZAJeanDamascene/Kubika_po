const { buildReceiptPlan } = require('../utils/stockTransferLifecycle');

describe('stock transfer receipt validation', () => {
  test('records receiver-confirmed quantity and computes shortages/excesses', () => {
    const lines = [
      { _id: 'line-1', qty: 5 },
      { _id: 'line-2', qty: 2 },
    ];

    expect(buildReceiptPlan(lines, [
      { lineId: 'line-2', qtyReceived: 3 },
      { lineId: 'line-1', qtyReceived: 4 },
    ]).map((plan) => plan.varianceQty)).toEqual([-1, 1]);
  });

  test('requires one unique receipt record for every transfer line', () => {
    expect(() => buildReceiptPlan([{ _id: 'line-1', qty: 1 }], [])).toThrow(/each transfer line/);
    expect(() => buildReceiptPlan([{ _id: 'line-1', qty: 1 }], [
      { lineId: 'line-1', qtyReceived: 1 },
      { lineId: 'line-1', qtyReceived: 1 },
    ])).toThrow(/unique/);
  });

  test('confirms that received serial identity came with the transfer', () => {
    const line = {
      _id: 'line-serial',
      qty: 2,
      trackSerialNumbers: true,
      inventoryIdentity: { serialNumbers: ['sn-1', 'sn-2'] },
    };
    expect(buildReceiptPlan([line], [{
      lineId: 'line-serial',
      qtyReceived: 1,
      serialNumbers: ['SN-1'],
    }])[0].serialNumbers).toEqual(['SN-1']);
    expect(() => buildReceiptPlan([line], [{
      lineId: 'line-serial',
      qtyReceived: 1,
      serialNumbers: ['SN-3'],
    }])).toThrow(/match the dispatched serials/);
  });

  test('confirms received batch identity and totals', () => {
    const line = {
      _id: 'line-batch',
      qty: 3,
      trackBatch: true,
      inventoryIdentity: { batches: [{ batchNumber: 'B-1', lotNumber: 'L-1', quantity: 3 }] },
    };
    expect(buildReceiptPlan([line], [{
      lineId: 'line-batch',
      qtyReceived: 2,
      batches: [{ batchNumber: 'b-1', lotNumber: 'l-1', quantity: 2 }],
    }])[0].receivedQty).toBe(2);
    expect(() => buildReceiptPlan([line], [{
      lineId: 'line-batch',
      qtyReceived: 2,
      batches: [{ batchNumber: 'B-2', lotNumber: 'L-2', quantity: 2 }],
    }])).toThrow(/match the dispatched batches/);
  });

  test('rejects negative, non-numeric and identity-mismatched receipts', () => {
    const line = { _id: 'line-1', qty: 2 };
    expect(() => buildReceiptPlan([line], [{ lineId: 'line-1', qtyReceived: -1 }])).toThrow(/non-negative/);
    expect(() => buildReceiptPlan([line], [{ lineId: 'line-1', qtyReceived: 'bad' }])).toThrow(/non-negative/);
  });
});
