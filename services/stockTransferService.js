const StockTransfer = require('../models/StockTransfer');
const StockTransferLine = require('../models/StockTransferLine');
const InventoryLayer = require('../models/InventoryLayer');
const Product = require('../models/Product');
const { dbClient } = require('../lib/prisma');
const { loadLineProducts, getLineProduct } = require('../utils/lineProducts');
const StockMovement = require('../models/StockMovement');
const { runInTransaction } = require('./transactionService');

async function _ensureActiveAndStockable(productIds, companyId) {
  const products = await loadLineProducts(Product, productIds.map((product) => ({ product })), companyId);
  for (const productId of productIds) {
    const product = products.get(String(productId));
    if (!product) throw { code: 'PRODUCT_NOT_FOUND', product: productId };
    if (!product.isActive) throw { code: 'PRODUCT_INACTIVE', product: product._id };
    if (!product.isStockable) throw { code: 'PRODUCT_NOT_STOCKABLE', product: product._id };
  }
}

async function _checkAvailability(companyId, fromWarehouse, lines) {
  // Resolve products once and aggregate all source batches in one indexed query.
  const availabilityProducts = await loadLineProducts(Product, lines, companyId);
  const productIds = [...new Set(lines.map((line) => String(line.product?._id || line.product)).filter(Boolean))];
  const batchGroups = productIds.length
    ? await dbClient().inventoryBatch.groupBy({
      by: ['productId'],
      where: { companyId: String(companyId), warehouseId: String(fromWarehouse), productId: { in: productIds } },
      _sum: { reservedQuantity: true, quantity: true },
    })
    : [];
  const availabilityByProduct = new Map(batchGroups.map((group) => [
    String(group.productId),
    {
      reserved: Number(group._sum?.reservedQuantity || 0),
      onHand: group._sum?.quantity == null ? null : Number(group._sum.quantity),
    },
  ]));
  for (const line of lines) {
    const prod = getLineProduct(availabilityProducts, line);
    if (!prod) throw { code: 'PRODUCT_NOT_FOUND', product: line.product };
    const grouped = availabilityByProduct.get(String(prod._id));
    const onHand = grouped?.onHand == null ? Number(prod.currentStock || 0) : grouped.onHand;
    const available = onHand - (grouped?.reserved || 0);
    const qty = line.qty && line.qty.toString ? Number(line.qty.toString()) : Number(line.qty || 0);
    if (available < qty) throw { code: 'INSUFFICIENT_STOCK', product: prod._id };
  }
}

async function _resolveCostsAndConsumeLots(session, companyId, fromWarehouse, lines) {
  // For each line determine unitCost and, for FIFO, consume lots and produce consumedLots array
  const results = [];
  const costingProducts = await loadLineProducts(Product, lines, companyId);
  const productIds = [...new Set(lines.map((line) => String(line.product?._id || line.product)).filter(Boolean))];
  const [costRows, layerRows] = await Promise.all([
    dbClient().warehouseInventoryCost.findMany({
      where: { companyId: String(companyId), warehouseId: String(fromWarehouse), productId: { in: productIds } },
      select: { productId: true, totalQty: true, totalValue: true },
      take: productIds.length || 1,
    }),
    InventoryLayer.find({
      company: companyId,
      warehouse: fromWarehouse,
      product: { $in: productIds },
      qtyRemaining: { $gt: 0 },
    }).sort({ receiptDate: 1, _id: 1 }).limit(500).session(session),
  ]);
  const costsByProduct = new Map(costRows.map((row) => [String(row.productId), row]));
  const layersByProduct = new Map();
  for (const layer of layerRows) {
    const key = String(layer.productId);
    const rows = layersByProduct.get(key) || [];
    rows.push(layer);
    layersByProduct.set(key, rows);
  }
  for (const line of lines) {
    const product = getLineProduct(costingProducts, line);
    const qty = Number(line.qty.toString());
    if (product.costingMethod === 'wac' || product.costingMethod === 'avg' || !product.costingMethod) {
      // Prefer per-warehouse ledger for accurate WAC; fall back to product averageCost
      const ledger = costsByProduct.get(String(product._id));
      const unitCost = ledger
        ? Number(ledger.totalQty || 0) > 0 ? Number(ledger.totalValue || 0) / Number(ledger.totalQty) : 0
        : Number(product.averageCost || 0);
      results.push({ lineId: line._id, product: product._id, qty, unitCost, consumedLots: [] });
    } else {
      // FIFO layers are loaded once for the whole transfer and consumed in order.
      const layers = layersByProduct.get(String(product._id)) || [];
      let remaining = qty;
      const consumedLots = [];
      let totalCost = 0;
      let totalQty = 0;
      for (const l of layers) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, Number(l.qtyRemaining.toString()));
        // decrement
        l.qtyRemaining = Number(l.qtyRemaining) - take;
        await l.save({ session });
        consumedLots.push({ layerId: l._id, qty: take, unitCost: Number(l.unitCost ? l.unitCost.toString() : 0), receiptDate: l.receiptDate });
        totalCost += take * (Number(l.unitCost ? l.unitCost.toString() : 0));
        totalQty += take;
        remaining -= take;
      }
      if (remaining > 0) throw { code: 'INSUFFICIENT_STOCK', product: product._id };
      const blended = totalQty > 0 ? totalCost / totalQty : 0;
      results.push({ lineId: line._id, product: product._id, qty, unitCost: blended, consumedLots });
    }
  }
  return results;
}

