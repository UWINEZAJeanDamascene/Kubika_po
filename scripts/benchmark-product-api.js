/**
 * Benchmark product list/detail API latency (includes auth + middleware stack).
 * Usage: node scripts/benchmark-product-api.js <jwt_token>
 */
require('dotenv').config();
const { prisma } = require('../lib/prisma');

const BASE = process.env.API_BASE_URL || 'http://localhost:3000/api';
const TOKEN = process.argv[2] || process.env.BENCHMARK_TOKEN;
const MAX_MS = 3000;

async function timedFetch(label, url) {
  const started = Date.now();
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  const elapsed = Date.now() - started;
  const body = await response.json().catch(() => ({}));
  const ok = response.ok;
  console.log(`${label}: ${elapsed}ms ${ok ? 'OK' : `FAIL ${response.status}`}${body.fromCache ? ' (cache)' : ''}`);
  if (!ok) console.log('  ', body.message || body.error || response.statusText);
  return { elapsed, ok, body };
}

async function main() {
  if (!TOKEN) {
    console.error('Pass a JWT: node scripts/benchmark-product-api.js <token>');
    process.exit(1);
  }

  const sample = await prisma.product.findFirst({
    select: { id: true, companyId: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!sample) {
    console.error('No products in database.');
    process.exit(1);
  }

  console.log(`Benchmarking ${BASE} (budget: ${MAX_MS}ms per request)\n`);

  const list = await timedFetch('GET /products?page=1&limit=10', `${BASE}/products?page=1&limit=10`);
  const listCached = await timedFetch('GET /products (2nd — cache)', `${BASE}/products?page=1&limit=10`);
  const detail = await timedFetch(`GET /products/${sample.id}`, `${BASE}/products/${sample.id}`);
  const detailCached = await timedFetch(`GET /products/${sample.id} (2nd — cache)`, `${BASE}/products/${sample.id}`);

  const failures = [list, listCached, detail, detailCached].filter((r) => !r.ok || r.elapsed > MAX_MS);
  await prisma.$disconnect();

  if (failures.length) {
    console.error(`\n${failures.length} request(s) exceeded ${MAX_MS}ms or failed.`);
    process.exit(1);
  }
  console.log('\nAll product API benchmarks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
