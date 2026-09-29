'use strict';

jest.mock('../../../models/BankAccount', () => ({
  find: jest.fn(),
  computeBalanceFromTransactions: jest.fn(),
}));

jest.mock('../../../services/cashFlowService', () => ({
  generate: jest.fn(),
}));

const BankAccount = require('../../../models/BankAccount');
const CashFlowService = require('../../../services/cashFlowService');
const { executeTool, getCashFlowSummary } = require('../../../services/aiToolService');

function mockBankAccounts(accounts) {
  const query = {
    sort: jest.fn(),
    lean: jest.fn().mockResolvedValue(accounts),
  };
  query.sort.mockReturnValue(query);
  BankAccount.find.mockReturnValue(query);
}

function mockCashFlowReport() {
  CashFlowService.generate.mockResolvedValue({
    current: {
      operating: { total_inflows: 0, total_outflows: 0 },
      investing: { total_inflows: 0, total_outflows: 0 },
      financing: { total_inflows: 1_000_000, total_outflows: 100_000 },
      opening_cash_balance: 0,
      closing_cash_balance: 900_000,
      net_change_in_cash: 900_000,
      is_reconciled: true,
      reconciliation_diff: 0,
    },
  });
}

describe('AI finance tools use authoritative cash data', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBankAccounts([{
      _id: 'account_1',
      name: 'Saving account',
      accountType: 'bk_bank',
      currencyCode: 'RWF',
      openingBalance: 0,
      cachedBalance: -100_000,
    }]);
    BankAccount.computeBalanceFromTransactions.mockResolvedValue(900_000);
    mockCashFlowReport();
  });

  test('uses transaction-derived balances instead of stale cached balances', async () => {
    const result = await executeTool('company_1', 'get_bank_accounts');

    expect(BankAccount.find).toHaveBeenCalledWith({ company: 'company_1', isActive: true });
    expect(BankAccount.computeBalanceFromTransactions).toHaveBeenCalledWith('account_1', 0);
    expect(result.totalBalance).toBe(900_000);
    expect(result.accounts[0].balance).toBe(900_000);
  });

  test('uses IAS 7 report values for cash flow summary', async () => {
    const result = await getCashFlowSummary('company_1', {
      startDate: '2026-01-01',
      endDate: '2026-09-29',
    });

    expect(CashFlowService.generate).toHaveBeenCalledWith('company_1', {
      dateFrom: '2026-01-01',
      dateTo: '2026-09-29',
    });
    expect(result).toEqual(expect.objectContaining({
      bankBalance: 900_000,
      cashIn: 1_000_000,
      cashOut: 100_000,
      netCashFlow: 900_000,
      openingBalance: 0,
      closingBalance: 900_000,
      isReconciled: true,
    }));
  });
});