async function confirmTransfer(transferId, opts = {}) {
  return runInTransaction(async (session) => {
    const transfer = await StockTransfer.findById(transferId).populate('-lines').session(session);
    if (!transfer) throw { code: 'NOT_FOUND' };
    if (transfer.status !== 'draft') throw { code: 'INVALID_STATUS' };
    // load lines
    const lines = await StockTransferLine.find({ transfer: transfer._id }).session(session);
    if (transfer.fromWarehouse.toString() === transfer.toWarehouse.toString()) throw { code: 'SAME_WAREHOUSE' };
    // validations
    await _ensureActiveAndStockable(lines.map(l => l.product), transfer.company);
    await _checkAvailability(transfer.company, transfer.fromWarehouse, lines);

    // resolve costs and consume lots (mutates layers)
    const resolved = await _resolveCostsAndConsumeLots(session, transfer.company, transfer.fromWarehouse, lines);
    const productsById = await loadLineProducts(Product, lines, transfer.company);

    // create stock movements and update stock levels
    let transferValue = 0;
    for (const r of resolved) {
      const line = lines.find(x => String(x._id) === String(r.lineId));
      // update line unitCost
      line.unitCost = Number(r.unitCost) || 0;
      await line.save({ session });

      const qty = r.qty;
      const unitCost = Number(r.unitCost);
      const totalCost = qty * unitCost;
      transferValue += totalCost;

      // transfer out movement (source)
      await StockMovement.create([{ company: transfer.company, product: r.product, warehouse: transfer.fromWarehouse, type: 'out', reason: 'transfer_out', referenceType: 'other', referenceModel: 'StockTransfer', referenceDocument: transfer._id, quantity: qty, unitCost, totalCost }], { session });
      // transfer in movement (destination)
      await StockMovement.create([{ company: transfer.company, product: r.product, warehouse: transfer.toWarehouse, type: 'in', reason: 'transfer_in', referenceType: 'other', referenceModel: 'StockTransfer', referenceDocument: transfer._id, quantity: qty, unitCost, totalCost }], { session });

      // update product currentStock and warehouse-level onHand via InventoryBatch/Layer adjustments
      // Decrement source onHand (assume Product.currentStock represents company-wide; warehouse-specific handled by layers/batches already)
      const prod = productsById.get(String(r.product));
      if (!prod) throw { code: 'PRODUCT_NOT_FOUND', product: r.product };
      prod.currentStock = Number(prod.currentStock || 0) - qty;
      await prod.save({ session });

      // For destination WAC/FIFO handling: create new layers for FIFO or update averages
      if (prod.costingMethod === 'wac' || prod.costingMethod === 'avg' || !prod.costingMethod) {
        // existing value = avg_cost * existing_qty (approx)
        const existingQty = Number(prod.currentStock || 0) + qty; // note: prod.currentStock already decreased, but we'll compute destination's existing via InventoryLayer sum
        // Simple approach: skip adjusting avg here; a full implementation would track per-warehouse avg. For now, set product.averageCost to blended if necessary
        // Update: compute new average if possible
        const prevAvg = Number(prod.averageCost || 0);
        const prevQty = existingQty - qty;
        const newQty = prevQty + qty;
        const newAvg = newQty > 0 ? ((prevAvg * prevQty) + totalCost) / newQty : prevAvg;
        prod.averageCost = newAvg;
        await prod.save({ session });
      } else {
          // FIFO: create InventoryLayer entries to mirror consumed lots
          for (const lot of r.consumedLots) {
            await InventoryLayer.create([{ company: transfer.company, product: r.product, qtyReceived: lot.qty, qtyRemaining: lot.qty, originTransfer: transfer._id, originQty: lot.qty, unitCost: Number(lot.unitCost) || 0, receiptDate: new Date() , warehouse: transfer.toWarehouse }], { session });
          }
        }
    }

    // post journal if accounts differ
    // resolve accounts per product/warehouse - if multiple products, we sum values and compare predominant accounts; for simplicity use warehouse-level account first
    const fromAccount = transfer.fromWarehouse.inventory_account_id || null;
    const toAccount = transfer.toWarehouse.inventory_account_id || null;
    let journalEntry = null;
    if (fromAccount && toAccount && String(fromAccount) !== String(toAccount)) {
      journalEntry = await JournalService.postJournal(transfer.company, {
        narration: `Stock Transfer - ${transfer.fromWarehouse} to ${transfer.toWarehouse} - TRF#${transfer.transferNumber}`,
        lines: [ { account: toAccount, dr: transferValue }, { account: fromAccount, cr: transferValue } ],
      }, { session });
      transfer.journalEntry = journalEntry._id;
    } else {
      transfer.journalEntry = null;
    }

    transfer.status = 'confirmed';
    transfer.confirmedAt = new Date();
    await transfer.save({ session });

    return transfer;
  });
}

