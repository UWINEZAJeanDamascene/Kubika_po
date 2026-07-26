const mongoose = require('mongoose');
const InventoryLayer = require('../models/InventoryLayer');
const Product = require('../models/Product');
const InventoryBatch = require('../models/InventoryBatch');

/**
 * Create a receipt layer (called when goods are received)
 */
async function createLayer(companyId, productId, qty, unitCost, sourceRef = {}, options = {}) {
  const session = options.session || null;
  const qtyReceived = Number(qty);
  if (!Number.isFinite(qtyReceived) || qtyReceived <= 0) {
    throw new Error('Inventory layer requires a positive qtyReceived');
  }
  const layer = new InventoryLayer({
    company: companyId,
    product: productId,
    qtyReceived,
    qtyRemaining: qtyReceived,
    unitCost: Number(unitCost) || 0,
    receiptDate: options.receiptDate || new Date(),
    sourceRef,
    ...(options.warehouse ? { warehouse: options.warehouse } : {}),
    createdBy: options.userId
  });
  return layer.save({ session });
}

/**
 * Draw down FIFO layers by up to `qty` without failing when they hold less.
 * Used for stock reductions that are not sales (adjustments, write-offs), where
 * Product.currentStock is authoritative and the layers only carry cost.
 *
 * @returns {Promise<{ consumed: number, shortfall: number }>}
 */
async function reduceLayers(companyId, productId, qty, options = {}) {
  if (qty <= 0) return { consumed: 0, shortfall: 0 };
  const session = options.session || null;

  const layers = await InventoryLayer.find({
    company: companyId,
    product: productId,
    qtyRemaining: { $gt: 0 }
  })
    .sort({ receiptDate: 1 })
    .session(session);

  let remaining = qty;
  for (const layer of layers) {
    if (remaining <= 0) break;
    const take = Math.min(Number(layer.qtyRemaining) || 0, remaining);
    layer.qtyRemaining = Math.max(0, Number(layer.qtyRemaining) - take);
    await layer.save({ session });
    remaining -= take;
  }

  return { consumed: qty - remaining, shortfall: remaining };
}

/**
 * Consume inventory for a product using the given valuation method.
 * valuationMethod: 'fifo' (default) | 'weighted'
 * Returns { totalCost, allocations: [{ layerId, qty, unitCost, amount }] }
 */
async function consume(companyId, productId, qty, opts = {}) {
  const valuationMethod = opts.method || 'fifo';
  if (qty <= 0) return { totalCost: 0, allocations: [] };

  const session = opts.session || null;
  try {

    if (valuationMethod === 'weighted') {
      // Use product.averageCost
      const product = await Product.findOne({ _id: productId, company: companyId }).session(session);
      if (!product) throw new Error('Product not found');
      // product.averageCost may be Decimal128; coerce to Number for internal calculations
      const unitCostRaw = product.averageCost;
      const unitCost = unitCostRaw == null ? 0 : Number(unitCostRaw.toString ? unitCostRaw.toString() : unitCostRaw);
      // NOTE: WA does not update layers; it relies on averageCost stored on product
      // Decrementing physical stock is handled by StockMovement elsewhere
      const totalCost = unitCost * qty;
      return { totalCost, allocations: [{ layerId: null, qty, unitCost, amount: totalCost }] };
    }

    // FIFO
    const layers = await InventoryLayer.find({ company: companyId, product: productId, qtyRemaining: { $gt: 0 } })
      .sort({ receiptDate: 1 })
      .session(session);

    let remaining = qty;
    const allocations = [];
    for (const layer of layers) {
      if (remaining <= 0) break;
      const take = Math.min(layer.qtyRemaining, remaining);
      const amount = take * layer.unitCost;
      allocations.push({ layerId: layer._id, qty: take, unitCost: layer.unitCost, amount });
      layer.qtyRemaining = Math.max(0, layer.qtyRemaining - take);
      await layer.save({ session });
      remaining -= take;
    }

    if (remaining > 0) {
      const err = new Error('Insufficient stock to consume');
      err.code = 'INSUFFICIENT_STOCK';
      err.requested = qty;
      err.costedQty = qty - remaining;
      throw err;
    }

    const totalCost = allocations.reduce((s, a) => s + a.amount, 0);
    // caller is responsible for transaction/session management; commit if provided externally
    return { totalCost, allocations };
  } catch (err) {
    // If caller provided a session they should handle abort; just rethrow
    throw err;
  } finally {
    // nothing to cleanup here
  }
}

module.exports = { createLayer, consume };

/**
 * Reserve quantity across InventoryBatch entries (FIFO by receivedDate).
 * Returns allocations: [{ batchId, qty }]
 */
async function reserveBatches(companyId, productId, qty, options = {}) {
  if (qty <= 0) return { allocations: [], total: 0 };
  const session = options.session || null;
  let remaining = qty;
  const allocations = [];

  const batches = await InventoryBatch.find({ company: companyId, product: productId, availableQuantity: { $gt: 0 } })
    .sort({ receivedDate: 1 })
    .session(session);

  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = Math.min(batch.availableQuantity, remaining);
    if (take <= 0) continue;
    batch.availableQuantity = Math.max(0, batch.availableQuantity - take);
    batch.reservedQuantity = (batch.reservedQuantity || 0) + take;
    await batch.save({ session });
    allocations.push({ batchId: batch._id, qty: take });
    remaining -= take;
  }

  if (remaining > 0) {
    const err = new Error('Insufficient available batches to reserve');
    err.code = 'INSUFFICIENT_STOCK';
    throw err;
  }

  return { allocations, total: qty };
}

