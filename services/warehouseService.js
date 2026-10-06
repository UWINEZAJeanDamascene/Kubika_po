/**
 * Company and warehouse stock availability/reservation operations.
 * All reservations use atomic conditional updates so concurrent checkouts cannot
 * reserve the same units twice.
 */

const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('./transactionService');

function asId(value) {
  return String(value?._id || value?.id || value || '');
}

function validateQuantity(quantity) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw Object.assign(new Error('Quantity must be a positive number'), { code: 'ERR_INVALID_QUANTITY' });
  }
  return qty;
}

function insufficientStock(message = 'Insufficient stock available') {
  return Object.assign(new Error(message), { code: 'ERR_INSUFFICIENT_STOCK' });
}

async function getStockLevel(companyId, productId, warehouseId) {
  const company = asId(companyId);
  const product = asId(productId);
  if (warehouseId) {
    const warehouse = asId(warehouseId);
    const rows = await dbClient().$queryRaw`
      SELECT qty_on_hand::double precision AS "qtyOnHand",
             qty_reserved::double precision AS "qtyReserved",
             GREATEST(qty_on_hand - qty_reserved, 0)::double precision AS "qtyAvailable"
      FROM stock_levels
      WHERE company_id = ${company} AND product_id = ${product} AND warehouse_id = ${warehouse}
      LIMIT 1`;
    const row = rows[0];
    const onHand = Number(row?.qtyOnHand || 0);
    const reserved = Number(row?.qtyReserved || 0);
    return {
      qty_available: Number(row?.qtyAvailable || 0),
      qty_reserved: reserved,
      qty_on_hand: onHand,
    };
  }

  const rows = await dbClient().$queryRaw`
    SELECT current_stock::double precision AS "qtyOnHand",
           reserved_quantity::double precision AS "qtyReserved",
           GREATEST(current_stock - reserved_quantity, 0)::double precision AS "qtyAvailable"
    FROM products WHERE id = ${product} AND company_id = ${company} LIMIT 1`;
  const row = rows[0];
  return {
    qty_available: Number(row?.qtyAvailable || 0),
    qty_reserved: Number(row?.qtyReserved || 0),
    qty_on_hand: Number(row?.qtyOnHand || 0),
  };
}

/** Reserve a product at a specific warehouse, or from the company-wide legacy pool. */
async function reserveStock(companyId, productId, warehouseId, quantity) {
  const qty = validateQuantity(quantity);
  const company = asId(companyId);
  const product = asId(productId);
  return runInTransaction(async () => {
    if (warehouseId) {
      const warehouse = asId(warehouseId);
      const updated = await dbClient().$queryRaw`
        UPDATE stock_levels
        SET qty_reserved = qty_reserved + ${qty}, updated_at = NOW()
        WHERE company_id = ${company} AND product_id = ${product} AND warehouse_id = ${warehouse}
          AND qty_on_hand - qty_reserved >= ${qty}
        RETURNING qty_reserved::double precision AS "qtyReserved"`;
      if (!updated.length) throw insufficientStock();

      // Product quantity is a company-wide denormalized mirror. The level above
      // remains authoritative for warehouse allocation.
      await dbClient().$executeRaw`
        UPDATE products SET reserved_quantity = reserved_quantity + ${qty}, updated_at = NOW()
        WHERE id = ${product} AND company_id = ${company}`;
      return { success: true, qtyReserved: Number(updated[0].qtyReserved) };
    }

    const updated = await dbClient().$queryRaw`
      UPDATE products
      SET reserved_quantity = reserved_quantity + ${qty}, updated_at = NOW()
      WHERE id = ${product} AND company_id = ${company}
        AND current_stock - reserved_quantity >= ${qty}
      RETURNING reserved_quantity::double precision AS "qtyReserved"`;
    if (!updated.length) throw insufficientStock();
    return { success: true, qtyReserved: Number(updated[0].qtyReserved) };
  });
}