async function cancelTransfer(transferId, opts = {}) {
  return runInTransaction(async (session) => {
    const transfer = await StockTransfer.findById(transferId).session(session);
    if (!transfer) throw { code: 'NOT_FOUND' };
    if (transfer.status !== 'confirmed') throw { code: 'INVALID_STATUS' };
    // Check for downstream usage: ensure destination layers created for this transfer are untouched
    // If any destination layer created with originTransfer has been partially or fully consumed
    // or there are any subsequent 'out' movements at destination after confirmation, block cancellation.
    if (!transfer.confirmedAt) throw { code: 'INVALID_TRANSFER_STATE' };
    const destLayers = await InventoryLayer.find({ originTransfer: transfer._id, warehouse: transfer.toWarehouse }).session(session);
    for (const dl of destLayers) {
      const originQty = dl.originQty !== undefined && dl.originQty !== null ? Number(dl.originQty.toString()) : null;
      const remaining = dl.qtyRemaining !== undefined && dl.qtyRemaining !== null ? Number(dl.qtyRemaining.toString()) : null;
      if (originQty === null || remaining === null) {
        // defensive: if shape unexpected, treat as used
        throw { code: 'DOWNSTREAM_USAGE', product: dl.product };
      }
      if (remaining !== originQty) {
        throw { code: 'DOWNSTREAM_USAGE', product: dl.product };
      }
      // also check for any subsequent out movements at destination for this product after confirmedAt
      const laterOuts = await StockMovement.countDocuments({ company: transfer.company, product: dl.product, warehouse: transfer.toWarehouse, type: 'out', movementDate: { $gt: transfer.confirmedAt } }).session(session);
      if (laterOuts > 0) throw { code: 'DOWNSTREAM_USAGE', product: dl.product };
    }

    // Create reverse movements
    const lines = await StockTransferLine.find({ transfer: transfer._id }).session(session);
    for (const line of lines) {
      const qty = Number(line.qty.toString());
      const unitCost = line.unitCost ? Number(line.unitCost.toString()) : 0;
      const totalCost = qty * unitCost;
      await StockMovement.create([{ company: transfer.company, product: line.product, warehouse: transfer.toWarehouse, type: 'out', reason: 'transfer_out', referenceType: 'other', referenceModel: 'StockTransfer', referenceDocument: transfer._id, quantity: qty, unitCost, totalCost }], { session });
      await StockMovement.create([{ company: transfer.company, product: line.product, warehouse: transfer.fromWarehouse, type: 'in', reason: 'transfer_in', referenceType: 'other', referenceModel: 'StockTransfer', referenceDocument: transfer._id, quantity: qty, unitCost, totalCost }], { session });
      // restore product currentStock
      const prod = await Product.findById(line.product).session(session);
      prod.currentStock = Number(prod.currentStock || 0) + qty;
      await prod.save({ session });
    }

    // reverse journal if present
    if (transfer.journalEntry) {
      await JournalService.reverse(transfer.journalEntry, { session });
    }

    transfer.status = 'cancelled';
    await transfer.save({ session });
    return transfer;
  });
}

