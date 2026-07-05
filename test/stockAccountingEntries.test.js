const JournalService = require('../services/journalService');
const {
  DEFAULT_ACCOUNTS,
  canPostToAccount,
} = require('../constants/chartOfAccounts');

describe('stock accounting journal entries', () => {
  let createEntrySpy;

  beforeEach(() => {
    createEntrySpy = jest
      .spyOn(JournalService, 'createEntry')
      .mockImplementation(async (_companyId, _userId, entry) => entry);
  });

  afterEach(() => {
    createEntrySpy.mockRestore();
  });

  it('posts stock adjustment increases to inventory and stock adjustment gain', async () => {
    const entry = await JournalService.createStockAdjustmentEntry('company-1', 'user-1', {
      _id: 'movement-1',
      adjustmentAmount: 125,
      adjustmentType: 'increase',
      productName: 'Widget',
      reason: 'correction',
      date: new Date('2026-06-09T00:00:00Z'),
    });

    expect(entry.sourceType).toBe('stock_adjustment');
    expect(entry.lines).toEqual([
      expect.objectContaining({
        accountCode: DEFAULT_ACCOUNTS.inventory,
        debit: 125,
        credit: 0,
      }),
      expect.objectContaining({
        accountCode: DEFAULT_ACCOUNTS.stockAdjustmentGain,
        debit: 0,
        credit: 125,
      }),
    ]);
  });

  it('posts stock adjustment decreases to stock adjustment loss and inventory', async () => {
    const entry = await JournalService.createStockAdjustmentEntry('company-1', 'user-1', {
      _id: 'movement-2',
      adjustmentAmount: 90,
      adjustmentType: 'decrease',
      productName: 'Widget',
      reason: 'damage',
      date: new Date('2026-06-09T00:00:00Z'),
    });

    expect(entry.sourceType).toBe('stock_adjustment');
    expect(entry.lines).toEqual([
      expect.objectContaining({
        accountCode: DEFAULT_ACCOUNTS.stockAdjustmentLoss,
        debit: 90,
        credit: 0,
      }),
      expect.objectContaining({
        accountCode: DEFAULT_ACCOUNTS.inventory,
        debit: 0,
        credit: 90,
      }),
    ]);
  });

  it('keeps opening stock accounts on the balance sheet', () => {
    expect(canPostToAccount(DEFAULT_ACCOUNTS.inventory)).toMatchObject({
      valid: true,
      account: expect.objectContaining({ type: 'asset' }),
    });
    expect(canPostToAccount(DEFAULT_ACCOUNTS.openingBalanceEquity)).toMatchObject({
      valid: true,
      account: expect.objectContaining({ type: 'equity' }),
    });
  });
});
