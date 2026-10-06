const { dbClient } = require('../lib/prisma');
const cacheService = require('../services/cacheService');
const { wantsCursor, cursorFilter, cursorSort, cursorPage } = require('../utils/cursorPagination');
const StockMovement = require('../models/StockMovement');
const StockLevel = require('../models/StockLevel');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const Warehouse = require('../models/Warehouse');
const InventoryBatch = require('../models/InventoryBatch');
const StockBatch = require('../models/StockBatch');
const StockSerialNumber = require('../models/StockSerialNumber');
const JournalService = require('../services/journalService');
const { runInTransaction } = require('../services/transactionService');
const EBMStockService = require('../services/ebmStockService');
const OpeningStockService = require('../services/openingStockService');
const inventoryService = require('../services/inventoryService');
const { parseBoundedPage } = require('../utils/querySafety');

const STOCK_LEVEL_SORT_COLUMNS = {
  productName: 'p.name',
  productSku: 'p.sku',
  quantity: 'ib.quantity',
  availableQuantity: 'ib.available_quantity',
  reservedQuantity: 'ib.reserved_quantity',
  unitCost: 'ib.unit_cost',
  totalCost: 'ib.total_cost',
  expiryDate: 'ib.expiry_date',
  warehouseName: 'w.name',
};

const LIKE_ESCAPE = /[\\%_]/g;
function escapeLike(value) {
  return String(value).replace(LIKE_ESCAPE, (char) => `\\${char}`);
}

function normalizeSerialNumbers(value) {
  const entries = Array.isArray(value) ? value : (value ? String(value).split(/[\r\n,;|]+/) : []);
  const normalized = entries.map((entry) => String(entry).trim()).filter(Boolean);
  if (new Set(normalized).size !== normalized.length) {
    throw Object.assign(new Error('Serial numbers must be unique within a receipt'), { status: 400 });
  }
  return normalized;
}

async function markReversedMovements(rows, companyId) {
  if (!rows.length) return rows;
  const ids = rows.map((row) => row._id);
  const reversals = await StockMovement.find({ company: companyId, reversalOfMovement: { $in: ids } }).select('reversalOfMovement');
  const reversedIds = new Set(reversals.map((row) => String(row.reversalOfMovement)));
  return rows.map((row) => ({
    ...row.toObject(),
    isReversed: reversedIds.has(String(row._id)),
  }));
}

async function getActiveWarehouseOptions(companyId) {
  const params = { companyId: String(companyId), active: true };
  const cached = await cacheService.getCachedQuery('warehouse', params);
  if (Array.isArray(cached)) return cached;

  const warehouses = await Warehouse.find({ company: companyId, isActive: true })
    .select('name _id')
    .sort({ isDefault: -1, name: 1 })
    .limit(100)
    .lean();
  const options = warehouses.map((warehouse) => ({
    _id: warehouse._id,
    name: warehouse.name,
  }));
  await cacheService.cacheQuery('warehouse', params, options);
  return options;
}