const DEFAULT_ACCOUNTS = require('../constants/chartOfAccounts').DEFAULT_ACCOUNTS;

// Dependencies (can be injected in tests)
let JournalService = require('./journalService');
let InventoryService = require('./inventoryService');

function __setDependencies(deps = {}) {
  if (deps.JournalService) JournalService = deps.JournalService;
  if (deps.InventoryService) InventoryService = deps.InventoryService;
}

async function createStockTransfer(tx, opts = {}) {
  // tx: { _id, company, fromWarehouse, toWarehouse, lines: [{ product, qty, unitCost }] }
  if (!tx || !tx.lines) throw new Error('invalid payload');
  if (String(tx.fromWarehouse) === String(tx.toWarehouse)) throw new Error('source and destination must differ');

  const createdMovements = [];
  try {
    // Create an 'out' movement and an 'in' movement per line
    for (const line of tx.lines) {
      // decrease from-warehouse
      if (InventoryService && InventoryService.createMovement) {
        const out = await InventoryService.createMovement({ company: tx.company, product: line.product, warehouse: tx.fromWarehouse, type: 'out', reason: 'transfer', quantity: line.qty, unitCost: line.unitCost, reference: tx._id });
        createdMovements.push(out);
      }
      // increase to-warehouse
      if (InventoryService && InventoryService.createMovement) {
        const inp = await InventoryService.createMovement({ company: tx.company, product: line.product, warehouse: tx.toWarehouse, type: 'in', reason: 'transfer', quantity: line.qty, unitCost: line.unitCost, reference: tx._id });
        createdMovements.push(inp);
      }
    }

    // Post journal only if accounts differ (e.g., inter-warehouse COGS mapping)
    const fromAcct = await (JournalService.getMappedAccountCode ? JournalService.getMappedAccountCode(tx.company, 'inventory', 'transferFrom', DEFAULT_ACCOUNTS.inventory) : DEFAULT_ACCOUNTS.inventory);
    const toAcct = await (JournalService.getMappedAccountCode ? JournalService.getMappedAccountCode(tx.company, 'inventory', 'transferTo', DEFAULT_ACCOUNTS.inventory) : DEFAULT_ACCOUNTS.inventory);

    if (String(fromAcct) !== String(toAcct)) {
      // compute total value
      const total = tx.lines.reduce((s, l) => s + (Number(l.unitCost || 0) * Number(l.qty || 0)), 0);
      const entryOptions = {
        date: new Date(),
        description: `Stock Transfer ${tx._id}`,
        sourceType: 'stock_transfer',
        sourceId: tx._id,
        sourceReference: tx._id,
        lines: [ JournalService.createDebitLine ? JournalService.createDebitLine(toAcct, total) : { accountCode: toAcct, debit: total }, JournalService.createCreditLine ? JournalService.createCreditLine(fromAcct, total) : { accountCode: fromAcct, credit: total } ],
        isAutoGenerated: true
      };

      // Prefer atomic multi-entry API when available; otherwise fall back to single-entry create
      if (JournalService.createEntriesAtomic) {
        const created = await JournalService.createEntriesAtomic(tx.company, (opts.user && opts.user.id) || null, [entryOptions], { session: opts.session || null });
        const je = created && created.length ? created[0] : null;
        tx.journalEntryId = je && (je._id || je.id) ? (je._id || je.id) : null;
      } else {
        const je = await JournalService.createEntry(tx.company, (opts.user && opts.user.id) || null, entryOptions, opts.session ? { session: opts.session } : undefined);
        tx.journalEntryId = je && (je._id || je.id) ? (je._id || je.id) : null;
      }
    }

    tx.status = 'completed';
    return tx;
  } catch (err) {
    // Attempt rollback of createdMovements if inventory service supports reversal
    if (InventoryService && InventoryService.reverseMovements && createdMovements.length) {
      try { await InventoryService.reverseMovements(createdMovements); } catch (e) { /* swallow */ }
    }
    throw err;
  }
}

module.exports = { confirmTransfer, cancelTransfer, createStockTransfer, __setDependencies };
