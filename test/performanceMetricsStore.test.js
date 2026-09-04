function createFakeRedis() {
  const hashes = new Map();
  const lists = new Map();
  const sets = new Map();
  const strings = new Map();

  const client = {
    hincrby: async (key, field, amount) => {
      const hash = hashes.get(key) || {};
      hash[field] = Number(hash[field] || 0) + Number(amount);
      hashes.set(key, hash);
      return hash[field];
    },
    hgetall: async (key) => ({ ...(hashes.get(key) || {}) }),
    lpush: async (key, value) => {
      const list = lists.get(key) || [];
      list.unshift(value);
      lists.set(key, list);
      return list.length;
    },
    ltrim: async (key, start, end) => {
      lists.set(key, (lists.get(key) || []).slice(start, end + 1));
      return 'OK';
    },
    lrange: async (key, start, end) => (lists.get(key) || []).slice(start, end + 1),
    sadd: async (key, ...members) => {
      const set = sets.get(key) || new Set();
      members.forEach((member) => set.add(String(member)));
      sets.set(key, set);
      return members.length;
    },
    smembers: async (key) => [...(sets.get(key) || [])],
    srem: async (key, ...members) => {
      const set = sets.get(key) || new Set();
      members.forEach((member) => set.delete(String(member)));
      sets.set(key, set);
      return members.length;
    },
    setex: async (key, _ttl, value) => {
      strings.set(key, value);
      return 'OK';
    },
    get: async (key) => strings.get(key) || null,
    expire: async () => 1,
    del: async (key) => {
      hashes.delete(key);
      lists.delete(key);
      sets.delete(key);
      strings.delete(key);
      return 1;
    },
    ping: async () => 'PONG',
  };

  client.pipeline = () => {
    const commands = [];
    const pipeline = {};
    for (const method of ['hincrby', 'hgetall', 'lpush', 'ltrim', 'lrange', 'sadd', 'srem', 'setex', 'get', 'expire', 'del']) {
      pipeline[method] = (...args) => {
        commands.push(() => client[method](...args));
        return pipeline;
      };
    }
    pipeline.exec = () => Promise.all(commands.map((command) => command()));
    return pipeline;
  };

  return client;
}

describe('performanceMetricsStore', () => {
  let store;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../config/redis', () => {
      const redisClient = createFakeRedis();
      return {
        redisClient,
        isRedisConfigured: () => true,
      };
    });
    store = require('../services/performanceMetricsStore');
  });

  test('flushes durable request and cache metrics with fleet scope', async () => {
    store.recordRequest({ durationMs: 100, statusCode: 200, route: 'GET /api/products' });
    store.recordRequest({ durationMs: 900, statusCode: 500, route: 'GET /api/products' });
    store.recordCacheEvent('product', 'hit');
    store.recordCacheEvent('product', 'miss');
    await store.flush();

    const requests = await store.getRequestMetrics();
    const routes = await store.getRouteMetrics();
    const cache = await store.getCacheMetrics();

    expect(requests).toEqual(expect.objectContaining({
      total_requests: 2,
      error_rate: 50,
      scope: 'redis-fleet',
    }));
    expect(routes.routes[0]).toEqual(expect.objectContaining({
      route: 'GET /api/products',
      count: 2,
    }));
    expect(cache).toEqual(expect.objectContaining({
      hits: 1,
      misses: 1,
      hit_ratio: 50,
      scope: 'redis-fleet',
    }));
    expect(store.getStorageStatus()).toEqual(expect.objectContaining({
      backend: 'redis',
      persistent: true,
      aggregated_across_instances: true,
    }));
  });

  test('flushes bounded browser timing metrics with percentile data', async () => {
    store.recordClientMetric('application_shell_ready', 120, { route: '/dashboard' });
    store.recordClientMetric('application_shell_ready', 180, { route: '/dashboard' });
    store.recordClientMetric('cumulative_layout_shift', 0.12, { unit: 'score', route: '/dashboard' });
    await store.flush();

    const metrics = await store.getClientMetrics();

    expect(metrics).toEqual(expect.objectContaining({
      scope: 'redis-fleet',
      tracked_metrics: 2,
    }));
    expect(metrics.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'application_shell_ready',
        unit: 'ms',
        count: 2,
        avg: 150,
        p95: 180,
      }),
      expect.objectContaining({
        name: 'cumulative_layout_shift',
        unit: 'score',
        count: 1,
        avg: 0.12,
      }),
    ]));
  });
});
