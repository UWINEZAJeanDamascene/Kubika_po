'use strict';

jest.mock('../lib/prisma', () => ({
  dbClient: jest.fn(),
}));

jest.mock('../services/journalAggregationService', () => ({
  sumJournalLines: jest.fn(),
}));

const { dbClient } = require('../lib/prisma');
const journalAgg = require('../services/journalAggregationService');
const MonthlyReportsService = require('../services/monthlyReportsService');
const AnnualReportsService = require('../services/annualReportsService');

describe('Monthly report service regressions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sales by category, cash flow, and AP aging all return structured payloads', async () => {
    dbClient.mockReturnValue({
      chartOfAccount: {
        findMany: jest.fn().mockResolvedValue([
          { code: '1000', type: 'asset', name: 'Cash' },
          { code: '2000', type: 'liability', name: 'Payables' },
          { code: '3000', type: 'revenue', name: 'Sales' },
          { code: '4000', type: 'expense', name: 'Expenses' },
        ]),
      },
      $queryRaw: jest.fn((sql) => {
        const text = String(sql ?? '');
        if (text.includes('invoice_lines')) {
          return [{ category: 'Food', total_revenue: 1200, total_units: 6, gross_profit: 500 }];
        }
        if (text.includes('journal_entry_lines')) {
          return [{ balance: 2500 }];
        }
        return [];
      }),
      goodsReceivedNote: {
        findMany: jest.fn().mockResolvedValue([
          { supplierId: 'sup-1', supplier: { name: 'Supplier One' }, paymentDueDate: new Date('2026-08-01T00:00:00Z'), balance: 300 },
        ]),
      },
      purchaseOrder: {
        findMany: jest.fn().mockResolvedValue([
          { supplierId: 'sup-2', supplier: { name: 'Supplier Two' }, expectedDeliveryDate: new Date('2026-07-15T00:00:00Z'), balance: 250 },
        ]),
      },
    });

    journalAgg.sumJournalLines.mockResolvedValue([
      { _id: '3000', credit: 5000, debit: 0 },
      { _id: '4000', credit: 0, debit: 3500 },
      { _id: '1000', credit: 0, debit: 2000 },
      { _id: '2000', credit: 1000, debit: 0 },
    ]);

    const sales = await MonthlyReportsService.getSalesByCategory('company_1', 2026, 8);
    const cashFlow = await MonthlyReportsService.getCashFlowStatement('company_1', 2026, 8);
    const apAging = await MonthlyReportsService.getAPAging('company_1', 2026, 8);

    expect(sales.summary.totalRevenue).toBe(1200);
    expect(sales.summary.totalGrossProfit).toBe(500);
    expect(cashFlow.summary.endingCash).toBeGreaterThanOrEqual(0);
    expect(apAging.summary.totalAP).toBe(550);
    expect(apAging.summary.totalBills).toBe(2);
  });
});

describe('Annual report service regressions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('annual tax summary uses expense withholding tax instead of unsupported invoice and purchase filters', async () => {
    const invoiceAggregate = jest.fn().mockResolvedValue({ _sum: { taxAmount: 2000, subtotal: 10000 } });
    const purchaseAggregate = jest.fn().mockResolvedValue({ _sum: { taxAmount: 1500, subtotal: 8000 } });
    const expenseAggregate = jest.fn().mockResolvedValue({ _sum: { withholdingTax: 800 } });

    dbClient.mockReturnValue({
      company: { findUnique: jest.fn().mockResolvedValue({ id: 'company_1', name: 'Acme', taxIdentificationNumber: '123456' }) },
      invoice: { aggregate: invoiceAggregate },
      purchase: { aggregate: purchaseAggregate },
      expense: { aggregate: expenseAggregate },
      payrollRun: { findMany: jest.fn().mockResolvedValue([]) },
      payroll: { findMany: jest.fn().mockResolvedValue([]) },
    });

    const result = await AnnualReportsService.getTaxSummary('company_1', 2026);

    expect(result.withholding.totalWithholdingTax).toBe(800);
    expect(expenseAggregate).toHaveBeenCalledTimes(1);
    expect(invoiceAggregate.mock.calls.some(([args]) => args.where && Object.prototype.hasOwnProperty.call(args.where, 'withholdingTax'))).toBe(false);
    expect(purchaseAggregate.mock.calls.some(([args]) => args.where && Object.prototype.hasOwnProperty.call(args.where, 'withholdingTax'))).toBe(false);
  });
});
