'use strict';

const { dbClient } = require('../lib/prisma');

async function getWarehousePriceListPrices(companyId, warehouseId, productIds = []) {
  if (!warehouseId) return { priceListId: null, priceByProduct: new Map() };
  const rows = await dbClient().$queryRawUnsafe(
    `SELECT w.price_list_id AS "priceListId", pli.product_id AS "productId", pli.price
       FROM warehouses w
       LEFT JOIN price_list_items pli
         ON pli.price_list_id = w.price_list_id
        AND pli.company_id = w.company_id
        AND pli.product_id = ANY($3::char(24)[])
      WHERE w.id = $1 AND w.company_id = $2
      LIMIT 5001`,
    String(warehouseId),
    String(companyId),
    productIds.map(String),
  );
  const priceByProduct = new Map();
  for (const row of rows) {
    if (row.productId) priceByProduct.set(String(row.productId), Number(row.price));
  }
  return {
    priceListId: rows[0]?.priceListId ? String(rows[0].priceListId) : null,
    priceByProduct,
  };
}

function effectivePrice(productId, standardPrice, priceByProduct) {
  const listedPrice = priceByProduct?.get(String(productId));
  return listedPrice == null ? Number(standardPrice) || 0 : Number(listedPrice);
}

module.exports = { getWarehousePriceListPrices, effectivePrice };
