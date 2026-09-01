const mongoose = require('mongoose');
const Decimal = mongoose.Types.Decimal128;
const StockTransfer = require('../models/StockTransfer');
const StockTransferLine = require('../models/StockTransferLine');
const InventoryBatch = require('../models/InventoryBatch');
const InventoryLayer = require('../models/InventoryLayer');
const Product = require('../models/Product');
const { loadLineProducts, getLineProduct } = require('../utils/lineProducts');
const StockMovement = require('../models/StockMovement');
const { runInTransaction } = require('./transactionService');
const WarehouseInventoryCost = require('../models/WarehouseInventoryCost');
const { aggregateWithTimeout } = require('../utils/mongoAggregation');

async function _ensureActiveAndStockable(productIds) {
  const prods = await Product.find({ _id: { $in: productIds } });
  for (const p of prods) {
    if (!p.isActive) throw { code: 'PRODUCT_INACTIVE', product: p._id };
    if (!p.isStockable) throw { code: 'PRODUCT_NOT_STOCKABLE', product: p._id };
  }
}

async function _checkAvailability(companyId, fromWarehouse, lines) {
  // For each line check qty_available at source (onHand - reserved).
  // Products are resolved in one query; the per-line aggregate below still runs
  // in order so the first insufficient line still decides the thrown error.
  const availabilityProducts = await loadLineProducts(Product, lines, companyId);
  for (const line of lines) {
    const prod = getLineProduct(availabilityProducts, line);
    if (!prod) throw { code: 'PRODUCT_NOT_FOUND', product: line.product };
    const agg = await aggregateWithTimeout(InventoryBatch, [
      { $match: { company: companyId, product: prod._id, warehouse: fromWarehouse } },
      { $group: { _id: null, reserved: { $sum: { $ifNull: ['$reservedQuantity', 0] } }, onHand: { $sum: { $ifNull: ['$quantity', 0] } } } }
    ]);
    const reservedRaw = agg[0] && agg[0].reserved ? agg[0].reserved : 0;
    const onHandRaw = agg[0] && agg[0].onHand ? agg[0].onHand : (prod.currentStock || 0);
    const reserved = reservedRaw && reservedRaw.toString ? Number(reservedRaw.toString()) : Number(reservedRaw || 0);
    const onHand = onHandRaw && onHandRaw.toString ? Number(onHandRaw.toString()) : Number(onHandRaw || 0);
    const available = onHand - reserved;
    const qty = line.qty && line.qty.toString ? Number(line.qty.toString()) : Number(line.qty || 0);
    if (available < qty) throw { code: 'INSUFFICIENT_STOCK', product: prod._id };
  }
}

