/**
 * Resolve stockable-product unit cost for COGS (FIFO peek / WAC / product fallback).
 * Accepts both Prisma field names and legacy Mongo aliases.
 */

function toNum(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'object' && typeof value.toString === 'function') {
    const n = parseFloat(value.toString());
    return Number.isFinite(n) ? n : 0;
  }
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function costingMethodOf(product) {
  const raw = String(product?.costingMethod || product?.costMethod || 'fifo').toLowerCase();
  if (raw === 'wac' || raw === 'avg' || raw === 'average' || raw === 'weighted_average') {
    return 'wac';
  }
  return 'fifo';
}

/** Product-level cost fallbacks (Prisma + legacy). */
function productFallbackUnitCost(product) {
  return (
    toNum(product?.averageCost)
    || toNum(product?.avgCost)
    || toNum(product?.costPrice)
    || toNum(product?.cost)
    || 0
  );
}

/**
 * Peek COGS unit cost without consuming inventory layers.
 * @param {object} product
 * @param {string} companyId
 * @returns {Promise<number>}
 */
async function resolveCogsUnitCost(product, companyId) {
  if (!product) return 0;

  const method = costingMethodOf(product);
  const productId = product._id || product.id;

  if (method === 'fifo' && productId) {
    try {
      const InventoryLayer = require('../models/InventoryLayer');
      const oldestLayer = await InventoryLayer.findOne({
        company: companyId,
        product: productId,
        qtyRemaining: { $gt: 0 },
      }).sort({ receiptDate: 1 });

      if (oldestLayer) {
        const layerCost = toNum(oldestLayer.unitCost);
        if (layerCost > 0) return layerCost;
      }
    } catch (err) {
      console.warn('[resolveCogsUnitCost] FIFO layer peek failed:', err.message);
    }
  }

  return productFallbackUnitCost(product);
}

module.exports = {
  toNum,
  costingMethodOf,
  productFallbackUnitCost,
  resolveCogsUnitCost,
};
