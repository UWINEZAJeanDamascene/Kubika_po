const mockFindMany = jest.fn().mockResolvedValue([]);

jest.mock('../lib/prisma', () => ({
  prisma: {
    budgetActualConsumption: {
      findMany: mockFindMany,
    },
  },
}));

const BudgetActualConsumption = require('../models/BudgetActualConsumption');

describe('Budget actual consumption compatibility query', () => {
  beforeEach(() => {
    mockFindMany.mockClear();
    mockFindMany.mockResolvedValue([]);
  });

  test('maps legacy document date and created date sorting to Prisma fields', async () => {
    await BudgetActualConsumption.find({
      company_id: 'company_1',
      budget_id: 'budget_1',
      budget_line_id: 'line_1',
    }).sort({ document_date: -1, createdAt: -1 });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { documentDate: 'desc' },
          { createdAt: 'desc' },
        ],
        where: {
          companyId: 'company_1',
          budgetId: 'budget_1',
          budgetLineId: 'line_1',
        },
      }),
    );
  });
});
