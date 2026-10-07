jest.mock('../services/cacheService', () => ({
  delete: jest.fn().mockResolvedValue(true),
}));

const cacheService = require('../services/cacheService');
const APTrackingService = require('../services/apTrackingService');

describe('AP tracking cache invalidation', () => {
  beforeEach(() => {
    cacheService.delete.mockClear();
  });

  test('uses the cache service delete API for supplier balances', async () => {
    await APTrackingService.invalidateSupplierBalanceCache('company-1', 'supplier-1');

    expect(cacheService.delete).toHaveBeenCalledWith('ap_supplier_balance_company-1_supplier-1');
  });
});