// @desc    Get all stock movements
// @route   GET /api/stock/movements
// @access  Private
exports.getStockMovements = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page, limit } = parseBoundedPage(req.query, { defaultLimit: 20, maxLimit: 100 });
    const {
      type,
      reason,
      productId,
      supplierId,
      startDate,
      endDate,
      search
    } = req.query;

    const query = { company: companyId };

    // Search by product name
    if (search && search.trim()) {
      const products = await Product.find({
        name: { $regex: search, $options: 'i' },
        company: companyId
      }).select('_id');
      
      if (products.length > 0) {
        const productIds = products.map(p => p._id);
        query.product = { $in: productIds };
      }
    }

    if (type) query.type = type;
    if (reason) query.reason = reason;
    if (productId) query.product = productId;
    if (supplierId) query.supplier = supplierId;

    if (startDate || endDate) {
      query.movementDate = {};
      if (startDate) query.movementDate.$gte = new Date(startDate);
      if (endDate) query.movementDate.$lte = new Date(endDate);
    }

    const STOCK_MOVEMENT_LIST_SELECT = [
      '_id', 'company', 'product', 'type', 'reason', 'quantity', 'unitCost', 'totalCost',
      'warehouse', 'referenceType', 'referenceNumber', 'notes', 'movementDate', 'ebm',
      'batchNumber', 'lotNumber', 'expiryDate', 'serialNumbers', 'reversalOfMovement',
      'createdAt', 'updatedAt'
    ].join(' ');

    // Cursor mode is opt-in (send `cursor` or `mode=cursor`). Stock movements
    // are append-only and grow without bound, so deep offsets here are the
    // classic case for keyset pagination — but page/limit keeps working
    // unchanged for every existing caller.
    if (wantsCursor(req.query)) {
      const pageSize = limit;
      const cursorQuery = { ...query, ...cursorFilter(req.query.cursor, 'desc') };

      // limit + 1 probes for a further page without counting the whole table —
      // skipping the count is much of the benefit at scale.
      const rows = await StockMovement.find(cursorQuery)
        .select(STOCK_MOVEMENT_LIST_SELECT)
        .populate('product', 'name sku unit')
        .populate('warehouse', 'name code')
        .sort(cursorSort('movementDate', 'desc'))
        .limit(pageSize + 1);

      const { data, pagination } = cursorPage(rows, pageSize, 'movementDate');
      return res.json({ success: true, count: data.length, data: await markReversedMovements(data, companyId), pagination });
    }

    const total = await StockMovement.countDocuments(query);
    const movements = await StockMovement.find(query)
      .select(STOCK_MOVEMENT_LIST_SELECT)
      .populate('product', 'name sku unit')
      .populate('warehouse', 'name code')
      .sort({ movementDate: -1, _id: -1 })
      .limit(limit)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: movements.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: await markReversedMovements(movements, companyId)
    });
  } catch (error) {
    console.error('adjustStock error:', error);
    next(error);
  }
};

