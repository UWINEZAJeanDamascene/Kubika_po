const { buildInvoiceTaxCorrection } = require('../utils/invoiceDeliveryNoteTax');

describe('invoice tax correction from delivery note', () => {
  test('builds tax correction plan using linked delivery note tax snapshots', () => {
    const plan = buildInvoiceTaxCorrection({
      subtotal: 1000,
      taxAmount: 0,
      lines: [{
        _id: 'invoice-line-1',
        product: 'product-1',
        qty: 2,
        unitPrice: 500,
        lineSubtotal: 1000,
        lineTax: 0,
      }],
    }, {
      lines: [{
        invoiceLineId: 'invoice-line-1',
        product: 'product-1',
        qtyToDeliver: 2,
        unitPrice: 500,
        lineSubtotal: 1000,
        taxRate: 18,
        taxCode: 'B',
        lineTax: 180,
      }],
    });

    expect(plan).toEqual({
      lines: [{
        id: 'invoice-line-1',
        lineSubtotal: 1000,
        taxRate: 18,
        taxCode: 'B',
        lineTax: 180,
        lineTotal: 1180,
      }],
      subtotal: 1000,
      taxAmount: 180,
      totalAmount: 1180,
      taxDelta: 180,
      originalTax: 0,
      totalAEx: 0,
      totalB18: 1000,
    });
  });

  test('rejects mismatched invoice and delivery note subtotals', () => {
    expect(() => buildInvoiceTaxCorrection({
      subtotal: 900,
      taxAmount: 0,
      lines: [{
        _id: 'invoice-line-1',
        product: 'product-1',
        qty: 2,
        unitPrice: 450,
        lineSubtotal: 900,
        lineTax: 0,
      }],
    }, {
      lines: [{
        invoiceLineId: 'invoice-line-1',
        product: 'product-1',
        qtyToDeliver: 2,
        unitPrice: 500,
        lineSubtotal: 1000,
        taxRate: 18,
        lineTax: 180,
      }],
    })).toThrow('Delivery note subtotal differs from the confirmed invoice');
  });

  test('rejects ambiguous product-and-quantity matches', () => {
    const invoice = {
      subtotal: 2000,
      taxAmount: 0,
      lines: ['invoice-line-1', 'invoice-line-2'].map((_id) => ({
        _id,
        product: 'product-1',
        qty: 2,
        unitPrice: 500,
        lineSubtotal: 1000,
      })),
    };
    const note = {
      lines: [
        { product: 'product-1', qtyToDeliver: 2, unitPrice: 500, lineSubtotal: 1000, taxRate: 18 },
        { product: 'product-1', qtyToDeliver: 2, unitPrice: 500, lineSubtotal: 1000, taxRate: 18 },
      ],
    };

    expect(() => buildInvoiceTaxCorrection(invoice, note))
      .toThrow('Could not uniquely match every invoice line to its delivery note line.');
  });
});
