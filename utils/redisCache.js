const { redisClient, isRedisConfigured } = require('../config/redis');

class RedisCache {
  get(key) {
    if (!isRedisConfigured()) return Promise.resolve(null);
    return redisClient.get(key).then((data) => {
      if (!data) return null;
      try {
        return JSON.parse(data);
      } catch {
        return data;
      }
    });
  }

  set(key, value, ttlSeconds = 300) {
    if (!isRedisConfigured()) return Promise.resolve(true);
    const payload = typeof value === 'string' ? value : JSON.stringify(value);
    return redisClient.setex(key, ttlSeconds, payload);
  }

  del(key) {
    if (!isRedisConfigured()) return Promise.resolve(0);
    return redisClient.del(key);
  }

  clear(pattern = '*') {
    if (!isRedisConfigured()) return Promise.resolve(0);
    return new Promise((resolve, reject) => {
      let cursor = '0';
      let deleted = 0;
      const scanBatch = () => {
        redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 200, (err, reply) => {
          if (err) return reject(err);
          cursor = reply[0];
          const keys = reply[1] || [];
          if (keys.length === 0) return resolve(deleted);
          redisClient.del(...keys, (err2) => {
            if (err2) return reject(err2);
            deleted += keys.length;
            if (cursor === '0') return resolve(deleted);
            scanBatch();
          });
        });
      };
      scanBatch();
    });
  }

  async healthCheck() {
    if (!isRedisConfigured()) return { configured: false, connected: false };
    try {
      const pong = await redisClient.ping();
      return { configured: true, connected: pong === 'PONG' };
    } catch (e) {
      return { configured: true, connected: false, error: e.message };
    }
  }

  async keys(pattern = '*') {
    if (!isRedisConfigured()) return [];
    try {
      if (typeof redisClient.scanIterator === 'function') {
        const keys = [];
        for await (const k of redisClient.scanIterator({ MATCH: pattern, COUNT: 200 })) {
          keys.push(k);
        }
        return keys;
      }
      const keys = await redisClient.keys(pattern);
      return Array.isArray(keys) ? keys : [];
    } catch (e) {
      console.error('redisCache.keys error:', e);
      return [];
    }
  }
}

module.exports = new RedisCache();
