/**
 * Phase 4 — cache/report semantics regression coverage.
 *
 * Targets the six Phase 4 contracts that had zero automated coverage before
 * this file: global-vs-tenant key scope, exact per-company invalidation vs.
 * a global sweep, closed-period report coverage classification, stampede
 * protection (single-flight request coalescing), and cache hit-ratio
 * alerting. Each describe block resets modules and mocks `../config/redis`
 * (and `../lib/prisma` where needed) so the suite runs deterministically
 * without a live Redis/Postgres instance, matching the pattern already used
 * in test/performanceMetricsStore.test.js and test/transactionAtomicity.test.js.
 */

function createFakeRedis() {
  const strings = new Map();
  return {
    get: async (key) => (strings.has(key) ? strings.get(key) : null),
    set: async (key, value, ...args) => {
      const nx = args.includes('NX') || (args[args.length - 1] && typeof args[args.length - 1] === 'object' && args[args.length - 1].nx);
      if (nx && strings.has(key)) return null;
      strings.set(key, value);
      return 'OK';
    },
    setex: async (key, _ttl, value) => {
      strings.set(key, value);
      return 'OK';
    },
    del: async (...keys) => {
      let removed = 0;
      keys.flat().forEach((key) => {
        if (strings.delete(key)) removed += 1;
      });
      return removed;
    },
    exists: async (key) => (strings.has(key) ? 1 : 0),
    scan: async () => ['0', [...strings.keys()]],
    keys: async () => [...strings.keys()],
    info: async () => '',
    // Deliberately no hincrby/lpush/expire: keeps performanceMetricsStore's
    // enabled() false so cache-hit-ratio tests exercise the process-local
    // fallback in cacheService itself, not the Redis-fleet path.
  };
}

function mockRedisConfig() {
  jest.doMock('../config/redis', () => ({
    redisClient: createFakeRedis(),
    isRedisConfigured: () => true,
  }));
}

describe('cacheService.generateKey — global vs tenant scope', () => {
  let cacheService;

  beforeEach(() => {
    jest.resetModules();
    mockRedisConfig();
    cacheService = require('../services/cacheService');
  });

  test('scope: "global" ignores companyId — two tenants share one key', () => {
    const keyForTenantA = cacheService.generateKey('currency', { scope: 'global', companyId: 'tenant-a', query: {} });
    const keyForTenantB = cacheService.generateKey('currency', { scope: 'global', companyId: 'tenant-b', query: {} });

    expect(keyForTenantA).toMatch(/^cache:currency:global:/);
    expect(keyForTenantA).toBe(keyForTenantB);
  });

  test('tenant-scoped keys differ per company and never collapse to a shared entry', () => {
    const keyForTenantA = cacheService.generateKey('warehouse', { companyId: 'tenant-a', query: {} });
    const keyForTenantB = cacheService.generateKey('warehouse', { companyId: 'tenant-b', query: {} });

    expect(keyForTenantA).toMatch(/^cache:warehouse:tenant-a:/);
    expect(keyForTenantB).toMatch(/^cache:warehouse:tenant-b:/);
    expect(keyForTenantA).not.toBe(keyForTenantB);
  });
});

