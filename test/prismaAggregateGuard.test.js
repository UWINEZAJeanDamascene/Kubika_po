describe('Prisma compatibility aggregation guard', () => {
  const oldLimit = process.env.AGG_MAX_ROWS;

  afterEach(() => {
    if (oldLimit === undefined) delete process.env.AGG_MAX_ROWS;
    else process.env.AGG_MAX_ROWS = oldLimit;
    jest.resetModules();
  });

  function aggregateFor(rows) {
    const delegate = { findMany: jest.fn(async () => rows) };
    const { createAggregateMethod } = require('../utils/prismaAggregate');
    return {
      delegate,
      aggregate: createAggregateMethod({
        modelName: 'stockMovement',
        delegate: () => delegate,
        fieldMap: { company: { target: 'companyId', isId: true } },
        toApi: (row) => row,
      }),
    };
  }

  test('returns an explicit error instead of silently grouping a truncated tenant read', async () => {
    process.env.AGG_MAX_ROWS = '2';
    jest.resetModules();
    const { aggregate } = aggregateFor([
      { companyId: 'c1', quantity: 1 },
      { companyId: 'c1', quantity: 2 },
      { companyId: 'c1', quantity: 3 },
    ]);

    await expect(aggregate([
      { $match: { company: 'c1' } },
      { $group: { _id: null, total: { $sum: '$quantity' } } },
    ])).rejects.toMatchObject({ code: 'AGGREGATE_ROW_LIMIT', status: 413 });
  });

  test('continues to support bounded legacy pipelines below the safety limit', async () => {
    process.env.AGG_MAX_ROWS = '3';
    jest.resetModules();
    const { aggregate, delegate } = aggregateFor([
      { companyId: 'c1', quantity: 1 },
      { companyId: 'c1', quantity: 2 },
    ]);

    const result = await aggregate([
      { $match: { company: 'c1' } },
      { $group: { _id: null, total: { $sum: '$quantity' } } },
    ]);

    expect(result).toEqual([{ _id: null, total: 3 }]);
    expect(delegate.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 4 }));
  });
});
