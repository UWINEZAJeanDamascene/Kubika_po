jest.mock('../services/cacheService', () => ({
  generateKey: jest.fn(() => 'cache:report:company-1:test'),
  get: jest.fn(),
  set: jest.fn(() => Promise.resolve()),
  invalidateByCompany: jest.fn(() => Promise.resolve(1)),
  invalidateType: jest.fn(() => Promise.resolve(1)),
  getCacheConfig: jest.fn(() => ({ ttl: 900 })),
}));

jest.mock('../services/DashboardCacheService', () => ({
  invalidate: jest.fn(() => Promise.resolve()),
}));

jest.mock('../services/sessionService', () => ({
  isTokenBlacklisted: jest.fn(),
  getSession: jest.fn(),
  getUserByToken: jest.fn(),
  extendSession: jest.fn(),
}));

jest.mock('../lib/prisma', () => ({
  dbClient: jest.fn(() => ({
    accountingPeriod: {
      findMany: jest.fn(() => Promise.resolve([{
        startDate: new Date('2025-01-01T00:00:00.000Z'),
        endDate: new Date('2025-12-31T23:59:59.999Z'),
        status: 'closed',
      }])),
    },
  })),
}));

const cacheService = require('../services/cacheService');
const dashboardCache = require('../services/DashboardCacheService');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

function response(statusCode = 200) {
  const res = {
    statusCode,
    json: jest.fn((body) => body),
  };
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  return res;
}

describe('Phase 3 cache middleware', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns a tenant-scoped report cache hit without invoking the handler', async () => {
    cacheService.get.mockResolvedValue({ success: true, data: { total: 42 } });
    const middleware = cacheMiddleware({ type: 'report', ttl: 300 });
    const req = { method: 'GET', path: '/trial-balance', query: {}, companyId: 'company-1', user: {} };
    const res = response();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { total: 42 }, fromCache: true });
    expect(cacheService.generateKey).toHaveBeenCalledWith('report', expect.objectContaining({ companyId: 'company-1' }));
  });

  test('stores a closed-period report without expiry', async () => {
    cacheService.get.mockResolvedValue(null);
    const middleware = cacheMiddleware({ type: 'report', ttl: 300, closedPeriodPersistent: true });
    const req = {
      method: 'GET',
      path: '/trial-balance',
      query: { date_from: '2025-01-01', date_to: '2025-12-31' },
      companyId: 'company-1',
      user: {},
    };
    const res = response();

    await middleware(req, res, jest.fn());
    res.json({ success: true, data: { total: 42 } });
    await Promise.resolve();

    expect(cacheService.set).toHaveBeenCalledWith(
      'cache:report:company-1:test',
      { success: true, data: { total: 42 } },
      0,
    );
  });

  test('invalidates budget and report caches plus dashboards after a successful budget write', async () => {
    const middleware = cacheInvalidationMiddleware({
      types: ['budget', 'report'],
      invalidateDashboards: true,
    });
    const req = { method: 'PUT', companyId: 'company-1', user: {} };
    const res = response(200);

    await middleware(req, res, jest.fn());
    await res.json({ success: true });

    expect(cacheService.invalidateByCompany).toHaveBeenCalledWith('company-1', 'budget');
    expect(cacheService.invalidateByCompany).toHaveBeenCalledWith('company-1', 'report');
    expect(dashboardCache.invalidate).toHaveBeenCalledWith('company-1');
  });
});
