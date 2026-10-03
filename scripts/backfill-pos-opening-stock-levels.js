'use strict';

require('dotenv').config();

const { connectPrisma, disconnectPrisma, dbClient } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');

const PAGE_SIZE = 400;
const APPLY = process.argv.includes('--apply');

async function main() {
  await connectPrisma();
  const db = dbClient();
  const candidates = [];
  let cursor;

  // Opening stock created before StockLevel synchronization was added only
  // populated the product aggregate and inventory batch. Repair only products
  // whose entire warehouse movement history is that single opening movement;
  // anything with later movement needs a full stock reconciliation instead.
  // Also repair its FIFO layer: older opening-stock code wrote that layer
  // without warehouseId, while POS correctly filters costs by warehouse.
  while (true) {
    const movements = await db.stockMovement.findMany({
      where: { reason: 'initial_stock', type: 'in' },
      select: {
        id: true,
        companyId: true,
        productId: true,
        warehouseId: true,
        quantity: true,
        unitCost: true,
        movementDate: true,
        product: { select: { name: true, sku: true } },
      },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!movements.length) break;
    cursor = movements[movements.length - 1].id;

    for (const movement of movements) {
      if (!movement.companyId || !movement.productId || !movement.warehouseId) continue;
      const where = {
        companyId: movement.companyId,
        productId: movement.productId,
        warehouseId: movement.warehouseId,
      };
      const productWhere = { companyId: movement.companyId, productId: movement.productId };
      const [warehouseMovements, warehouseLevels, layers] = await Promise.all([
        db.stockMovement.findMany({
          where: productWhere,
          select: { id: true, warehouseId: true, type: true, reason: true, quantity: true },
        }),
        db.stockLevel.findMany({
          where: productWhere,
          select: { id: true, warehouseId: true, qtyOnHand: true, qtyReserved: true },
        }),
        db.inventoryLayer.findMany({
          where: productWhere,
          select: { id: true, warehouseId: true, qtyReceived: true, qtyRemaining: true, sourceId: true },
        }),
      ]);
      const quantity = Number(movement.quantity);
      const relevantMovements = warehouseMovements.filter((row) => row.warehouseId === movement.warehouseId || row.warehouseId == null);
      const openingMovements = relevantMovements.filter((row) => row.reason === 'initial_stock');
      const safeReasons = relevantMovements.length === warehouseMovements.length && relevantMovements.every((row) =>
        row.reason === 'initial_stock' || (row.reason === 'sale' && ['in', 'out'].includes(row.type)));
      if (openingMovements.length !== 1 || !safeReasons || !Number.isFinite(quantity) || quantity <= 0) continue;
      const expectedOnHand = relevantMovements.reduce((total, row) => {
        const qty = Number(row.quantity) || 0;
        return total + (row.type === 'out' ? -qty : row.type === 'in' ? qty : 0);
      }, 0);
      const level = warehouseLevels.find((row) => row.warehouseId === movement.warehouseId);
      if (warehouseLevels.some((row) => row.warehouseId !== movement.warehouseId && Number(row.qtyOnHand) > 0)) continue;
      if (layers.length !== 1 || layers[0].sourceId !== movement.id || Number(layers[0].qtyReceived) !== quantity) continue;
      const saleDelta = relevantMovements.filter((row) => row.reason === 'sale')
        .reduce((total, row) => total + (row.type === 'out' ? Number(row.quantity) || 0 : -(Number(row.quantity) || 0)), 0);
      const expectedLayerRemaining = quantity - saleDelta;
      if (expectedOnHand < 0 || expectedLayerRemaining < 0 || Number(layers[0].qtyRemaining) !== expectedLayerRemaining) continue;
      const stockAction = !level
        ? 'create'
        : Number(level.qtyOnHand) === expectedOnHand
          ? null
          : Number(level.qtyReserved) === 0 && [0, quantity].includes(Number(level.qtyOnHand))
            ? 'update'
            : null;
      const layerAction = layers[0].warehouseId == null ? 'assign' : null;
      if (!stockAction && !layerAction) continue;
      candidates.push({ movement, where, quantity, expectedOnHand, expectedLayerRemaining, previousOnHand: level ? Number(level.qtyOnHand) : null, unitCost: Number(movement.unitCost) || 0, stockAction, layerAction, layerId: layers[0].id });
    }

    if (movements.length < PAGE_SIZE) break;
  }

  console.log(`${APPLY ? 'Applying' : 'Dry run'}: ${candidates.length} safe opening-stock warehouse record(s) found.`);
  if (!APPLY) {
    for (const { movement, stockAction, layerAction, expectedOnHand, expectedLayerRemaining } of candidates) {
      console.log(`- ${movement.product?.sku || movement.productId} ${movement.product?.name || ''}: stock=${stockAction ? `${stockAction} to ${expectedOnHand}` : 'ok'}, cost-layer=${layerAction ? `assign (${expectedLayerRemaining} remaining)` : 'ok'}`);
    }
    console.log('No database rows were changed. Re-run with --apply to repair the listed warehouse stock and opening FIFO layers.');
    return;
  }

  let repaired = 0;
  for (const candidate of candidates) {
    const { movement, where, quantity, expectedOnHand, expectedLayerRemaining, previousOnHand, unitCost, stockAction, layerAction, layerId } = candidate;
    const didRepair = await db.$transaction(async (tx) => {
      let changed = false;
      if (stockAction === 'update') {
        const result = await tx.stockLevel.updateMany({
          where: { ...where, qtyOnHand: previousOnHand, qtyReserved: 0 },
          data: {
            qtyOnHand: expectedOnHand,
            avgCost: unitCost,
            totalValue: quantity * unitCost,
            lastMovementAt: movement.movementDate,
            lastMovementType: 'initial_stock',
          },
        });
        changed ||= result.count > 0;
      } else if (stockAction === 'create') {
        await tx.stockLevel.upsert({
          where: { companyId_productId_warehouseId: where },
          create: {
            id: generateObjectId(),
            ...where,
            qtyOnHand: quantity,
            qtyReserved: 0,
            qtyOnOrder: 0,
            avgCost: unitCost,
            totalValue: quantity * unitCost,
            lastMovementAt: movement.movementDate,
            lastMovementType: 'initial_stock',
          },
          update: {},
        });
        changed = true;
      }
      if (layerAction === 'assign') {
        const result = await tx.inventoryLayer.updateMany({
          where: { id: layerId, companyId: movement.companyId, sourceId: movement.id, warehouseId: null, qtyReceived: quantity, qtyRemaining: expectedLayerRemaining },
          data: { warehouseId: movement.warehouseId },
        });
        changed ||= result.count > 0;
      } else if (layerAction === 'create') {
        const existingLayer = await tx.inventoryLayer.findFirst({
          where: { companyId: movement.companyId, productId: movement.productId, sourceId: movement.id },
          select: { id: true },
        });
        if (!existingLayer) {
          await tx.inventoryLayer.create({
            data: {
              id: generateObjectId(),
              companyId: movement.companyId,
              productId: movement.productId,
              warehouseId: movement.warehouseId,
              qtyReceived: quantity,
              qtyRemaining: quantity,
              unitCost,
              receiptDate: movement.movementDate,
              sourceType: 'opening_stock',
              sourceId: movement.id,
            },
          });
          changed = true;
        }
      }
      return changed;
    });
    if (didRepair) repaired += 1;
  }
  console.log(`Repaired ${repaired} warehouse stock record(s).`);
}

main()
  .catch((error) => {
    console.error('POS opening-stock backfill failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
