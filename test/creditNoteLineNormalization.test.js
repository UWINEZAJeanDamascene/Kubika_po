const { normalizeCreditNoteLines } = require('../utils/creditNoteLineNormalization');

const invoice = {
  lines: [
    {
      _id: 'line-1',
      product: { _id: 'product-1', name: 'Tracked item', isStockable: true },
      qty: 5,
      qtyCredited: 0,
      unitPrice: 100,
      taxRate: 18,
      unitCost: 50,
    },
    {
      _id: 'line-2',
      product: { _id: 'product-2', name: 'Other item', isStockable: true },
      qty: 10,
      qtyCredited: 0,
      unitPrice: 200,
      taxRate: 18,
      unitCost: 100,
    },
  ],
};

describe('credit note line normalization', () => {
  test('ignores zero-quantity rows while retaining positive credit lines', () => {
    const lines = normalizeCreditNoteLines(invoice, [
      { invoiceLineId: 'line-1', quantity: 0 },
      { invoiceLineId: 'line-2', quantity: 3, returnToWarehouse: 'warehouse-1' },
    ], 'goods_return');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      invoiceLineId: 'line-2',
      quantity: 3,
      lineSubtotal: 600,
      returnToWarehouse: 'warehouse-1',
    });
  });

  test('rejects a credit note when every line has zero quantity', () => {
    expect(() => normalizeCreditNoteLines(invoice, [
      { invoiceLineId: 'line-1', quantity: 0 },
      { invoiceLineId: 'line-2', quantity: 0 },
    ], 'goods_return')).toThrow('Add at least one invoice line and enter the quantity to credit.');
  });

  test('still rejects quantities above the remaining invoice quantity', () => {
    expect(() => normalizeCreditNoteLines(invoice, [
      { invoiceLineId: 'line-1', quantity: 6 },
    ], 'price_adjustment')).toThrow('no more than the 5 remaining');
  });
});
