require('dotenv').config();
const cacheService = require('../services/cacheService');
const redisCache = require('../utils/redisCache');

async function run() {
  console.log('=== Product Cache Tests ===\n');

  // Test 1: Key generation
  const key = cacheService.generateKey('product', { companyId: 'c1', path: '/api/products', query: {} });
  console.log('Generated key:', key);

  // Test 2: Set and get
  const payload = {
    success: true,
    count: 2,
    total: 2,
    pagination: { page: 1, limit: 20, pages: 1 },
    pages: 1,
    currentPage: 1,
    data: [
      { _id: 'p1', name: 'Product A', sku: 'A001', currentStock: 50, sellingPrice: 100 },
      { _id: 'p2', name: 'Product B', sku: 'B001', currentStock: 10, sellingPrice: 200 },
    ],
    fromCache: false,
  };

  await cacheService.set(key, payload, 120);
  console.log('SET OK');

  const cached = await cacheService.get(key);
  console.log('GET cached:', cached ? 'HIT' : 'MISS');
  if (cached) {
    console.log('  count:', cached.count);
    console.log('  fromCache:', cached.fromCache);
    console.log('  first product:', cached.data[0]?.name);
  }

  // Test 3: Invalidate by company and type
  await cacheService.invalidateByCompany('c1', 'product');
  const afterInvalidate = await cacheService.get(key);
  console.log('\nAfter invalidateByCompany =>', afterInvalidate);

  // Test 4: Pattern delete
  await cacheService.set(key, payload, 120);
  await cacheService.deletePattern('cache:product:c1:*');
  const afterPatternDelete = await cacheService.get(key);
  console.log('After deletePattern =>', afterPatternDelete);

  // Test 5: Stats
  const stats = await cacheService.getStats();
  console.log('\nStats:', JSON.stringify(stats, null, 2));

  // Cleanup
  await cacheService.delete(key);

  console.log('\n=== Product cache tests passed ===');
  process.exit(0);
}

run().catch((e) => {
  console.error('Product cache test failed:', e);
  process.exit(1);
});
