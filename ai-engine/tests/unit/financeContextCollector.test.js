'use strict';

jest.mock('../../context-builder/toolRunner', () => ({
  runTool: jest.fn(),
}));

const { runTool } = require('../../context-builder/toolRunner');
const financeCollector = require('../../context-builder/collectors/FinanceContextCollector');

const toolResults = {
  get_bank_accounts: { totalBalance: 900_000, accounts: [] },
  get_profit_loss_summary: { revenue: 0, cogs: 0, netProfit: 0 },
  get_executive_financial_summary: {
    revenue: 1_000_000,
    expenses: 1_526_800,
    netProfit: -526_800,
    netMarginPercent: -52.68,
    currency: 'RWF',
    period: { start: '2026-10-01', end: '2026-10-02', kind: 'current_month', isFallback: false },
  },
  get_cash_flow_summary: { bankBalance: 900_000 },
  get_cash_flow_history: { monthly: [] },
  get_balance_sheet: { totalAssets: 900_000, totalLiabilities: 1_000, totalEquity: 0 },
  get_fixed_assets: {
    count: 1,
    totalCost: 10_000,
    totalDepreciation: 0,
    netBookValue: 10_000,
    assets: [{ id: 'asset_1', name: 'Office laptop', cost: 10_000, netBookValue: 10_000, status: 'in_transit' }],
  },
  get_loans: {
    count: 1,
    totalOutstanding: 1_000,
    loans: [{ id: 'loan_1', name: 'Working capital loan', outstandingBalance: 1_000, status: 'active' }],
  },
  get_ap_payments: { payments: [] },
};

describe('Finance context position facts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runTool.mockImplementation(async (_companyId, toolName) => ({ result: toolResults[toolName] }));
  });

  test('uses dashboard-sourced facts for current revenue, expense, and profit questions', async () => {
    const context = await financeCollector.collect({
      companyId: 'company_1',
      user: { permissions: ['reports.read'] },
      query: 'What is the current revenue, expenses, and profit position?',
    });
    const fact = context.facts.find((entry) => entry.label === 'Executive dashboard financial position');

    expect(runTool).toHaveBeenCalledWith('company_1', 'get_executive_financial_summary', {});
    expect(runTool).not.toHaveBeenCalledWith('company_1', 'get_profit_loss_summary', expect.anything());
    expect(fact.value).toEqual(toolResults.get_executive_financial_summary);
    expect(fact.permissions).toEqual(['reports.read']);
  });

  test('includes ledger, fixed-asset, and liability register facts for position questions', async () => {
    const context = await financeCollector.collect({
      companyId: 'company_1',
      user: { role: 'admin' },
      query: 'What is the asset and liability position?',
    });
    const factsByLabel = new Map(context.facts.map((fact) => [fact.label, fact]));

    expect(factsByLabel.get('General ledger balance sheet position').value.totalAssets).toBe(900_000);
    expect(factsByLabel.get('Fixed asset register position').value.netBookValue).toBe(10_000);
    expect(factsByLabel.get('Loan and liability register position').value.totalOutstanding).toBe(1_000);
  });

  test('does not fetch asset and liability registers for ordinary cash questions', async () => {
    await financeCollector.collect({
      companyId: 'company_1',
      user: { role: 'admin' },
      query: 'What is the current cash balance?',
    });

    expect(runTool).not.toHaveBeenCalledWith('company_1', 'get_fixed_assets', expect.anything());
    expect(runTool).not.toHaveBeenCalledWith('company_1', 'get_loans', expect.anything());
  });
});