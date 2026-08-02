const mongoose = require('mongoose');
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
    const companyId = req.user.company._id;
    const { 
      warehouse, 
      product, 
      lowStock, 
      search, 
      page = 1, 
      limit = 50,
      sortBy = 'productName',
      order = 'asc'
    } = req.query;

    // Use already imported models
    // Build aggregation pipeline
    const matchStage = { company: companyId };
    
    if (warehouse) {
      matchStage.warehouse = warehouse;
    }
    
    if (product) {
      matchStage.product = product;
    }

    // Filter for low stock (available <= 20% of threshold or below reorder point)
    if (lowStock === 'true') {
      matchStage.$expr = { $lte: ['$availableQuantity', '$quantity * 0.2'] };
    }

    // Get total count from InventoryBatch
    let total = await InventoryBatch.countDocuments(matchStage);

    // If no inventory batches found but we have products with default warehouse, also show those
    // This handles the case where products have currentStock but no InventoryBatch records
    if (total === 0) {
      const productQuery = { 
        company: companyId,
        $or: [
          { currentStock: { $gt: 0 } },
          { defaultWarehouse: { $exists: true, $ne: null } }
        ]
      };
      if (product) {
        productQuery._id = product;
      }
      if (search) {
        productQuery.$or = [
          { name: { $regex: search, $options: 'i' } },
          { sku: { $regex: search, $options: 'i' } }
        ];
      }
      const productsWithStock = await Product.find(productQuery).lean();
      if (productsWithStock.length > 0) {
        // Get all warehouses to show product stock (default warehouse or all)
        const warehouses = await Warehouse.find({ company: companyId, isActive: true }).lean();
        
        const stockFromProducts = productsWithStock.map(p => ({
          _id: p._id,
          product: p._id,
          productId: p._id,
          productName: p.name,
          productSku: p.sku,
          warehouse: p.defaultWarehouse || (warehouses[0]?._id || null),
          warehouseId: p.defaultWarehouse || (warehouses[0]?._id || null),
          warehouseName: p.defaultWarehouse 
            ? (warehouses.find(w => w._id.toString() === p.defaultWarehouse?.toString())?.name || 'Default')
            : (warehouses[0]?.name || 'Unassigned'),
          quantity: Number(p.currentStock || 0),
          availableQuantity: Number(p.currentStock || 0),
          reservedQuantity: 0,
          unitCost: Number(p.costPrice || p.averageCost || 0),
          totalCost: Number(p.currentStock || 0) * Number(p.costPrice || p.averageCost || 0),
          status: 'active',
          source: 'product' // Mark as from product currentStock
        }));

        // Apply pagination
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const startIndex = (pageNum - 1) * limitNum;
        const paginatedData = stockFromProducts.slice(startIndex, startIndex + limitNum);

        return res.json({
          success: true,
          data: paginatedData,
          warehouses: warehouses,
          pagination: {
            total: stockFromProducts.length,
            page: pageNum,
            limit: limitNum,
            pages: Math.ceil(stockFromProducts.length / limitNum)
          }
        });
      }
    }

    // Aggregation to get stock levels with product and warehouse info
    const stockLevels = await InventoryBatch.aggregate([
      { $match: matchStage },
      {
        $lookup: {
          from: 'products',
          localField: 'product',
          foreignField: '_id',
          as: 'productInfo'
        }
      },
      { $unwind: { path: '$productInfo', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'warehouses',
          localField: 'warehouse',
          foreignField: '_id',
          as: 'warehouseInfo'
        }
      },
      { $unwind: { path: '$warehouseInfo', preserveNullAndEmptyArrays: true } },
      // Search filter
      ...(search ? [{
        $match: {
          $or: [
            { 'productInfo.name': { $regex: search, $options: 'i' } },
            { 'productInfo.sku': { $regex: search, $options: 'i' } },
            { 'warehouseInfo.name': { $regex: search, $options: 'i' } }
          ]
        }
      }] : []),
      // Project final fields
      {
        $project: {
          _id: 1,
          product: { $concat: ['$productInfo.name', ' (', '$productInfo.sku', ')'] },
          productId: '$product',
          productName: '$productInfo.name',
          productSku: '$productInfo.sku',
          warehouse: { $concat: ['$warehouseInfo.name'] },
          warehouseId: '$warehouse',
          warehouseName: '$warehouseInfo.name',
          quantity: 1,
          availableQuantity: 1,
          reservedQuantity: 1,
          unitCost: 1,
          totalCost: 1,
          batchNumber: 1,
          expiryDate: 1,
          status: 1,
          lastMovement: '$updatedAt'
        }
      },
      // Sort
      { $sort: { [sortBy]: order === 'asc' ? 1 : -1 } },
      // Pagination
      { $skip: (page - 1) * limit },
      { $limit: parseInt(limit) }
    ]);

    // Get warehouses for filter dropdown
    const warehouses = await Warehouse.find({ company: companyId, isActive: true }).select('name _id');

    res.json({
      success: true,
      data: stockLevels,
      warehouses,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
};
