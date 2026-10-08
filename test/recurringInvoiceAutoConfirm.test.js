jest.mock('../services/invoiceAutoConfirmService', () => ({
  confirmDraftInvoice: jest.fn(),
}));

const { canAutoConfirmTemplate } = require('../services/recurringService');

describe('recurring invoice auto-confirm eligibility', () => {
  test.each(['batch', 'serial'])('keeps %s-tracked stock invoices as drafts', (trackingType) => {
    expect(canAutoConfirmTemplate({
      lines: [{ product: { isStockable: true, trackingType } }],
    })).toBe(false);
  });

  test('allows auto-confirm for untracked and non-stock products', () => {
    expect(canAutoConfirmTemplate({
      lines: [
        { product: { isStockable: true, trackingType: 'none' } },
        { product: { isStockable: false, trackingType: 'serial' } },
      ],
    })).toBe(true);
  });
});