/** Release exactly the reservation for this order; never silently release more. */
async function releaseStock(companyId, productId, warehouseId, quantity) {
  const qty = validateQuantity(quantity);
  const company = asId(companyId);
  const product = asId(productId);
  return runInTransaction(async () => {
    if (warehouseId) {
      const warehouse = asId(warehouseId);
      const updated = await dbClient().$queryRaw`
        UPDATE stock_levels
        SET qty_reserved = qty_reserved - ${qty}, updated_at = NOW()
        WHERE company_id = ${company} AND product_id = ${product} AND warehouse_id = ${warehouse}
          AND qty_reserved >= ${qty}
        RETURNING qty_reserved::double precision AS "qtyReserved"`;
      if (!updated.length) {
        throw Object.assign(new Error('The warehouse does not contain this full reservation'), { code: 'ERR_RESERVATION_NOT_FOUND' });
      }
      await dbClient().$executeRaw`
        UPDATE products SET reserved_quantity = GREATEST(reserved_quantity - ${qty}, 0), updated_at = NOW()
        WHERE id = ${product} AND company_id = ${company}`;
      return { success: true, qtyReserved: Number(updated[0].qtyReserved) };
    }

    const updated = await dbClient().$queryRaw`
      UPDATE products
      SET reserved_quantity = reserved_quantity - ${qty}, updated_at = NOW()
      WHERE id = ${product} AND company_id = ${company} AND reserved_quantity >= ${qty}
      RETURNING reserved_quantity::double precision AS "qtyReserved"`;
    if (!updated.length) {
      throw Object.assign(new Error('The product does not contain this full reservation'), { code: 'ERR_RESERVATION_NOT_FOUND' });
    }
    return { success: true, qtyReserved: Number(updated[0].qtyReserved) };
  });
}

/** Consume reserved units and on-hand stock together. */
async function commitReservedStock(companyId, productId, warehouseId, quantity) {
  const qty = validateQuantity(quantity);
  const company = asId(companyId);
  const product = asId(productId);
  return runInTransaction(async () => {
    if (warehouseId) {
      const warehouse = asId(warehouseId);
      const updated = await dbClient().$queryRaw`
        UPDATE stock_levels
        SET qty_on_hand = qty_on_hand - ${qty},
            qty_reserved = qty_reserved - ${qty},
            total_value = ROUND(GREATEST(qty_on_hand - ${qty}, 0) * avg_cost, 2),
            last_movement_at = NOW(), last_movement_type = 'dispatch', updated_at = NOW()
        WHERE company_id = ${company} AND product_id = ${product} AND warehouse_id = ${warehouse}
          AND qty_on_hand >= ${qty} AND qty_reserved >= ${qty}
        RETURNING qty_on_hand::double precision AS "currentStock",
                  qty_reserved::double precision AS "qtyReserved"`;
      if (!updated.length) throw insufficientStock('The warehouse reservation or on-hand quantity is no longer available');
      const productRows = await dbClient().$queryRaw`
        UPDATE products
        SET current_stock = current_stock - ${qty},
            reserved_quantity = GREATEST(reserved_quantity - ${qty}, 0), updated_at = NOW()
        WHERE id = ${product} AND company_id = ${company} AND current_stock >= ${qty}
        RETURNING current_stock::double precision AS "currentStock",
                  reserved_quantity::double precision AS "qtyReserved"`;
      if (!productRows.length) throw insufficientStock();
      return { success: true, ...productRows[0], warehouseStock: Number(updated[0].currentStock) };
    }

    const updated = await dbClient().$queryRaw`
      UPDATE products
      SET current_stock = current_stock - ${qty},
          reserved_quantity = reserved_quantity - ${qty}, updated_at = NOW()
      WHERE id = ${product} AND company_id = ${company}
        AND current_stock >= ${qty} AND reserved_quantity >= ${qty}
      RETURNING current_stock::double precision AS "currentStock",
                reserved_quantity::double precision AS "qtyReserved"`;
    if (!updated.length) throw insufficientStock('The reservation or on-hand quantity is no longer available');
    return { success: true, ...updated[0] };
  });
}

module.exports = {
  getStockLevel,
  reserveStock,
  releaseStock,
  commitReservedStock,
};
