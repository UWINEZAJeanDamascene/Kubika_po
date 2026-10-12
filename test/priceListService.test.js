'use strict';

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));

const { dbClient } = require('../lib/prisma');
const { effectivePrice, getWarehousePriceListPrices } = require('../services/priceListService');

describe('price list pricing', () => {
  beforeEach(() => jest.clearAllMocks());

  test('loads only the assigned warehouse list and overrides explicit product prices', async () => {
    const query = jest.fn().mockResolvedValue([
      { priceListId: '111111111111111111111111', productId: '222222222222222222222222', price: '75.50' },
      { priceListId: '111111111111111111111111', productId: null, price: null },
    ]);
    dbClient.mockReturnValue({ $queryRawUnsafe: query });

    const pricing = await getWarehousePriceListPrices(
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbb',
      ['222222222222222222222222', '333333333333333333333333'],
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('w.price_list_id'),
      'bbbbbbbbbbbbbbbbbbbbbbbb',
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      ['222222222222222222222222', '333333333333333333333333'],
    );
    expect(pricing.priceListId).toBe('111111111111111111111111');
    expect(effectivePrice('222222222222222222222222', 100, pricing.priceByProduct)).toBe(75.5);
    expect(effectivePrice('333333333333333333333333', 100, pricing.priceByProduct)).toBe(100);
  });

  test('uses standard selling prices when no warehouse price list is assigned', async () => {
    const query = jest.fn().mockResolvedValue([{ priceListId: null, productId: null, price: null }]);
    dbClient.mockReturnValue({ $queryRawUnsafe: query });

    const pricing = await getWarehousePriceListPrices('aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb', []);

    expect(pricing.priceListId).toBeNull();
    expect(effectivePrice('cccccccccccccccccccccccc', 120, pricing.priceByProduct)).toBe(120);
  });
});
