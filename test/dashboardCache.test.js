require('dotenv').config();
const dashboardCache = require('../services/DashboardCacheService');

async function run() {
  console.log('=== Dashboard Cache Tests ===\n');

  const companyId = 'company-test-123';

  const payload = {
    company_id: companyId,
    generated_at: new Date(),
    key_metrics: { revenue: { this_month: 1000 } }
  };

  console.log('--- Set executive dashboard ---');
  await dashboardCache.set(companyId, 'executive', payload, '', 30 * 1000);
  console.log('SET OK');

  console.log('\n--- Get executive dashboard ---');
  const cached = await dashboardCache.get(companyId, 'executive');
  console.log('GET =>', cached ? 'HIT' : 'MISS');
  if (cached) {
    console.log('  company_id:', cached.company_id);
    console.log('  generated_at:', cached.generated_at);
  }

  console.log('\n--- Get missing dashboard ---');
  const missing = await dashboardCache.get(companyId, 'nonexistent');
  console.log('GET =>', missing);

  console.log('\n--- Invalidate executive dashboard ---');
  await dashboardCache.invalidateDashboard(companyId, 'executive');
  const afterInvalidate = await dashboardCache.get(companyId, 'executive');
  console.log('GET after invalidate =>', afterInvalidate);

  console.log('\n--- Set two dashboards then invalidate all ---');
  await dashboardCache.set(companyId, 'executive', { a: 1 }, '', 30 * 1000);
  await dashboardCache.set(companyId, 'finance', { b: 2 }, '', 30 * 1000);
  await dashboardCache.invalidate(companyId);
  const e2 = await dashboardCache.get(companyId, 'executive');
  const f2 = await dashboardCache.get(companyId, 'finance');
  console.log('GET executive =>', e2);
  console.log('GET finance =>', f2);

  console.log('\n--- Stats ---');
  const stats = await dashboardCache.getStats();
  console.log('Stats:', JSON.stringify(stats, null, 2));

  console.log('\n--- Clear all ---');
  await dashboardCache.set(companyId, 'executive', { a: 1 }, '', 30 * 1000);
  await dashboardCache.clearAll();
  const afterClear = await dashboardCache.get(companyId, 'executive');
  console.log('GET after clearAll =>', afterClear);

  console.log('\n=== All dashboard cache tests passed ===');
  process.exit(0);
}

run().catch((e) => {
  console.error('Dashboard cache test failed:', e);
  process.exit(1);
});
