'use strict';

jest.mock('../../context-builder/toolRunner', () => ({
  runTool: jest.fn(),
}));

const { runTool } = require('../../context-builder/toolRunner');
const { collect } = require('../../context-builder/collectors/InventoryContextCollector');

describe('Inventory context collector', () => {
  beforeEach(() => jest.clearAllMocks());

  test('includes the service-calculated dead stock count and threshold as a fact', async () => {
    runTool.mockImplementation(async (_companyId, name) => {
      if (name === 'get_stock_summary') return { result: { totalProducts: 100, totalStockValue: 50000, lowStockCount: 4, outOfStockCount: 2 }, elapsedMs: 1 };
      if (name === 'get_products') return { result: { products: [] }, elapsedMs: 1 };
      if (name === 'get_dead_stock_candidates') return { result: { count: 9, daysThreshold: 60, sourceIds: ['product_1'], truncatedSourceIds: 8 }, elapsedMs: 1 };
      throw new Error(`Unexpected tool ${name}`);
    });

    const result = await collect({ companyId: 'company_1' });
    const deadStockFact = result.facts.find((fact) => fact.label === 'Dead stock candidate count');

    expect(runTool).toHaveBeenCalledWith('company_1', 'get_dead_stock_candidates', { days: 60 });
    expect(deadStockFact).toEqual(expect.objectContaining({
      value: 9,
      sourceMethod: 'get_dead_stock_candidates',
      metadata: { deadStockWindowDays: 60, truncatedSourceIds: 8 },
    }));
  });
});