/**
 * Release reserved quantity across InventoryBatch entries (FIFO by receivedDate).
 * qty is amount to release back to available (reduce reservedQuantity).
 */
async function releaseReservedBatches(companyId, productId, qty, options = {}) {
  if (qty <= 0) return { allocations: [], total: 0 };
  const session = options.session || null;
  let remaining = qty;
  const allocations = [];

  // Release from batches that have reservedQuantity > 0 in FIFO order
  const batches = await InventoryBatch.find({ company: companyId, product: productId, reservedQuantity: { $gt: 0 } })
    .sort({ receivedDate: 1 })
    .session(session);

  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = Math.min(batch.reservedQuantity, remaining);
    if (take <= 0) continue;
    batch.reservedQuantity = Math.max(0, batch.reservedQuantity - take);
    // When releasing reservation back to available, increase availableQuantity
    batch.availableQuantity = (batch.availableQuantity || 0) + take;
    await batch.save({ session });
    allocations.push({ batchId: batch._id, qty: take });
    remaining -= take;
  }

  if (remaining > 0) {
    const err = new Error('Insufficient reserved quantity to release');
    err.code = 'INSUFFICIENT_RESERVED';
    throw err;
  }

  return { allocations, total: qty };
}

/**
 * Consume reserved quantities from batches when goods are fulfilled.
 * This reduces reservedQuantity (and optionally quantity) but does NOT increase availableQuantity.
 */
async function consumeReservedBatches(companyId, productId, qty, options = {}) {
  if (qty <= 0) return { allocations: [], total: 0 };
  const session = options.session || null;
  let remaining = qty;
  const allocations = [];

  const batches = await InventoryBatch.find({ company: companyId, product: productId, reservedQuantity: { $gt: 0 } })
    .sort({ receivedDate: 1 })
    .session(session);

  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = Math.min(batch.reservedQuantity, remaining);
    if (take <= 0) continue;
    batch.reservedQuantity = Math.max(0, batch.reservedQuantity - take);
    // Also decrease total quantity if tracked (keep availableQuantity unchanged because it was decreased at reservation)
    batch.quantity = Math.max(0, (batch.quantity || 0) - take);
    batch.totalCost = (batch.unitCost || 0) * (batch.quantity || 0);
    batch.updateStatus && batch.updateStatus();
    await batch.save({ session });
    allocations.push({ batchId: batch._id, qty: take });
    remaining -= take;
  }

  if (remaining > 0) {
    const err = new Error('Insufficient reserved quantity to consume');
    err.code = 'INSUFFICIENT_RESERVED';
    throw err;
  }

  return { allocations, total: qty };
}

module.exports = {
  createLayer,
  reduceLayers,
  consume,
  reserveBatches,
  releaseReservedBatches,
  consumeReservedBatches,
  reverseConsume,
};

/**
 * Reverse a consumption by adding back to inventory layers.
 * This is used when cancelling a delivery note.
 * Returns { allocations: [{ layerId, qtyAdded }] }
 * 
 * Note: This function adds to InventoryLayer.qtyRemaining for FIFO tracking.
 * The caller is responsible for updating Product.currentStock.
 */
async function reverseConsume(companyId, productId, qty, opts = {}) {
  if (qty <= 0) return { allocations: [], totalAdded: 0 };
  
  const session = opts.session || null;
  const warehouse = opts.warehouse || null;
  
  // For FIFO, we need to add back to the oldest layers (FIFO reversal)
  // Find layers sorted by receiptDate ASC (oldest first) to restore to
  const layers = await InventoryLayer.find({
    company: companyId,
    product: productId,
    ...(warehouse && { warehouse })
  })
  .sort({ receiptDate: 1 }) // FIFO: restore to oldest layers first
  .session(session);
  
  if (layers.length === 0) {
    // No layers found - create a new layer with unknown cost
    const layer = new InventoryLayer({
      company: companyId,
      product: productId,
      qtyReceived: qty,
      qtyRemaining: qty,
      unitCost: 0,
      receiptDate: new Date(),
      sourceRef: { type: 'delivery_reversal' },
      ...(warehouse && { warehouse })
    });
    await layer.save({ session });
    return { allocations: [{ layerId: layer._id, qtyAdded: qty }], totalAdded: qty };
  }
  
  let remaining = qty;
  const allocations = [];
  
  // Add back to layers in FIFO order (oldest first)
  for (const layer of layers) {
    if (remaining <= 0) break;
    
    const addBack = remaining;
    layer.qtyRemaining = (layer.qtyRemaining || 0) + addBack;
    await layer.save({ session });
    
    allocations.push({ layerId: layer._id, qtyAdded: addBack });
    remaining -= addBack;
  }
  
  return { allocations, totalAdded: qty - remaining };
}
