const { dbClient } = require('../lib/prisma');
const cacheService = require('../services/cacheService');
const { wantsCursor, cursorFilter, cursorSort, cursorPage } = require('../utils/cursorPagination');
const StockMovement = require('../models/StockMovement');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const Warehouse = require('../models/Warehouse');
const InventoryBatch = require('../models/InventoryBatch');
const JournalService = require('../services/journalService');
const { runInTransaction } = require('../services/transactionService');
const EBMStockService = require('../services/ebmStockService');
const OpeningStockService = require('../services/openingStockService');
const inventoryService = require('../services/inventoryService');

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

async function getActiveWarehouseOptions(companyId) {
  const params = { companyId: String(companyId), active: true };
  const cached = await cacheService.getCachedQuery('warehouse', params);
  if (Array.isArray(cached)) return cached;

  const warehouses = await Warehouse.find({ company: companyId, isActive: true })
    .select('name _id')
    .sort({ isDefault: -1, name: 1 })
    .limit(1000)
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
    const {
      page = 1,
      limit = 20,
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
      'createdAt', 'updatedAt'
    ].join(' ');

    // Cursor mode is opt-in (send `cursor` or `mode=cursor`). Stock movements
    // are append-only and grow without bound, so deep offsets here are the
    // classic case for keyset pagination — but page/limit keeps working
    // unchanged for every existing caller.
    if (wantsCursor(req.query)) {
      const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
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
      return res.json({ success: true, count: data.length, data, pagination });
    }

    const total = await StockMovement.countDocuments(query);
    const movements = await StockMovement.find(query)
      .select(STOCK_MOVEMENT_LIST_SELECT)
      .populate('product', 'name sku unit')
      .populate('warehouse', 'name code')
      .sort({ movementDate: -1 })
      .limit(limit * 1)
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
      notes
    } = req.body;

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
        const wq = Warehouse.findOne({ _id: warehouseId, company: companyId });
        warehouse = useSession ? await wq.session(trx) : await wq;
        if (!warehouse) {
          throw Object.assign(new Error('Warehouse not found'), { status: 404 });
        }
      } else {
        const wq = Warehouse.findOne({ company: companyId, isDefault: true });
        warehouse = useSession ? await wq.session(trx) : await wq;
        if (!warehouse) {
          const wq2 = Warehouse.findOne({ company: companyId, isActive: true });
          warehouse = useSession ? await wq2.session(trx) : await wq2;
        }
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
          batch.quantity += quantity;
          batch.availableQuantity += quantity;
          batch.unitCost = unitCost || batch.unitCost;
          batch.totalCost = batch.quantity * batch.unitCost;
          batch.updateStatus();
          await batch.save(opts);
        } else {
          batch = await InventoryBatch.create({
            company: companyId,
            product: productId,
            warehouse: warehouse?._id,
            quantity,
            availableQuantity: quantity,
            batchNumber,
            lotNumber,
            expiryDate,
            unitCost: unitCost || 0,
            totalCost: quantity * (unitCost || 0),
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
      const newStock = previousStock + Number(quantity);

      // Create stock movement
      const movement = await StockMovement.create({
        company: companyId,
        product: productId,
        type: 'in',
        reason: 'purchase',
        quantity,
        previousStock,
        newStock,
        unitCost,
        totalCost: quantity * unitCost,
        supplier: supplierId,
        batchNumber,
        lotNumber,
        expiryDate,
        referenceType: 'purchase_order',
        warehouse: warehouse?._id,
        notes,
        performedBy: req.user.id,
        movementDate: new Date()
      });

      // Update product stock and average cost (coerce numeric values)
      const totalValue = (Number(product.currentStock || 0) * Number(product.averageCost || 0)) + (Number(quantity) * Number(unitCost));
      product.currentStock = newStock;
      product.averageCost = totalValue / (Number(newStock) || 1);
      product.lastSupplyDate = new Date();
      if (supplierId) product.supplier = supplierId;
      await product.save(opts);

      // Update supplier if provided
      if (supplierId) {
        const sq = Supplier.findOne({ _id: supplierId, company: companyId });
        const supplier = useSession ? await sq.session(trx) : await sq;
        if (supplier) {
          const productObjId = product._id;
          const isProductAlreadyLinked = supplier.productsSupplied.some((p) => p.toString() === productObjId.toString());
          if (!isProductAlreadyLinked) supplier.productsSupplied.push(productObjId);
          supplier.totalPurchases = (supplier.totalPurchases || 0) + (quantity * unitCost);
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
      notes
    } = req.body;

    const result = await runInTransaction(async (trx) => {
      const useSession = !!trx;
      const opts = useSession ? { session: trx } : {};

      // Validate reason
      const validReasons = ['damage', 'loss', 'theft', 'expired', 'correction', 'transfer'];
      if (!validReasons.includes(reason)) {
        throw Object.assign(new Error('Invalid adjustment reason'), { status: 400 });
      }

      // Get product
      const pq = Product.findOne({ _id: productId, company: companyId });
      const product = useSession ? await pq.session(trx) : await pq;
      if (!product) throw Object.assign(new Error('Product not found'), { status: 404 });

      const previousStock = Number(product.currentStock || 0);
      let newStock;

      if (type === 'in') {
        newStock = previousStock + Number(quantity);
      } else if (type === 'out') {
        if (Number(quantity) > previousStock) {
          throw Object.assign(new Error('Adjustment quantity exceeds current stock'), { status: 400 });
        }
        newStock = previousStock - Number(quantity);
      } else {
        throw Object.assign(new Error('Invalid adjustment type'), { status: 400 });
      }

      // Create stock movement
      const unitCost = Number(product.averageCost || 0);
      const movement = await StockMovement.create({
        company: companyId,
        product: productId,
        type: 'adjustment',
        reason,
        quantity,
        previousStock,
        newStock,
        unitCost,
        totalCost: unitCost * Number(quantity),
        warehouse: req.body.warehouse || undefined,
        referenceType: 'adjustment',
        notes,
        performedBy: req.user.id,
        movementDate: new Date()
      });

      // Update product stock
      product.currentStock = newStock;
      await product.save(opts);

      // Keep FIFO cost layers aligned with the new stock level, otherwise a sale
      // of this quantity later fails costing with "insufficient stock".
      if (type === 'in') {
        await inventoryService.createLayer(
          companyId,
          productId,
          Number(quantity),
          unitCost,
          { sourceType: 'adjustment', sourceId: movement._id },
          { session: trx || null, userId: req.user.id, warehouse: req.body.warehouse || null },
        );
      } else {
        await inventoryService.reduceLayers(companyId, productId, Number(quantity), { session: trx || null });
      }

      await JournalService.createStockAdjustmentEntry(companyId, req.user.id, {
        _id: movement._id,
        adjustmentAmount: movement.totalCost,
        adjustmentType: type === 'in' ? 'increase' : 'decrease',
        productName: product.name,
        productId: product._id,
        warehouseId: req.body.warehouse,
        reason,
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
    const { page = 1, limit = 20 } = req.query;

    const total = await StockMovement.countDocuments({ product: productId, company: companyId });
    const movements = await StockMovement.find({ product: productId, company: companyId })
      .populate('supplier', 'name code')
      .populate('performedBy', 'name email')
      .sort({ movementDate: -1 })
      .limit(limit * 1)
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
    const companyId = req.user.company._id;
    const products = await Product.find({ isArchived: false, company: companyId })
      .populate('category', 'name');

    const totalProducts = products.length;
    const totalStockValue = products.reduce(
      (sum, product) => sum + (product.currentStock * product.averageCost),
      0
    );
    const lowStockProducts = products.filter(
      product => product.currentStock <= product.lowStockThreshold
    ).length;
    const outOfStockProducts = products.filter(
      product => product.currentStock === 0
    ).length;

    // Stock by category
    const stockByCategory = products.reduce((acc, product) => {
      const categoryName = product.category?.name || 'Uncategorized';
      if (!acc[categoryName]) {
        acc[categoryName] = {
          count: 0,
          totalValue: 0,
          totalQuantity: 0
        };
      }
      acc[categoryName].count += 1;
      acc[categoryName].totalValue += product.currentStock * product.averageCost;
      acc[categoryName].totalQuantity += product.currentStock;
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        totalProducts,
        totalStockValue,
        lowStockProducts,
        outOfStockProducts,
        stockByCategory
      }
    });
  } catch (error) {
    next(error);
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
