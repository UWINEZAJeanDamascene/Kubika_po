describe('Budget Postgres actual totals', () => {
  test('calculates actual totals via Prisma aggregation for a Postgres-only deployment', async () => {
    jest.resetModules();
    const prismaModule = require('../lib/prisma');
    const originalDbClient = prismaModule.dbClient;

    const groupByMock = jest.fn().mockResolvedValue([
      { accountId: 'acc_1', _sum: { debit: '120.00', credit: '30.00' } },
    ]);

    prismaModule.dbClient = jest.fn(() => ({
      journalEntryLine: { groupBy: groupByMock },
    }));

    const BudgetService = require('../services/budgetService');

    try {
      const total = await BudgetService.calculateBudgetActualTotals({
        companyId: 'company_123',
        accountIds: ['acc_1', 'acc_2'],
        periodStart: new Date('2024-01-01T00:00:00Z'),
        periodEnd: new Date('2024-01-31T23:59:59Z'),
      });

      expect(typeof BudgetService.calculateBudgetActualTotals).toBe('function');
      expect(total).toBe(90);
      expect(groupByMock).toHaveBeenCalledTimes(1);
    } finally {
      prismaModule.dbClient = originalDbClient;
      jest.resetModules();
    }
  });
});