describe('cacheMiddleware — tenant-scoped requests with no resolvable tenant bypass the cache', () => {
  let cacheMiddleware;

  beforeEach(() => {
    jest.resetModules();
    mockRedisConfig();
    ({ cacheMiddleware } = require('../middleware/cacheMiddleware'));
  });

  test('a platform-admin request (req.company === null) is served uncached, not under a shared key', async () => {
    const mw = cacheMiddleware({ type: 'product', ttl: 120 });
    const req = { method: 'GET', path: '/api/products', query: {}, company: null, user: {} };
    let nextCalled = false;
    const res = { json: () => res };

    await mw(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  test('global: true serves a resolvable-tenant-free request from the shared global key', async () => {
    const mw = cacheMiddleware({ type: 'currency', ttl: 3600, global: true });
    const req = { method: 'GET', path: '/api/currencies', query: {}, company: null, user: {} };

    function makeRes() {
      const res = {
        statusCode: 200,
        json: (data) => data,
        status(code) {
          this.statusCode = code;
          return this;
        },
      };
      return res;
    }

    let nextCalled = false;
    const res = makeRes();
    await mw(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);

    // Populate the cache the way Express would (controller calls res.json).
    res.json({ success: true, data: ['USD'] });
    // cacheService.set() inside the wrapped json is deliberately
    // fire-and-forget (never delay the response for a cache write), so give
    // it one tick to land before checking the cache again.
    await new Promise((resolve) => setImmediate(resolve));

    // A second, unrelated request for the same global data must be served
    // from cache (res.status(200).json(...)) rather than calling next() again.
    let nextCalledSecondTime = false;
    const res2 = makeRes();
    await mw(req, res2, () => {
      nextCalledSecondTime = true;
    });
    expect(nextCalledSecondTime).toBe(false);
  });
});

describe('cacheInvalidationMiddleware — invalidateAll requires an explicit global scope', () => {
  let cacheInvalidationMiddleware;
  let cacheService;

  beforeEach(() => {
    jest.resetModules();
    mockRedisConfig();
    ({ cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware'));
    cacheService = require('../services/cacheService');
  });

  async function invokeAndRespond(mw, req) {
    const res = { statusCode: 200, json: (data) => data };
    await mw(req, res, () => {});
    return res.json({ success: true });
  }

  test('invalidateAll without global falls back to exact per-company invalidation (no cross-tenant sweep)', async () => {
    const invalidateByCompany = jest.spyOn(cacheService, 'invalidateByCompany').mockResolvedValue(1);
    const invalidateType = jest.spyOn(cacheService, 'invalidateType').mockResolvedValue(1);

    const mw = cacheInvalidationMiddleware({ type: 'warehouse', invalidateAll: true });
    const req = { method: 'POST', company: { _id: 'company-1' }, user: {} };

    await invokeAndRespond(mw, req);

    expect(invalidateByCompany).toHaveBeenCalledWith('company-1', 'warehouse');
    expect(invalidateType).not.toHaveBeenCalled();
  });

  test('invalidateAll with global: true sweeps every tenant for genuinely global data', async () => {
    const invalidateType = jest.spyOn(cacheService, 'invalidateType').mockResolvedValue(1);
    const invalidateByCompany = jest.spyOn(cacheService, 'invalidateByCompany').mockResolvedValue(1);

    const mw = cacheInvalidationMiddleware({ type: 'currency', invalidateAll: true, global: true });
    const req = { method: 'POST', company: null, user: {} };

    await invokeAndRespond(mw, req);

    expect(invalidateType).toHaveBeenCalledWith('currency');
    expect(invalidateByCompany).not.toHaveBeenCalled();
  });

  test('resolves tenant from req.user.company when req.company is absent (does not evict another company)', async () => {
    const invalidateByCompany = jest.spyOn(cacheService, 'invalidateByCompany').mockResolvedValue(1);

    const mw = cacheInvalidationMiddleware({ types: ['stock', 'product'] });
    const req = { method: 'PUT', user: { company: 'company-9' } };

    await invokeAndRespond(mw, req);

    expect(invalidateByCompany).toHaveBeenCalledWith('company-9', 'stock');
    expect(invalidateByCompany).toHaveBeenCalledWith('company-9', 'product');
  });
});

describe('cacheService stampede protection — beginRequestFlight', () => {
  let cacheService;

  beforeEach(() => {
    jest.resetModules();
    process.env.CACHE_STAMPEDE_WAIT_MS = '200';
    process.env.CACHE_STAMPEDE_POLL_MS = '20';
    mockRedisConfig();
    cacheService = require('../services/cacheService');
  });

  afterEach(() => {
    delete process.env.CACHE_STAMPEDE_WAIT_MS;
    delete process.env.CACHE_STAMPEDE_POLL_MS;
  });

  test('a follower that arrives after the owner already cached the result gets that result, not a recompute', async () => {
    const key = cacheService.generateKey('report', { companyId: 'c1', query: {} });

    const owner = await cacheService.beginRequestFlight(key);
    expect(owner.acquired).toBe(true);

    await cacheService.set(key, { total: 42 }, 900);

    const follower = await cacheService.beginRequestFlight(key);
    expect(follower.acquired).toBe(false);
    expect(follower.cached).toEqual({ total: 42 });

    await owner.release();
  });

  test('a follower never blocks indefinitely — it is released to recompute after the bounded wait', async () => {
    const key = cacheService.generateKey('report', { companyId: 'c2', query: {} });

    const owner = await cacheService.beginRequestFlight(key);
    expect(owner.acquired).toBe(true);
    // Owner deliberately never populates the cache before the follower checks.

    const follower = await cacheService.beginRequestFlight(key);
    expect(follower.acquired).toBe(false);
    expect(follower.cached).toBeUndefined();

    await owner.release();
  });

  test('after the owner releases, a new caller can acquire the flight and compute independently', async () => {
    const key = cacheService.generateKey('report', { companyId: 'c3', query: {} });

    const owner = await cacheService.beginRequestFlight(key);
    await owner.release();

    const next = await cacheService.beginRequestFlight(key);
    expect(next.acquired).toBe(true);
    await next.release();
  });
});

describe('cacheService cache hit-ratio alerts (process-local fallback)', () => {
  let cacheService;

  beforeEach(() => {
    jest.resetModules();
    process.env.CACHE_ALERT_MIN_LOOKUPS = '3';
    process.env.CACHE_ALERT_HIT_RATIO_THRESHOLD_PERCENT = '50';
    process.env.CACHE_ALERT_TYPES = 'lowhitwidget';
    mockRedisConfig();
    cacheService = require('../services/cacheService');
  });

  afterEach(() => {
    delete process.env.CACHE_ALERT_MIN_LOOKUPS;
    delete process.env.CACHE_ALERT_HIT_RATIO_THRESHOLD_PERCENT;
    delete process.env.CACHE_ALERT_TYPES;
  });

  test('flags a monitored type once it clears the minimum lookup floor and sits below the threshold', async () => {
    const key = cacheService.generateKey('lowhitwidget', { companyId: 'c1', query: {} });
    // Three misses, zero hits: 0% hit ratio, exactly at the min-lookup floor.
    await cacheService.get(key);
    await cacheService.get(key);
    await cacheService.get(key);

    const metrics = await cacheService.getAggregatedMetrics();

    expect(metrics.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'lowhitwidget', hit_ratio: 0, threshold_percent: 50 }),
    ]));
  });

  test('does not flag a type that has not yet cleared the minimum lookup floor', async () => {
    const key = cacheService.generateKey('lowhitwidget', { companyId: 'c2', query: {} });
    await cacheService.get(key); // only 1 lookup, below min_lookups=3

    const metrics = await cacheService.getAggregatedMetrics();

    expect(metrics.alerts.find((alert) => alert.type === 'lowhitwidget')).toBeUndefined();
  });

  test('does not flag a healthy hit ratio at or above the threshold', async () => {
    const key = cacheService.generateKey('lowhitwidget', { companyId: 'c3', query: {} });
    await cacheService.set(key, { ok: true }, 60);
    await cacheService.get(key); // hit
    await cacheService.get(key); // hit
    await cacheService.get(key); // hit
    // 3 hits / 3 lookups = 100% >= 50% threshold.

    const metrics = await cacheService.getAggregatedMetrics();

    expect(metrics.alerts.find((alert) => alert.type === 'lowhitwidget')).toBeUndefined();
  });
});

describe('isClosedPeriodReport — closed-period coverage classifier', () => {
  let isClosedPeriodReport;
  let periodsFixture;

  beforeEach(() => {
    jest.resetModules();
    periodsFixture = [];
    jest.doMock('../lib/prisma', () => ({
      dbClient: () => ({
        accountingPeriod: {
          findMany: async () => periodsFixture,
        },
      }),
    }));
    ({ isClosedPeriodReport } = require('../middleware/cacheMiddleware'));
  });

  function period(status, startDate, endDate) {
    return {
      status,
      startDate: startDate instanceof Date ? startDate : new Date(startDate),
      endDate: endDate instanceof Date ? endDate : new Date(endDate),
    };
  }

  test('a range fully covered by one closed period is eligible for persistent caching', async () => {
    periodsFixture = [period('closed', '2026-01-01', '2026-01-31')];
    const req = { query: { date_from: '2026-01-05', date_to: '2026-01-20' } };

    expect(await isClosedPeriodReport(req, 'company-1')).toBe(true);
  });

  test('a gap between two periods is not treated as closed', async () => {
    periodsFixture = [
      period('closed', '2026-01-01', '2026-01-10'),
      period('closed', '2026-01-15', '2026-01-31'), // 11–14 is an uncovered gap
    ];
    const req = { query: { date_from: '2026-01-01', date_to: '2026-01-31' } };

    expect(await isClosedPeriodReport(req, 'company-1')).toBe(false);
  });

  test('an open period anywhere in the range blocks persistent caching', async () => {
    periodsFixture = [period('open', '2026-01-01', '2026-01-31')];
    const req = { query: { date_from: '2026-01-05', date_to: '2026-01-20' } };

    expect(await isClosedPeriodReport(req, 'company-1')).toBe(false);
  });

  test('a locked period counts as closed, and year/month query params resolve the same range', async () => {
    // reportDateRange builds the requested range with the local-time Date(y,
    // m, d) constructor, so the fixture must use the same constructor rather
    // than a UTC ISO string — otherwise a non-UTC test-runner timezone makes
    // the two disagree on where midnight falls. endDate is also anchored to
    // the true end-of-day boundary, matching how a real closed period covers
    // its last calendar day.
    periodsFixture = [period('locked', new Date(2026, 0, 1), new Date(2026, 0, 31, 23, 59, 59, 999))];
    const req = { query: { year: '2026', month: '1' } };

    expect(await isClosedPeriodReport(req, 'company-1')).toBe(true);
  });

  test('no matching period is never assumed closed, even for a plausible historical range', async () => {
    periodsFixture = [];
    const req = { query: { date_from: '2026-02-01', date_to: '2026-02-10' } };

    expect(await isClosedPeriodReport(req, 'company-1')).toBe(false);
  });

  test('missing date range or missing companyId short-circuits to false without querying periods', async () => {
    expect(await isClosedPeriodReport({ query: {} }, 'company-1')).toBe(false);
    expect(await isClosedPeriodReport({ query: { date_from: '2026-01-01', date_to: '2026-01-05' } }, null)).toBe(false);
  });
});
