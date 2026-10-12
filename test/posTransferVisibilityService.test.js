'use strict';

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));

const { dbClient } = require('../lib/prisma');
const { getWarehouseTransferVisibility } = require('../services/posTransferVisibilityService');

describe('POS stock transfer visibility', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns in-transit quantities separately for the selected warehouse', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        productId: 'product-1',
        transferNumber: 'TR-001',
        status: 'in_transit',
        dispatchedAt: new Date('2026-10-12T10:00:00Z'),
        expectedArrivalAt: new Date('2026-10-13T10:00:00Z'),
        direction: 'incoming',
        otherWarehouseName: 'Store A',
        quantity: '5',
      },
      {
        productId: 'product-1',
        transferNumber: 'TR-002',
        status: 'in_transit',
        dispatchedAt: null,
        expectedArrivalAt: null,
        direction: 'outgoing',
        otherWarehouseName: 'Store C',
        quantity: '2',
      },
    ]);
    dbClient.mockReturnValue({ $queryRawUnsafe: query });

    const visibility = await getWarehouseTransferVisibility(
      'company-1',
      'warehouse-b',
      ['product-1'],
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("transfer.status = 'in_transit'"),
      'warehouse-b',
      'company-1',
      ['product-1'],
    );
    expect(visibility['product-1']).toEqual({
      incoming: [{
        transferNumber: 'TR-001',
        status: 'in_transit',
        quantity: 5,
        otherWarehouseName: 'Store A',
        dispatchedAt: '2026-10-12T10:00:00.000Z',
        expectedArrivalAt: '2026-10-13T10:00:00.000Z',
      }],
      outgoing: [{
        transferNumber: 'TR-002',
        status: 'in_transit',
        quantity: 2,
        otherWarehouseName: 'Store C',
        dispatchedAt: null,
        expectedArrivalAt: null,
      }],
    });
  });

  test('does not query when no warehouse or products are selected', async () => {
    dbClient.mockReturnValue({ $queryRawUnsafe: jest.fn() });
    await expect(getWarehouseTransferVisibility('company-1', '', ['product-1'])).resolves.toEqual({});
    await expect(getWarehouseTransferVisibility('company-1', 'warehouse-1', [])).resolves.toEqual({});
    expect(dbClient).not.toHaveBeenCalled();
  });
});
