/**
 * openingStockService
 * Creates one-time opening stock entries per product per warehouse.
 * Flow: validate -> persist movement + batch + inventory layer -> journal -> EBM.
 */

const mongoose = require('mongoose');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
const StockMovement = require('../models/StockMovement');
const InventoryBatch = require('../models/InventoryBatch');
const { createLayer } = require('./inventoryService');
const JournalService = require('./journalService');
const EBMStockService = require('./ebmStockService');
const { runInTransaction } = require('./transactionService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const ChartOfAccount = require('../models/ChartOfAccount');

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function badRequest(message, status = 400, code = 'INVALID_OPENING_STOCK') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

async function ensureNoDuplicateOpening(companyId, productId, warehouseId, session) {
  const existing = await StockMovement.findOne({
    company: companyId,
    product: productId,
    warehouse: warehouseId,
    reason: 'initial_stock'
  }).session(session || null);
  if (existing) {
    throw badRequest('Opening stock already captured for this product and warehouse.', 409, 'OPENING_STOCK_EXISTS');
  }
}

async function ensureNoStockExists(companyId, productId, warehouseId, session) {
  const existingAny = await StockMovement.findOne({
    company: companyId,
    product: productId,
    warehouse: warehouseId
  }).session(session || null).select('_id');
  if (existingAny) {
    throw badRequest(
      'Stock already exists for this product in this warehouse. If you entered opening stock incorrectly via stock adjustment, you must reverse those entries first through a manual journal entry before importing opening stock here.',
      409,
      'STOCK_ALREADY_EXISTS'
    );
  }
}

async function ensureOpeningBalanceEquityAccount(companyId, userId, session) {
  try {
    const code = DEFAULT_ACCOUNTS.openingBalanceEquity || '3500';
    const account = await ChartOfAccount.findOneAndUpdate(
      { company: companyId, code },
      {
        $setOnInsert: {
          name: 'Opening Balance Equity',
          type: 'equity',
          is_postable: true,
          createdBy: userId
        }
      },
      { new: true, upsert: true, session: session || null }
    );
    return account;
  } catch (err) {
    console.error('[OpeningStock] ensureOpeningBalanceEquityAccount failed:', err.message);
    // continue; JournalService may still resolve mapping/defaults
    return null;
  }
}

async function createOpeningStock({
  companyId,
  userId,
  productId,
  warehouseId,
  quantity,
  unitCost,
  movementDate = new Date(),
  notes,
  branchId = null,
  referenceNumber = null
}) {
  const qty = toNumber(quantity);
  const cost = toNumber(unitCost);
  if (!productId) throw badRequest('Product is required');
  if (!warehouseId) throw badRequest('Warehouse is required');
  if (!qty || qty <= 0) throw badRequest('Quantity must be greater than zero');
  if (cost < 0) throw badRequest('Unit cost cannot be negative');

  const { movement } = await runInTransaction(async (trx) => {
    const session = trx || null;
    const opts = session ? { session } : {};

    const productQuery = Product.findOne({ _id: productId, company: companyId });
    const warehouseQuery = Warehouse.findOne({ _id: warehouseId, company: companyId });
    const [product, warehouse] = await Promise.all([
      session ? productQuery.session(session) : productQuery,
      session ? warehouseQuery.session(session) : warehouseQuery
    ]);

    if (!product) throw badRequest('Product not found', 404);
    if (!warehouse) throw badRequest('Warehouse not found', 404);

    await ensureNoDuplicateOpening(companyId, productId, warehouseId, session);
    await ensureNoStockExists(companyId, productId, warehouseId, session);

    const previousStock = toNumber(product.currentStock || 0);
    const newStock = previousStock + qty;
    const totalCost = qty * cost;

    const [movementDoc] = await StockMovement.create([
      {
        company: companyId,
        product: productId,
        warehouse: warehouseId,
        type: 'in',
        reason: 'initial_stock',
        quantity: qty,
        previousStock,
        newStock,
        unitCost: cost,
        totalCost,
        referenceType: 'opening_stock',
        referenceNumber: referenceNumber || `OPEN-${Date.now()}`,
        notes: notes || 'Opening Stock',
        performedBy: userId,
        movementDate
      }
    ], opts);

    // Update product totals & costing
    const currentValue = previousStock * toNumber(product.averageCost || product.costPrice || 0);
    const newAverage = newStock > 0 ? (currentValue + totalCost) / newStock : cost;
    product.currentStock = newStock;
    product.averageCost = mongoose.Types.Decimal128.fromString(String(newAverage || 0));
    product.costPrice = mongoose.Types.Decimal128.fromString(String(cost));
    product.lastSupplyDate = movementDate;
    await product.save(opts);

    // Create per-warehouse batch for visibility in stock levels
    await InventoryBatch.create([
      {
        company: companyId,
        product: productId,
        warehouse: warehouseId,
        quantity: qty,
        availableQuantity: qty,
        unitCost: cost,
        totalCost,
        status: 'active',
        stockMovement: movementDoc._id,
        receivedDate: movementDate,
        notes: notes || 'Opening Stock',
        createdBy: userId
      }
    ], opts);

    // Create inventory layer for costing (FIFO/avg consumers)
    await createLayer(companyId, productId, qty, cost, { sourceType: 'opening_stock', sourceId: movementDoc._id }, { session, userId });

    // Journal entry: DR Inventory, CR Opening Balance Equity
    await ensureOpeningBalanceEquityAccount(companyId, userId, session);
    let inventoryAcct = DEFAULT_ACCOUNTS.inventory;
    const context = { productId, warehouseId };
    try {
      inventoryAcct = await JournalService.getMappedAccountCode(
        companyId,
        'purchases',
        'inventory',
        DEFAULT_ACCOUNTS.inventory,
        context
      );
    } catch (err) {
      inventoryAcct = DEFAULT_ACCOUNTS.inventory;
    }
    const equityAcct = DEFAULT_ACCOUNTS.openingBalanceEquity || '3500';
    const description = `Opening Stock - ${product.name}${warehouse?.name ? ` (${warehouse.name})` : ''}`;

    const lines = [
      JournalService.createDebitLine(inventoryAcct, totalCost, description),
      JournalService.createCreditLine(equityAcct, totalCost, description)
    ];

    await JournalService.createEntry(companyId, userId, {
      date: movementDate,
      description,
      sourceType: 'opening_stock',
      sourceId: movementDoc._id,
      lines,
      isAutoGenerated: true
    }, opts);

    return { movement: movementDoc };
  });

  // Submit to VSDC/EBM outside transaction
  if (movement) {
    EBMStockService.submitStockAdjustment(movement._id, { companyId, branchId }).catch((err) => {
      console.error('EBM opening stock submission failed:', err.message);
    });
  }

  return movement;
}

module.exports = {
  createOpeningStock
};
