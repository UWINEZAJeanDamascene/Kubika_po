const mockFindMany = jest.fn().mockResolvedValue([]);

jest.mock('../lib/prisma', () => ({
  prisma: {
    budgetApproval: {
      findMany: mockFindMany,
    },
  },
}));

const BudgetApproval = require('../models/BudgetApproval');

describe('Budget approval compatibility query', () => {
  beforeEach(() => {
    mockFindMany.mockClear();
    mockFindMany.mockResolvedValue([]);
  });

  test('maps approval history sorting to the Prisma requestedAt field', async () => {
    await BudgetApproval.find({
      company_id: 'company_1',
      budget_id: 'budget_1',
    }).sort({ requested_at: -1 });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ requestedAt: 'desc' }],
        where: {
          companyId: 'company_1',
          budgetId: 'budget_1',
        },
      }),
    );
  });
});
