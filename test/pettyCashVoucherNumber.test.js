jest.mock('../services/sequenceService', () => ({
  nextSequence: jest.fn(),
}));

const { nextSequence } = require('../services/sequenceService');
const {
  pettyCashTransactionToApi,
  pettyCashTransactionTranslateCreate,
} = require('../utils/bankingMappers');

describe('petty cash transaction voucher numbers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    nextSequence.mockResolvedValueOnce('00002').mockResolvedValueOnce('00008');
  });

  test('generates a consistent voucher for transactions without one', async () => {
    const result = await pettyCashTransactionTranslateCreate({
      company: 'company-id',
      float: 'float-id',
      type: 'top_up',
      amount: 100,
      balanceAfter: 500,
      createdBy: 'user-id',
    });

    expect(nextSequence).toHaveBeenNthCalledWith(1, 'company-id', 'petty_cash_transaction', {
      year: new Date().getFullYear(),
    });
    expect(nextSequence).toHaveBeenNthCalledWith(2, 'company-id', 'petty_cash_voucher', {
      year: new Date().getFullYear(),
    });
    expect(result).toMatchObject({
      referenceNo: `PCT-${new Date().getFullYear()}-00002`,
      voucherNumber: `PCV-${new Date().getFullYear()}-00008`,
    });
  });

  test('preserves the expense voucher passed to its transaction', async () => {
    const result = await pettyCashTransactionTranslateCreate({
      company: 'company-id',
      float: 'float-id',
      type: 'expense',
      referenceNo: 'PCT-2026-00002',
      voucherNumber: 'PCV-2026-00007',
      amount: -100,
      balanceAfter: 400,
      createdBy: 'user-id',
    });

    expect(result.voucherNumber).toBe('PCV-2026-00007');
    expect(nextSequence).toHaveBeenCalledTimes(0);
  });

  test('uses the transaction reference for legacy rows without a voucher', () => {
    const result = pettyCashTransactionToApi({
      id: 'transaction-id',
      companyId: 'company-id',
      floatId: 'float-id',
      referenceNo: 'PCT-2026-00001',
      voucherNumber: null,
      type: 'top_up',
      amount: 100,
      balanceAfter: 100,
    });

    expect(result.voucherNumber).toBe('PCT-2026-00001');
  });
});