// @desc    Get single stock movement
// @route   GET /api/stock/movements/:id
// @access  Private
exports.getStockMovement = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const movement = await StockMovement.findOne({ _id: req.params.id, company: companyId })
      .populate('product', 'name sku unit')
      .populate('supplier', 'name code contact')
      .populate('performedBy', 'name email');

    if (!movement) {
      return res.status(404).json({
        success: false,
        message: 'Stock movement not found'
      });
    }

    res.json({
      success: true,
      data: movement
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Receive stock from supplier
// @route   POST /api/stock/movements
// @access  Private (admin, stock_manager)
exports.receiveStock = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      product: productId,
      quantity,
      unitCost,
      supplier: supplierId,
      batchNumber,
      lotNumber,
      expiryDate,
      warehouse: warehouseId,
      referenceNumber,
      serialNumbers: serialNumbersInput,
      notes
    } = req.body;
    const qty = Number(quantity);
    const cost = Number(unitCost);
    const serialNumbers = normalizeSerialNumbers(serialNumbersInput);
    if (!String(referenceNumber || '').trim()) {
      throw Object.assign(new Error('A source reference number is required for stock receipts'), { status: 400 });
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(new Error('Quantity must be a finite number greater than zero'), { status: 400 });
    }
    if (!Number.isFinite(cost) || cost < 0) {
      throw Object.assign(new Error('Unit cost must be a finite non-negative number'), { status: 400 });
    }

    // Use central transaction helper for receive
    const result = await runInTransaction(async (trx) => {
      const useSession = !!trx;
      const opts = useSession ? { session: trx } : {};

      // Get product
      const productQuery = Product.findOne({ _id: productId, company: companyId });
      const product = useSession ? await productQuery.session(trx) : await productQuery;
      if (!product) {
        throw Object.assign(new Error('Product not found'), { status: 404 });
      }

      // Get or create default warehouse if not specified
      let warehouse = null;
      if (warehouseId) {
        const wq = Warehouse.findOne({ _id: warehouseId, company: companyId, isActive: { $ne: false } });
        warehouse = useSession ? await wq.session(trx) : await wq;
        if (!warehouse) {
          throw Object.assign(new Error('Warehouse not found'), { status: 404 });
        }
      } else {
        const wq = Warehouse.findOne({ company: companyId, isDefault: true, isActive: { $ne: false } });
        warehouse = useSession ? await wq.session(trx) : await wq;
        if (!warehouse) {
          const wq2 = Warehouse.findOne({ company: companyId, isActive: true });
          warehouse = useSession ? await wq2.session(trx) : await wq2;
        }
      }

      const serialTracked = product.trackingType === 'serial' || product.trackSerialNumbers;
      if (serialTracked && (!Number.isInteger(qty) || serialNumbers.length !== qty)) {
        throw Object.assign(new Error(`This product requires exactly ${qty} unique serial number(s)`), { status: 400 });
      }
      if (!serialTracked && serialNumbers.length) {
        throw Object.assign(new Error('Serial numbers can only be received for serial-tracked products'), { status: 400 });
      }
      if (serialNumbers.length) {
        const serialQuery = StockSerialNumber.findOne({
          company: companyId, product: productId, serialNo: { $in: serialNumbers },
        });
        const existingSerial = useSession ? await serialQuery.session(trx) : await serialQuery;
        if (existingSerial) {
          throw Object.assign(new Error(`Serial number ${existingSerial.serialNo} already exists for this product`), { status: 409 });
        }
      }
      if (!warehouse) {
        throw Object.assign(new Error('An active warehouse is required to receive stock'), { status: 400 });
      }

      // If product tracks batches, create or update batch
      let batch = null;
      if (product.trackBatch || batchNumber || lotNumber) {
        const batchQuery = {
          company: companyId,
          product: productId,
          warehouse: warehouse?._id,
          status: { $nin: ['exhausted', 'expired'] }
        };
        if (batchNumber) batchQuery.batchNumber = batchNumber;
        if (lotNumber) batchQuery.lotNumber = lotNumber;

        const bq = InventoryBatch.findOne(batchQuery);
        batch = useSession ? await bq.session(trx) : await bq;

        if (batch) {
          batch.quantity = Number(batch.quantity || 0) + qty;
          batch.availableQuantity = Number(batch.availableQuantity || 0) + qty;
          batch.unitCost = cost || batch.unitCost;
          batch.totalCost = Number(batch.quantity) * Number(batch.unitCost);
          batch.updateStatus();
          await batch.save(opts);
        } else {
          batch = await InventoryBatch.create({
            company: companyId,
            product: productId,
            warehouse: warehouse?._id,
            quantity: qty,
            availableQuantity: qty,
            batchNumber,
            lotNumber,
            expiryDate,
            unitCost: cost,
            totalCost: qty * cost,
            supplier: supplierId,
            status: 'active',
            createdBy: req.user.id
          });
          if (useSession) {
            // If using session and create returns non-session doc, reload with session
            batch = await InventoryBatch.findById(batch._id).session(trx);
          }
        }
      }

      const previousStock = Number(product.currentStock || 0);
      const newStock = previousStock + qty;

      // Create stock movement
      const movement = await StockMovement.create({
        company: companyId,
        product: productId,
        type: 'in',
        reason: 'purchase',
        quantity: qty,
        previousStock,
        newStock,
        unitCost: cost,
        totalCost: qty * cost,
        supplier: supplierId,
        batchNumber,
        lotNumber,
        expiryDate,
        referenceType: 'purchase_order',
        referenceNumber: String(referenceNumber).trim(),
        serialNumbers,
        warehouse: warehouse?._id,
        notes,
        performedBy: req.user.id,
        movementDate: new Date()
      });

      let serialBatch = null;
      const batchNo = String(batchNumber || lotNumber || '').trim();
      if (serialNumbers.length && batchNo) {
        const stockBatchQuery = StockBatch.findOne({
          company: companyId, product: productId, warehouse: warehouse._id, batchNo,
        });
        serialBatch = useSession ? await stockBatchQuery.session(trx) : await stockBatchQuery;
        if (serialBatch) {
          const oldQty = Number(serialBatch.qtyOnHand || 0);
          const received = Number(serialBatch.qtyReceived || 0);
          serialBatch.qtyOnHand = oldQty + qty;
          serialBatch.qtyReceived = received + qty;
          serialBatch.unitCost = serialBatch.qtyOnHand > 0
            ? ((oldQty * Number(serialBatch.unitCost || 0)) + (qty * cost)) / serialBatch.qtyOnHand
            : cost;
          if (expiryDate) serialBatch.expiryDate = expiryDate;
          await serialBatch.save(opts);
        } else {
          serialBatch = await StockBatch.create({
            company: companyId,
            batchNo,
            product: productId,
            warehouse: warehouse._id,
            qtyReceived: qty,
            qtyOnHand: qty,
            unitCost: cost,
            expiryDate,
            notes: notes || `Received via stock movement ${movement._id}`,
          });
          if (useSession) serialBatch = await StockBatch.findById(serialBatch._id).session(trx);
        }
      }

      if (serialNumbers.length) {
        for (const serialNo of serialNumbers) {
          await StockSerialNumber.create({
            company: companyId,
            serialNo,
            product: productId,
            warehouse: warehouse._id,
            batch: serialBatch?._id,
            unitCost: cost,
            status: 'in_stock',
            notes: `Received via stock movement ${movement._id}`,
          });
        }
      }

      // Update product stock and average cost (coerce numeric values)
      const totalValue = (Number(product.currentStock || 0) * Number(product.averageCost || 0)) + (qty * cost);
      product.currentStock = newStock;
      product.averageCost = totalValue / (Number(newStock) || 1);
      product.lastSupplyDate = new Date();
      if (supplierId) product.supplier = supplierId;
      await product.save(opts);

      // POS and warehouse reports read StockLevel, so keep this warehouse row
      // in the same transaction as the product aggregate and movement ledger.
      await StockLevel.recalculateWAC(companyId, productId, warehouse._id, qty, cost);

      // Update supplier if provided
      if (supplierId) {
        const sq = Supplier.findOne({ _id: supplierId, company: companyId });
        const supplier = useSession ? await sq.session(trx) : await sq;
        if (supplier) {
          const productObjId = product._id;
          const isProductAlreadyLinked = supplier.productsSupplied.some((p) => p.toString() === productObjId.toString());
          if (!isProductAlreadyLinked) supplier.productsSupplied.push(productObjId);
          supplier.totalPurchases = (supplier.totalPurchases || 0) + (qty * cost);
          supplier.lastPurchaseDate = new Date();
          await supplier.save(opts);
        }
      }

      return { movement, warehouse, batch };
    });

    const movement = result.movement;
    const warehouse = result.warehouse;
    const batch = result.batch;

    res.status(201).json({
      success: true,
      message: 'Stock received successfully',
      data: {
        ...movement.toObject(),
        warehouse: warehouse ? { _id: warehouse._id, name: warehouse.name } : null,
        batch: batch ? { _id: batch._id, batchNumber: batch.batchNumber } : null
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Adjust stock (damage, loss, correction)
// @route   POST /api/stock/adjust
// @access  Private (admin, stock_manager)
exports.adjustStock = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      product: productId,
      quantity,
      reason,
      type,
      referenceNumber,
      notes
    } = req.body;
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(new Error('Quantity must be a finite number greater than zero'), { status: 400 });
    }
    if (!['in', 'out'].includes(type)) {
      throw Object.assign(new Error('Adjustment type must be in or out'), { status: 400 });
    }
    const normalizedReason = reason === 'transfer'
      ? (type === 'in' ? 'transfer_in' : 'transfer_out')
      : reason;
    if (!String(referenceNumber || '').trim()) {
      throw Object.assign(new Error('A source reference number is required for stock adjustments'), { status: 400 });
    }

    const result = await runInTransaction(async (trx) => {
      const useSession = !!trx;
      const opts = useSession ? { session: trx } : {};

      // Validate reason
      const validReasons = ['damage', 'loss', 'theft', 'expired', 'correction', 'transfer_in', 'transfer_out'];
      if (!validReasons.includes(normalizedReason)) {
        throw Object.assign(new Error('Invalid adjustment reason'), { status: 400 });
      }
      if ((normalizedReason === 'transfer_in' && type !== 'in')
        || (normalizedReason === 'transfer_out' && type !== 'out')) {
        throw Object.assign(new Error('Transfer reason must match the stock direction'), { status: 400 });
      }

      // Get product
      const pq = Product.findOne({ _id: productId, company: companyId });
      const product = useSession ? await pq.session(trx) : await pq;
      if (!product) throw Object.assign(new Error('Product not found'), { status: 404 });

      let warehouse = null;
      if (req.body.warehouse) {
        const warehouseQuery = Warehouse.findOne({ _id: req.body.warehouse, company: companyId, isActive: { $ne: false } });
        warehouse = useSession ? await warehouseQuery.session(trx) : await warehouseQuery;
        if (!warehouse) throw Object.assign(new Error('Active warehouse not found'), { status: 404 });
      } else {
        const defaultQuery = Warehouse.findOne({ company: companyId, isDefault: true, isActive: { $ne: false } });
        warehouse = useSession ? await defaultQuery.session(trx) : await defaultQuery;
        if (!warehouse) {
          const activeQuery = Warehouse.findOne({ company: companyId, isActive: { $ne: false } }).sort({ name: 1 });
          warehouse = useSession ? await activeQuery.session(trx) : await activeQuery;
        }
      if (!warehouse) throw Object.assign(new Error('An active warehouse is required to adjust stock'), { status: 400 });
      }

      let originalMovement = null;
      if (req.body.reversalOfMovement) {
        const originalQuery = StockMovement.findOne({
          _id: req.body.reversalOfMovement,
          company: companyId,
          type: 'adjustment',
          referenceType: 'adjustment',
        });
        originalMovement = useSession ? await originalQuery.session(trx) : await originalQuery;
        if (!originalMovement) {
          throw Object.assign(new Error('Only an adjustment movement can be reversed from stock movements'), { status: 400 });
        }
        if (originalMovement.reversalOfMovement) {
          throw Object.assign(new Error('A reversal movement cannot itself be reversed'), { status: 400 });
        }
        if (String(originalMovement.product) !== String(productId)
          || String(originalMovement.warehouse) !== String(warehouse._id)) {
          throw Object.assign(new Error('A reversal must use the original product and warehouse'), { status: 400 });
        }
        const alreadyReversedQuery = StockMovement.findOne({ company: companyId, reversalOfMovement: originalMovement._id });
        const alreadyReversed = useSession ? await alreadyReversedQuery.session(trx) : await alreadyReversedQuery;
        if (alreadyReversed) {
          throw Object.assign(new Error('This movement has already been reversed'), { status: 409 });
        }
        const originalDelta = Number(originalMovement.newStock) - Number(originalMovement.previousStock);
        const requiredType = originalDelta > 0 ? 'out' : 'in';
        if (type !== requiredType || Math.abs(originalDelta) !== qty) {
          throw Object.assign(new Error('A reversal must exactly offset the original stock quantity'), { status: 400 });
        }
      }

      const stockLevel = await StockLevel.getOrCreate(companyId, productId, warehouse._id);
      const warehousePreviousStock = Number(stockLevel.qty_on_hand || 0);
      const warehouseReserved = Number(stockLevel.qty_reserved || 0);

      const previousStock = Number(product.currentStock || 0);
      let newStock;
      let newWarehouseStock;

      if (type === 'in') {
        newStock = previousStock + qty;
        newWarehouseStock = warehousePreviousStock + qty;
      } else if (type === 'out') {
        const warehouseAvailable = Math.max(0, warehousePreviousStock - warehouseReserved);
        if (qty > warehouseAvailable || qty > previousStock) {
          throw Object.assign(new Error(`Adjustment quantity exceeds available stock in ${warehouse.name}. Available: ${Math.min(warehouseAvailable, previousStock)}`), { status: 400 });
        }
        newStock = previousStock - qty;
        newWarehouseStock = warehousePreviousStock - qty;
      } else {
        throw Object.assign(new Error('Invalid adjustment type'), { status: 400 });
      }

      // Create stock movement
      const unitCost = Number(product.averageCost || 0);
      const movement = await StockMovement.create({
        company: companyId,
        product: productId,
        type: 'adjustment',
        reason: normalizedReason,
        quantity: qty,
        previousStock,
        newStock,
        unitCost,
        totalCost: unitCost * qty,
        warehouse: warehouse._id,
        referenceType: 'adjustment',
        referenceNumber: String(referenceNumber).trim(),
        reversalOfMovement: originalMovement?._id,
        notes,
        performedBy: req.user.id,
        movementDate: new Date()
      });

      // Update product stock
      product.currentStock = newStock;
      await product.save(opts);

      const oldWarehouseValue = warehousePreviousStock * Number(stockLevel.avg_cost || 0);
      stockLevel.qty_on_hand = newWarehouseStock;
      if (type === 'in') {
        stockLevel.avg_cost = newWarehouseStock > 0
          ? (oldWarehouseValue + qty * unitCost) / newWarehouseStock
          : unitCost;
      }
      stockLevel.total_value = newWarehouseStock * Number(stockLevel.avg_cost || 0);
      stockLevel.last_movement_at = movement.movementDate;
      stockLevel.last_movement_type = type === 'in' ? 'adjustment_positive' : 'adjustment_negative';
      await stockLevel.save(opts);

      // Keep FIFO cost layers aligned with the new stock level, otherwise a sale
      // of this quantity later fails costing with "insufficient stock".
      if (type === 'in') {
        await inventoryService.createLayer(
          companyId,
          productId,
          qty,
          unitCost,
          { sourceType: 'adjustment', sourceId: movement._id },
          { session: trx || null, userId: req.user.id, warehouse: warehouse._id },
        );
      } else {
        await inventoryService.reduceLayers(companyId, productId, qty, { session: trx || null, warehouse: warehouse._id });
      }

      await JournalService.createStockAdjustmentEntry(companyId, req.user.id, {
        _id: movement._id,
        adjustmentAmount: movement.totalCost,
        adjustmentType: type === 'in' ? 'increase' : 'decrease',
        productName: product.name,
        productId: product._id,
        warehouseId: warehouse._id,
        reason: normalizedReason,
        date: movement.movementDate
      }, opts);

      return movement;
    });

    EBMStockService.submitStockAdjustment(result._id, {
      companyId,
      branchId: req.body.branchId || req.body.bhfId,
    }).catch((ebmErr) => {
      console.error('EBM stock adjustment submission failed:', ebmErr.message);
    });

    res.status(201).json({
      success: true,
      message: 'Stock adjusted successfully',
      data: result
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create opening stock entry (one-time per product + warehouse)
// @route   POST /api/stock/opening
// @access  Private (admin)
exports.createOpeningStock = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const {
      product: productId,
      warehouse: warehouseId,
      quantity,
      unitCost,
      movementDate,
      notes,
      branchId,
      bhfId
    } = req.body;

    const movement = await OpeningStockService.createOpeningStock({
      companyId,
      userId,
      productId,
      warehouseId,
      quantity,
      unitCost,
      movementDate,
      notes,
      branchId: branchId || bhfId || null
    });

    res.status(201).json({
      success: true,
      message: 'Opening stock captured successfully',
      data: movement
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get stock movements for a specific product
// @route   GET /api/stock/product/:productId/movements
// @access  Private
exports.getProductStockMovements = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { productId } = req.params;
    const { page, limit } = parseBoundedPage(req.query, { defaultLimit: 20, maxLimit: 100 });

    const total = await StockMovement.countDocuments({ product: productId, company: companyId });
    const movements = await StockMovement.find({ product: productId, company: companyId })
      .populate('supplier', 'name code')
      .populate('performedBy', 'name email')
      .sort({ movementDate: -1, _id: -1 })
      .limit(limit)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: movements.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: movements
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get stock summary
// @route   GET /api/stock/summary
// @access  Private
exports.getStockSummary = async (req, res, next) => {
  try {
    const companyId = String(req.user.company._id);
    const [summaryRows, categoryRows] = await Promise.all([
      dbClient().$queryRaw`
        SELECT
          COUNT(*)::int AS "totalProducts",
          COALESCE(SUM(p.current_stock * p.average_cost), 0)::double precision AS "totalStockValue",
          COUNT(*) FILTER (WHERE p.current_stock > 0 AND p.current_stock <= p.low_stock_threshold)::int AS "lowStockProducts",
          COUNT(*) FILTER (WHERE p.current_stock = 0)::int AS "outOfStockProducts"
        FROM products p
        WHERE p.company_id = ${companyId} AND p.is_archived = false
      `,
      dbClient().$queryRaw`
        SELECT
          COALESCE(c.name, 'Uncategorized') AS category,
          COUNT(*)::int AS count,
          COALESCE(SUM(p.current_stock * p.average_cost), 0)::double precision AS "totalValue",
          COALESCE(SUM(p.current_stock), 0)::double precision AS "totalQuantity"
        FROM products p
        LEFT JOIN categories c
          ON c.id = p.category_id AND c.company_id = p.company_id
        WHERE p.company_id = ${companyId} AND p.is_archived = false
        GROUP BY COALESCE(c.name, 'Uncategorized')
        ORDER BY "totalValue" DESC, category ASC
      `,
    ]);

    const summary = summaryRows[0] || {};
    const stockByCategory = Object.fromEntries(categoryRows.map((row) => [String(row.category), {
      count: Number(row.count || 0),
      totalValue: Number(row.totalValue || 0),
      totalQuantity: Number(row.totalQuantity || 0),
    }]));

    res.json({
      success: true,
      data: {
        totalProducts: Number(summary.totalProducts || 0),
        totalStockValue: Number(summary.totalStockValue || 0),
        lowStockProducts: Number(summary.lowStockProducts || 0),
        outOfStockProducts: Number(summary.outOfStockProducts || 0),
        stockByCategory,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.reverseStockMovement = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const movement = await StockMovement.findOne({ _id: req.params.id, company: companyId });
    if (!movement) return res.status(404).json({ success: false, message: 'Stock movement not found' });
    if (movement.type !== 'adjustment' || movement.referenceType !== 'adjustment' || movement.reversalOfMovement) {
      return res.status(400).json({ success: false, message: 'Only an unreversed manual stock adjustment can be reversed here' });
    }
    const delta = Number(movement.newStock) - Number(movement.previousStock);
    if (!delta) return res.status(400).json({ success: false, message: 'This movement has no stock change to reverse' });
    req.body = {
      product: movement.product,
      warehouse: movement.warehouse,
      quantity: Math.abs(delta),
      type: delta > 0 ? 'out' : 'in',
      reason: movement.reason === 'transfer_in' ? 'transfer_out'
        : movement.reason === 'transfer_out' ? 'transfer_in'
          : movement.reason,
      referenceNumber: `REV-${movement.referenceNumber || movement._id}`,
      reversalOfMovement: movement._id,
      notes: `Reversal of stock movement ${movement._id}`,
    };
    return exports.adjustStock(req, res, next);
  } catch (error) {
    return next(error);
  }
};

// @desc    Delete a stock movement and revert product stock
// @route   DELETE /api/stock/movements/:id
// @access  Private (admin, stock_manager)
exports.deleteStockMovement = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    // Stock movements are immutable. Deletions are not allowed; corrections must be made via opposite movements.
    return res.status(405).json({ success: false, message: 'Stock movements are immutable and cannot be deleted', code: 'MOVEMENT_IMMUTABLE' });
  } catch (error) {
    next(error);
  }
};

// @desc    Update stock movement metadata
// @route   PUT /api/stock/movements/:id
// @access  Private (admin, stock_manager)
exports.updateStockMovement = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    // Stock movements are immutable. Updates are not allowed; create compensating opposite movements instead.
    return res.status(405).json({ success: false, message: 'Stock movements are immutable and cannot be modified', code: 'MOVEMENT_IMMUTABLE' });
  } catch (error) {
    next(error);
  }
};

// @desc    Get stock levels (per-warehouse stock information)
// @route   GET /api/stock/levels
// @access  Private
exports.getStockLevels = async (req, res, next) => {
  try {
    const companyId = String(req.user.company._id);
    const {
      warehouse,
      product,
      lowStock,
      search,
      page = 1,
      limit = 50,
      sortBy = 'productName',
      order = 'asc',
    } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;
    const sortColumn = STOCK_LEVEL_SORT_COLUMNS[sortBy] || STOCK_LEVEL_SORT_COLUMNS.productName;
    const sortDirection = String(order).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    // The fallback is still useful for products whose stock has not been
    // materialised into inventory_batches. Its reads are bounded and warehouse
    // options are served from the shared reference-data cache.
    const batchWhere = ['ib.company_id = $1'];
    const params = [companyId];
    const addParam = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (warehouse) batchWhere.push(`ib.warehouse_id = ${addParam(String(warehouse))}`);
    if (product) batchWhere.push(`ib.product_id = ${addParam(String(product))}`);
    if (lowStock === 'true') batchWhere.push('ib.available_quantity <= (ib.quantity * 0.2)');
    if (search && String(search).trim()) {
      const term = addParam(escapeLike(String(search).trim()));
      batchWhere.push(`(p.name ILIKE ${term} || '%' ESCAPE '\\' OR p.sku ILIKE ${term} || '%' ESCAPE '\\' OR w.name ILIKE ${term} || '%' ESCAPE '\\')`);
    }
    const whereSql = batchWhere.join(' AND ');
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM inventory_batches ib
      LEFT JOIN products p ON p.id = ib.product_id
      LEFT JOIN warehouses w ON w.id = ib.warehouse_id
      WHERE ${whereSql}`;
    const pageSql = `
      SELECT ib.id AS "_id", ib.product_id AS "productId", p.name AS "productName",
             p.sku AS "productSku", ib.warehouse_id AS "warehouseId", w.name AS "warehouseName",
             ib.quantity::double precision AS quantity,
             ib.available_quantity::double precision AS "availableQuantity",
             ib.reserved_quantity::double precision AS "reservedQuantity",
             ib.unit_cost::double precision AS "unitCost",
             ib.total_cost::double precision AS "totalCost",
             ib.batch_number AS "batchNumber", ib.expiry_date AS "expiryDate",
             ib.status, ib.updated_at AS "lastMovement"
      FROM inventory_batches ib
      LEFT JOIN products p ON p.id = ib.product_id
      LEFT JOIN warehouses w ON w.id = ib.warehouse_id
      WHERE ${whereSql}
      ORDER BY ${sortColumn} ${sortDirection}, ib.id ASC
      LIMIT ${limitNum} OFFSET ${skip}`;

    const [countRows, batchRows] = await Promise.all([
      dbClient().$queryRawUnsafe(countSql, ...params),
      dbClient().$queryRawUnsafe(pageSql, ...params),
    ]);
    const total = Number(countRows[0]?.total || 0);
    const warehouses = await getActiveWarehouseOptions(companyId);

    if (total === 0) {
      const productWhere = ['p.company_id = $1', '(p.current_stock > 0 OR p.default_warehouse_id IS NOT NULL)'];
      const productParams = [companyId];
      const addProductParam = (value) => {
        productParams.push(value);
        return `$${productParams.length}`;
      };
      if (product) productWhere.push(`p.id = ${addProductParam(String(product))}`);
      if (search && String(search).trim()) {
        const term = addProductParam(escapeLike(String(search).trim()));
        productWhere.push(`(p.name ILIKE ${term} || '%' ESCAPE '\\' OR p.sku ILIKE ${term} || '%' ESCAPE '\\')`);
      }
      if (lowStock === 'true') productWhere.push('p.current_stock <= p.low_stock_threshold');
      const productWhereSql = productWhere.join(' AND ');
      const productSort = {
        productName: 'p.name',
        productSku: 'p.sku',
        quantity: 'p.current_stock',
        availableQuantity: 'p.current_stock',
        unitCost: 'p.cost_price',
      }[sortBy] || 'p.name';
      const [productCountRows, products] = await Promise.all([
        dbClient().$queryRawUnsafe(`SELECT COUNT(*)::int AS total FROM products p WHERE ${productWhereSql}`, ...productParams),
        dbClient().$queryRawUnsafe(`
          SELECT p.id AS "_id", p.name AS "productName", p.sku AS "productSku",
                 p.default_warehouse_id AS "warehouseId", w.name AS "warehouseName",
                 p.current_stock::double precision AS quantity,
                 p.current_stock::double precision AS "availableQuantity",
                 0::double precision AS "reservedQuantity",
                 COALESCE(NULLIF(p.cost_price, 0), p.average_cost)::double precision AS "unitCost",
                 (p.current_stock * COALESCE(NULLIF(p.cost_price, 0), p.average_cost))::double precision AS "totalCost"
          FROM products p
          LEFT JOIN warehouses w ON w.id = p.default_warehouse_id
          WHERE ${productWhereSql}
          ORDER BY ${productSort} ${sortDirection}, p.id ASC
          LIMIT ${limitNum} OFFSET ${skip}`, ...productParams),
      ]);
      const productTotal = Number(productCountRows[0]?.total || 0);
      if (productTotal > 0) {
        return res.json({
          success: true,
          data: products.map((row) => ({
            ...row,
            product: row._id,
            warehouse: row.warehouseId || warehouses[0]?._id || null,
            warehouseId: row.warehouseId || warehouses[0]?._id || null,
            warehouseName: row.warehouseName || warehouses[0]?.name || 'Unassigned',
            status: 'active',
            source: 'product',
          })),
          warehouses,
          pagination: { total: productTotal, page: pageNum, limit: limitNum, pages: Math.ceil(productTotal / limitNum) },
        });
      }
    }

    return res.json({
      success: true,
      data: batchRows.map((row) => ({
        ...row,
        product: `${row.productName || ''} (${row.productSku || ''})`.trim(),
        warehouse: row.warehouseName || null,
      })),
      warehouses,
      pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    next(error);
  }
};
