/**
 * Backfill FIFO cost layers for stock that has none.
 *
 * Products carry `currentStock`, but FIFO costing consumes `inventory_layers`.
 * Stock that arrived before the Postgres migration — or through a stock
 * adjustment, which used not to touch layers — has no layer behind it, so a sale
 * fails with "insufficient stock" even though the product is on hand.
 *
 * For every product whose layers hold less than its current stock, this creates
 * one layer for the difference, priced at averageCost (falling back to
 * costPrice). Re-running is safe: once layers match stock, nothing is written.
 *
 * Usage:
 *   node scripts/backfillInventoryLayersFromStock.js --dry-run
 *   node scripts/backfillInventoryLayersFromStock.js
 *   node scripts/backfillInventoryLayersFromStock.js --company=6a1682833035c524d960189e
 */
require('dotenv').config();

const { prisma, disconnectPrisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const companyArg = args.find((a) => a.startsWith('--company='));
const onlyCompany = companyArg ? companyArg.split('=')[1] : null;

const num = (value) => (value == null ? 0 : Number(value));

async function layerTotals(companyId) {
  const grouped = await prisma.inventoryLayer.groupBy({
    by: ['productId'],
    where: { companyId },
    _sum: { qtyRemaining: true },
  });
  return new Map(grouped.map((g) => [g.productId, num(g._sum.qtyRemaining)]));
}

async function defaultWarehouseId(companyId) {
  const warehouse = await prisma.warehouse.findFirst({
    where: { companyId, isActive: true },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  return warehouse ? warehouse.id : null;
}

async function backfillCompany(company) {
  const products = await prisma.product.findMany({
    where: { companyId: company.id, currentStock: { gt: 0 } },
    select: { id: true, name: true, sku: true, currentStock: true, averageCost: true, costPrice: true, defaultWarehouseId: true },
  });
  if (!products.length) {
    console.log(`  ${company.name}: no products with stock`);
    return { created: 0, skipped: 0, zeroCost: 0 };
  }

  const layers = await layerTotals(company.id);
  const fallbackWarehouse = await defaultWarehouseId(company.id);

  let created = 0;
  let skipped = 0;
  let zeroCost = 0;

  for (const product of products) {
    const stock = num(product.currentStock);
    const covered = layers.get(product.id) || 0;
    const missing = Number((stock - covered).toFixed(4));
    if (missing <= 0) {
      skipped += 1;
      continue;
    }

    const unitCost = num(product.averageCost) || num(product.costPrice) || 0;
    if (unitCost === 0) zeroCost += 1;

    console.log(`  ${company.name}: ${product.sku || product.id} ${product.name} — stock ${stock}, layers ${covered}, backfilling ${missing} @ ${unitCost}`);

    if (!dryRun) {
      await prisma.inventoryLayer.create({
        data: {
          id: generateObjectId(),
          companyId: company.id,
          productId: product.id,
          warehouseId: product.defaultWarehouseId || fallbackWarehouse,
          qtyReceived: missing,
          qtyRemaining: missing,
          unitCost,
          receiptDate: new Date(),
          sourceType: 'stock_backfill',
        },
      });
    }
    created += 1;
  }

  return { created, skipped, zeroCost };
}

(async () => {
  const companies = await prisma.company.findMany({
    where: onlyCompany ? { id: onlyCompany } : {},
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  if (!companies.length) {
    console.error(onlyCompany ? `No company with id ${onlyCompany}` : 'No companies found');
    process.exitCode = 1;
    return;
  }

  console.log(dryRun ? 'Dry run — nothing will be written\n' : 'Backfilling inventory layers\n');

  const totals = { created: 0, skipped: 0, zeroCost: 0 };
  for (const company of companies) {
    const result = await backfillCompany(company);
    totals.created += result.created;
    totals.skipped += result.skipped;
    totals.zeroCost += result.zeroCost;
  }

  console.log(`\n${dryRun ? 'Would create' : 'Created'} ${totals.created} layer(s); ${totals.skipped} product(s) already covered.`);
  if (totals.zeroCost) {
    console.log(`${totals.zeroCost} product(s) had no cost on record and were layered at 0 — their COGS will be zero until a purchase sets a cost.`);
  }
})()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
