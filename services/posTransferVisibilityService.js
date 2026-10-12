'use strict';

const { dbClient } = require('../lib/prisma');

async function getWarehouseTransferVisibility(companyId, warehouseId, productIds = []) {
  if (!warehouseId || !productIds.length) return {};
  const rows = await dbClient().$queryRawUnsafe(
    `SELECT line.product_id AS "productId",
            transfer.transfer_number AS "transferNumber",
            transfer.status,
            transfer.confirmed_at AS "dispatchedAt",
            transfer.expected_arrival_at AS "expectedArrivalAt",
            CASE WHEN transfer.to_warehouse_id = $1 THEN 'incoming' ELSE 'outgoing' END AS direction,
            other_warehouse.name AS "otherWarehouseName",
            SUM(line.in_transit_qty)::numeric AS quantity
       FROM stock_transfers transfer
       JOIN stock_transfer_lines line
         ON line.transfer_id = transfer.id
        AND line.company_id = transfer.company_id
       JOIN warehouses other_warehouse
         ON other_warehouse.id = CASE
              WHEN transfer.to_warehouse_id = $1 THEN transfer.from_warehouse_id
              ELSE transfer.to_warehouse_id
            END
        AND other_warehouse.company_id = transfer.company_id
      WHERE transfer.company_id = $2
        AND transfer.status = 'in_transit'
        AND (transfer.from_warehouse_id = $1 OR transfer.to_warehouse_id = $1)
        AND line.product_id = ANY($3::char(24)[])
        AND line.in_transit_qty > 0
      GROUP BY line.product_id, transfer.id, other_warehouse.name
      ORDER BY transfer.confirmed_at ASC, transfer.transfer_number ASC
      LIMIT 1000`,
    String(warehouseId),
    String(companyId),
    productIds.map(String),
  );
  const byProduct = {};
  for (const row of rows) {
    const productId = String(row.productId);
    const productTransfers = byProduct[productId] || { incoming: [], outgoing: [] };
    const direction = row.direction === 'incoming' ? 'incoming' : 'outgoing';
    productTransfers[direction].push({
      transferNumber: String(row.transferNumber),
      status: String(row.status),
      quantity: Number(row.quantity) || 0,
      otherWarehouseName: String(row.otherWarehouseName || ''),
      dispatchedAt: row.dispatchedAt ? new Date(row.dispatchedAt).toISOString() : null,
      expectedArrivalAt: row.expectedArrivalAt ? new Date(row.expectedArrivalAt).toISOString() : null,
    });
    byProduct[productId] = productTransfers;
  }
  return byProduct;
}

module.exports = { getWarehouseTransferVisibility };
