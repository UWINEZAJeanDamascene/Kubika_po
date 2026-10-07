const {
  buildReturnLines,
  calculateReturnTotals,
  validateReturnSerialNumbers,
} = require('../utils/purchaseReturnRules');
const {
  normalizeGRNLinesFromPurchaseOrder,
} = require('../utils/purchaseReceiptRules');

describe('purchase return rules', () => {
  const grn = {
    lines: [{
      _id: 'grn-line-1',
      product: 'product-1',
      qtyReceived: 10,
      unitCost: 25,
      taxRate: 18,
    }],
  };

  test('uses the source GRN price and limits returns to the unreturned quantity', () => {
    const confirmedReturns = [{
      _id: 'return-1',
      lines: [{ grnLine: 'grn-line-1', qtyReturned: 3 }],
    }];

    const lines = buildReturnLines(grn, [{
      grnLine: 'grn-line-1',
      product: 'product-1',
      qtyReturned: 4,
      unitCost: 0.01,
      serialNumbers: [],
    }], confirmedReturns);

    expect(lines).toEqual([{
      grnLine: 'grn-line-1',
      product: 'product-1',
      qtyReturned: 4,
      unitCost: 25,
      serialNumbers: [],
    }]);
    expect(calculateReturnTotals(grn, lines)).toEqual({
      subtotal: 100,
      taxAmount: 18,
      totalAmount: 118,
    });
  });

  test('rejects duplicate, mismatched, invalid, and excessive GRN lines', () => {
    const validLine = { grnLine: 'grn-line-1', product: 'product-1', qtyReturned: 1 };

    expect(() => buildReturnLines(grn, [validLine, validLine])).toThrow(/once/);
    expect(() => buildReturnLines(grn, [{ ...validLine, product: 'other-product' }])).toThrow(/does not match/);
    expect(() => buildReturnLines(grn, [{ ...validLine, qtyReturned: 0 }])).toThrow(/greater than zero/);
    expect(() => buildReturnLines(grn, [{ ...validLine, qtyReturned: 8 }], [{
      lines: [{ grnLine: 'grn-line-1', qtyReturned: 3 }],
    }])).toThrow(/unreturned GRN quantity/);
  });

  test('normalizes serial selections and rejects duplicate serials', () => {
    const lines = buildReturnLines(grn, [{
      grnLine: 'grn-line-1',
      qtyReturned: 2,
      serialNumbers: [' sn-001 ', 'Sn-002'],
    }]);
    expect(lines[0].serialNumbers).toEqual(['SN-001', 'SN-002']);
    expect(() => buildReturnLines(grn, [{
      grnLine: 'grn-line-1',
      qtyReturned: 2,
      serialNumbers: ['SN-001', 'sn-001'],
    }])).toThrow(/only appear once/);
  });

  test('requires distinct serials from the source GRN for each returned unit', () => {
    const sourceLine = { serialNumbers: ['SN-001', 'SN-002'] };
    expect(validateReturnSerialNumbers(sourceLine, 2, ['sn-001', 'Sn-002'])).toEqual(['SN-001', 'SN-002']);
    expect(() => validateReturnSerialNumbers(sourceLine, 2, ['SN-001'])).toThrow(/one available serial/);
    expect(() => validateReturnSerialNumbers(sourceLine, 1, ['SN-003'])).toThrow(/source GRN line/);
  });
});

describe('GRN receipt rules', () => {
  const purchaseOrder = {
    lines: [{
      _id: 'po-line-1',
      product: 'product-1',
      qtyOrdered: 10,
      qtyReceived: 4,
      unitCost: 25,
      taxRate: 18,
    }],
  };

  test('binds receipt line product, cost, and tax to the approved order', () => {
    expect(normalizeGRNLinesFromPurchaseOrder(purchaseOrder, [{
      purchaseOrderLine: 'po-line-1',
      product: 'product-1',
      qtyReceived: 2,
      unitCost: 0.01,
      taxRate: 0,
    }])).toEqual([{
      product: 'product-1',
      purchaseOrderLine: 'po-line-1',
      qtyReceived: 2,
      unitCost: 25,
      landedUnitCost: null,
      taxRate: 18,
      batchNo: undefined,
      serialNumbers: [],
      manufactureDate: null,
      expiryDate: null,
    }]);
  });

  test('rejects unlinked, duplicate, and over-received purchase order lines', () => {
    const validLine = { purchaseOrderLine: 'po-line-1', product: 'product-1', qtyReceived: 1 };

    expect(() => normalizeGRNLinesFromPurchaseOrder(purchaseOrder, [{
      ...validLine,
      purchaseOrderLine: 'other-line',
    }])).toThrow(/reference a line/);
    expect(() => normalizeGRNLinesFromPurchaseOrder(purchaseOrder, [validLine, validLine])).toThrow(/once/);
    expect(() => normalizeGRNLinesFromPurchaseOrder(purchaseOrder, [{
      ...validLine,
      qtyReceived: 7,
    }])).toThrow(/exceeds remaining/);
  });
});
