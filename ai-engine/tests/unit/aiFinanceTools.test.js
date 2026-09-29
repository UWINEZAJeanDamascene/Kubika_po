'use strict';

jest.mock('../../../models/BankAccount', () => ({
  find: jest.fn(),
  computeBalanceFromTransactions: jest.fn(),
}));

jest.mock('../../../models/Purchase', () => ({
  find: jest.fn(),
}));

jest.mock('../../../services/cashFlowService', () => ({
  generate: jest.fn(),
}));

jest.mock('../../../lib/prisma', () => ({
  dbClient: jest.fn(),
}));

const BankAccount = require('../../../models/BankAccount');
const Purchase = require('../../../models/Purchase');
const CashFlowService = require('../../../services/cashFlowService');
const { dbClient } = require('../../../lib/prisma');
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
    dbClient.mockReturnValue({
      invoice: {
        aggregate: jest.fn().mockResolvedValue({
          _count: { _all: 2 },
          _sum: { totalAmount: 1400, amountPaid: 1400, amountOutstanding: 0 },
        }),
      },
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ period: '2026-09', revenue: 1400, count: 2 }])
        .mockResolvedValueOnce([]),
    });
  });

  test('uses purchase totals, supplier, and purchase date from canonical fields', async () => {
    const query = {
      populate: jest.fn(),
      sort: jest.fn(),
      limit: jest.fn(),
      lean: jest.fn().mockResolvedValue([{
        _id: 'purchase_1',
        purchaseNumber: 'PO-2026-00001',
        supplier: { name: 'Win Winn' },
        totalAmount: 64_900_000,
        amountPaid: 900_000,
        balance: 64_000_000,
        status: 'received',
        purchaseDate: '2026-09-15T00:00:00.000Z',
        createdAt: '2026-09-29T00:00:00.000Z',
      }]),
    };
    query.populate.mockReturnValue(query);
    query.sort.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    Purchase.find.mockReturnValue(query);

    const result = await executeTool('company_1', 'get_purchases', {
      startDate: '2026-09-01',
      endDate: '2026-09-30',
    });

    expect(Purchase.find).toHaveBeenCalledWith({
      company: 'company_1',
      purchaseDate: { $gte: new Date('2026-09-01'), $lte: new Date('2026-09-30') },
    });
    expect(query.sort).toHaveBeenCalledWith({ purchaseDate: -1 });
    expect(result.purchases[0]).toEqual(expect.objectContaining({
      supplier: 'Win Winn',
      total: 64_900_000,
      balance: 64_000_000,
      date: '2026-09-15',
    }));
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

  test('includes fully paid invoices in AI sales revenue summaries', async () => {
    const result = await executeTool('company_1', 'get_sales_summary', {
      startDate: '2026-09-01',
      endDate: '2026-09-29',
    });
    const invoiceFilter = dbClient().invoice.aggregate.mock.calls[0][0].where.status.in;

    expect(invoiceFilter).toContain('fully_paid');
    expect(invoiceFilter).toContain('partially_paid');
    expect(result).toEqual(expect.objectContaining({ totalInvoices: 2, totalRevenue: 1400, totalPaid: 1400 }));
  });
});