async function _resolveCostsAndConsumeLots(session, companyId, fromWarehouse, lines) {
  // For each line determine unitCost and, for FIFO, consume lots and produce consumedLots array
  const results = [];
  const costingProducts = await loadLineProducts(Product, lines, companyId);
  for (const line of lines) {
    const product = getLineProduct(costingProducts, line);
    const qty = Number(line.qty.toString());
    if (product.costingMethod === 'wac' || product.costingMethod === 'avg' || !product.costingMethod) {
      // Prefer per-warehouse ledger for accurate WAC; fall back to product averageCost
      const ledger = await WarehouseInventoryCost.findOne({ company: companyId, warehouse: fromWarehouse, product: product._id }).session(session);
      const unitCost = ledger ? Number(ledger.getAvgCost()) : Number(product.averageCost || 0);
      results.push({ lineId: line._id, product: product._id, qty, unitCost, consumedLots: [] });
    } else {
      // FIFO: consume InventoryBatch / InventoryLayer from source warehouse ordered by receivedDate asc
      const layers = await InventoryLayer.find({ company: companyId, product: product._id, qtyRemaining: { $gt: 0 }, warehouse: fromWarehouse }).sort({ receiptDate: 1 }).session(session);
      let remaining = qty;
      const consumedLots = [];
      let totalCost = 0;
      let totalQty = 0;
      for (const l of layers) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, Number(l.qtyRemaining.toString()));
        // decrement
        l.qtyRemaining = Decimal.fromString((Number(l.qtyRemaining.toString()) - take).toString());
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
    const transfer = await StockTransfer.findById(transferId).session(session);
    if (!transfer) throw { code: 'NOT_FOUND' };
    if (transfer.status !== 'draft') throw { code: 'INVALID_STATUS' };
    // load lines
    const lines = await StockTransferLine.find({ transfer: transfer._id }).session(session);
    if (transfer.fromWarehouse.toString() === transfer.toWarehouse.toString()) throw { code: 'SAME_WAREHOUSE' };
    // validations
    await _ensureActiveAndStockable(lines.map(l => l.product));
    await _checkAvailability(transfer.company, transfer.fromWarehouse, lines);

    // resolve costs and consume lots (mutates layers)
    const resolved = await _resolveCostsAndConsumeLots(session, transfer.company, transfer.fromWarehouse, lines);

    // create stock movements and update stock levels
    let transferValue = 0;
    for (const r of resolved) {
      const line = lines.find(x => String(x._id) === String(r.lineId));
      // update line unitCost
      line.unitCost = Decimal.fromString(String(r.unitCost));
      await line.save({ session });

      const qty = r.qty;
      const unitCost = Number(r.unitCost);
      const totalCost = qty * unitCost;
      transferValue += totalCost;

      // transfer out movement (source)
      await StockMovement.create([{ company: transfer.company, product: r.product, warehouse: transfer.fromWarehouse, type: 'out', reason: 'transfer_out', referenceType: 'other', referenceModel: 'StockTransfer', referenceDocument: transfer._id, quantity: Decimal.fromString(String(qty)), unitCost: Decimal.fromString(String(unitCost)), totalCost: Decimal.fromString(String(totalCost)) }], { session });
      // transfer in movement (destination)
      await StockMovement.create([{ company: transfer.company, product: r.product, warehouse: transfer.toWarehouse, type: 'in', reason: 'transfer_in', referenceType: 'other', referenceModel: 'StockTransfer', referenceDocument: transfer._id, quantity: Decimal.fromString(String(qty)), unitCost: Decimal.fromString(String(unitCost)), totalCost: Decimal.fromString(String(totalCost)) }], { session });

      // update product currentStock and warehouse-level onHand via InventoryBatch/Layer adjustments
      // Decrement source onHand (assume Product.currentStock represents company-wide; warehouse-specific handled by layers/batches already)
      const prod = await Product.findById(r.product).session(session);
      prod.currentStock = Decimal.fromString(String(Number(prod.currentStock || 0) - qty));
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
        prod.averageCost = Decimal.fromString(String(newAvg));
        await prod.save({ session });
      } else {
          // FIFO: create InventoryLayer entries to mirror consumed lots
          for (const lot of r.consumedLots) {
            await InventoryLayer.create([{ company: transfer.company, product: r.product, qtyReceived: lot.qty, qtyRemaining: lot.qty, originTransfer: transfer._id, originQty: lot.qty, unitCost: Decimal.fromString(String(lot.unitCost)), receiptDate: new Date() , warehouse: transfer.toWarehouse }], { session });
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
      await StockMovement.create([{ company: transfer.company, product: line.product, warehouse: transfer.toWarehouse, type: 'out', reason: 'transfer_out', referenceType: 'other', referenceModel: 'StockTransfer', referenceDocument: transfer._id, quantity: Decimal.fromString(String(qty)), unitCost: Decimal.fromString(String(unitCost)), totalCost: Decimal.fromString(String(totalCost)) }], { session });
      await StockMovement.create([{ company: transfer.company, product: line.product, warehouse: transfer.fromWarehouse, type: 'in', reason: 'transfer_in', referenceType: 'other', referenceModel: 'StockTransfer', referenceDocument: transfer._id, quantity: Decimal.fromString(String(qty)), unitCost: Decimal.fromString(String(unitCost)), totalCost: Decimal.fromString(String(totalCost)) }], { session });
      // restore product currentStock
      const prod = await Product.findById(line.product).session(session);
      prod.currentStock = Decimal.fromString(String(Number(prod.currentStock || 0) + qty));
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
