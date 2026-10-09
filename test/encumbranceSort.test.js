const mockFindMany = jest.fn().mockResolvedValue([]);

jest.mock('../lib/prisma', () => ({
  prisma: {
    encumbrance: {
      findMany: mockFindMany,
    },
  },
}));

const Encumbrance = require('../models/Encumbrance');

describe('Encumbrance compatibility query', () => {
  beforeEach(() => {
    mockFindMany.mockClear();
    mockFindMany.mockResolvedValue([]);
  });

  test('maps the legacy encumbrance date sort to the Prisma field name', async () => {
    await Encumbrance.find({
      company_id: 'company_1',
      budget_id: 'budget_1',
      budget_line_id: 'line_1',
    })
      .sort({ encumbrance_date: -1 });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ encumbranceDate: 'desc' }],
      }),
    );
  });
});
