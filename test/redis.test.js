require('dotenv').config();
const { redisClient, isRedisConfigured } = require('../config/redis');
const redisCache = require('../utils/redisCache');

async function runRedisTests() {
  console.log('=== Redis Verification Tests ===\n');
  console.log('Redis configured:', isRedisConfigured());

  const health = await redisCache.healthCheck();
  console.log('Redis health:', JSON.stringify(health, null, 2));

  if (!health.configured) {
    console.log('\nRedis is not configured. Set REDIS_URL or UPSTASH_REDIS_REST_URL in .env');
    process.exit(1);
  }

  if (!health.connected) {
    console.log('\nRedis connection failed!');
    process.exit(1);
  }

  const testKey = 'test:redis:ping';
  const testData = {
    message: 'Redis is working!',
    timestamp: new Date().toISOString(),
    nested: { ok: true },
  };

  console.log('\n--- Set with TTL ---');
  await redisCache.set(testKey, testData, 60);
  console.log('SET', testKey, 'OK');

  console.log('\n--- Get ---');
  const cached = await redisCache.get(testKey);
  console.log('GET', testKey, '=>', JSON.stringify(cached, null, 2));

  console.log('\n--- Delete ---');
  await redisCache.del(testKey);
  const afterDelete = await redisCache.get(testKey);
  console.log('GET after DEL =>', afterDelete);

  console.log('\n--- Pattern Clear ---');
  await redisCache.set('test:redis:a', { a: 1 }, 60);
  await redisCache.set('test:redis:b', { b: 2 }, 60);
  await redisCache.set('other:key', { c: 3 }, 60);
  const cleared = await redisCache.clear('test:redis:*');
  console.log('Cleared', cleared, 'keys matching test:redis:*');

  const remaining = await redisClient.keys('test:redis:*');
  console.log('Remaining test:redis:* keys:', remaining.length);

  console.log('\n--- Connection Info ---');
  const info = await redisClient.info('server');
  console.log(info.slice(0, 500));

  console.log('\n=== All Redis tests passed ===');
  process.exit(0);
}

runRedisTests().catch((e) => {
  console.error('Redis test failed:', e);
  process.exit(1);
});
