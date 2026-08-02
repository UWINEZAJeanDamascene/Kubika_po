const Warehouse = require('../models/Warehouse');
const InventoryBatch = require('../models/InventoryBatch');
const Product = require('../models/Product');
const EBMBranchService = require('../services/ebmBranchService');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../lib/prisma');

function asId(value) {
  if (!value) return null;
  return value.toString ? value.toString() : String(value);
}

async function getWarehouseStockSummaries(companyId, warehouseIds) {
  const ids = [...new Set(warehouseIds.map(asId).filter(Boolean))];
  if (ids.length === 0) return new Map();

  const rows = await prisma.$queryRaw`
    SELECT
      warehouse_id AS "warehouseId",
      COUNT(DISTINCT product_id)::int AS "totalProducts",
      COALESCE(SUM(available_quantity), 0) AS "totalQuantity",
      COALESCE(SUM(available_quantity * unit_cost), 0) AS "totalValue"
    FROM inventory_batches
    WHERE company_id = ${asId(companyId)}
      AND warehouse_id IN (${Prisma.join(ids)})
      AND status <> 'exhausted'
    GROUP BY warehouse_id
  `;

  return new Map(rows.map((row) => [
    row.warehouseId,
    {
      totalProducts: Number(row.totalProducts || 0),
      totalQuantity: Number(row.totalQuantity || 0),
      totalValue: Number(row.totalValue || 0)
    }
  ]));
}

function withStockSummary(warehouse, summaries) {
  const summary = summaries.get(asId(warehouse._id)) || {
    totalProducts: 0,
    totalQuantity: 0,
    totalValue: 0
  };

  return {
    ...warehouse.toObject(),
    ...summary
  };
}

// @desc    Get all warehouses
// @route   GET /api/stock/warehouses
// @access  Private
exports.getWarehouses = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 20, search, isActive } = req.query;

    const query = { company: companyId };

    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } }
      ];
    }

    const total = await Warehouse.countDocuments(query);
    const warehouses = await Warehouse.find(query)
      .populate('createdBy', 'name email')
      .sort({ isDefault: -1, name: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const stockSummaries = await getWarehouseStockSummaries(companyId, warehouses.map((warehouse) => warehouse._id));
    const warehousesWithStock = warehouses.map((warehouse) => withStockSummary(warehouse, stockSummaries));

    res.json({
      success: true,
      count: warehouses.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: warehousesWithStock
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single warehouse
// @route   GET /api/stock/warehouses/:id
// @access  Private
exports.getWarehouse = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const warehouse = await Warehouse.findOne({ _id: req.params.id, company: companyId })
      .populate('createdBy', 'name email');

    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    const stockSummaries = await getWarehouseStockSummaries(companyId, [warehouse._id]);

    res.json({
      success: true,
      data: withStockSummary(warehouse, stockSummaries)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create warehouse
// @route   POST /api/stock/warehouses
// @access  Private (admin, stock_manager)
exports.createWarehouse = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const warehouse = await Warehouse.create({
      ...req.body,
      company: companyId,
      createdBy: req.user.id
    });

    if (warehouse.rraBranchId) {
      EBMBranchService.registerBranch(companyId, warehouse, req.user.id).catch((err) => {
        console.error('[Warehouse] EBM branch registration failed:', err.message);
      });
    }

    res.status(201).json({
      success: true,
      data: warehouse
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update warehouse
// @route   PUT /api/stock/warehouses/:id
// @access  Private (admin, stock_manager)
exports.updateWarehouse = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    let warehouse = await Warehouse.findOne({ _id: req.params.id, company: companyId });

    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    // Prevent deactivating a warehouse that still holds stock
    if (req.body.hasOwnProperty('isActive') && req.body.isActive === false && warehouse.isActive) {
      const hasStock = await InventoryBatch.exists({ company: companyId, warehouse: warehouse._id, availableQuantity: { $gt: 0 } });
      if (hasStock) {
        return res.status(409).json({
          success: false,
          code: 'WAREHOUSE_HAS_STOCK',
          message: 'Cannot deactivate warehouse while it holds stock'
        });
      }
    }

    // If setting as default, unset other defaults
    if (req.body.isDefault && !warehouse.isDefault) {
      await Warehouse.updateMany(
        { company: companyId, _id: { $ne: warehouse._id } },
        { isDefault: false }
      );
    }

    warehouse = await Warehouse.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (warehouse.rraBranchId) {
      EBMBranchService.registerBranch(companyId, warehouse, req.user.id).catch((err) => {
        console.error('[Warehouse] EBM branch update registration failed:', err.message);
      });
    }

    res.json({
      success: true,
      data: warehouse
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete warehouse
// @route   DELETE /api/stock/warehouses/:id
// @access  Private (admin)
exports.deleteWarehouse = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const warehouse = await Warehouse.findOne({ _id: req.params.id, company: companyId });

    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    // Check if warehouse has stock
    const hasStock = await InventoryBatch.exists({
      company: companyId,
      warehouse: warehouse._id,
      availableQuantity: { $gt: 0 }
    });

    if (hasStock) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete warehouse with existing stock. Transfer stock first.'
      });
    }

    // Check if it's the last warehouse
    const warehouseCount = await Warehouse.countDocuments({ company: companyId });
    if (warehouseCount <= 1) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete the last warehouse'
      });
    }

    // If it's the default warehouse, set another one as default
    if (warehouse.isDefault) {
      const anotherWarehouse = await Warehouse.findOne({ company: companyId, _id: { $ne: warehouse._id } });
      if (anotherWarehouse) {
        anotherWarehouse.isDefault = true;
        await anotherWarehouse.save();
      }
    }

    await warehouse.deleteOne();

    res.json({
      success: true,
      message: 'Warehouse deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get warehouse inventory
// @route   GET /api/stock/warehouses/:id/inventory
// @access  Private
exports.getWarehouseInventory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 50, search, lowStock, expiring } = req.query;

    const query = {
      company: companyId,
      warehouse: req.params.id
    };

    if (lowStock === 'true') {
      query.$expr = { $lte: ['$availableQuantity', '$quantity * 0.2'] };
    }

    if (expiring === 'true') {
      const thirtyDaysFromNow = new Date();
      thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
      query.expiryDate = { $lte: thirtyDaysFromNow, $gte: new Date() };
    }

    let inventoryQuery = InventoryBatch.find(query)
      .populate('product', 'name sku unit currentStock lowStockThreshold')
      .populate('supplier', 'name code')
      .sort({ expiryDate: 1, createdAt: -1 });

    // Handle search
    if (search) {
      const products = await Product.find({
        company: companyId,
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { sku: { $regex: search, $options: 'i' } }
        ]
      }).select('_id');

      const productIds = products.map(p => p._id);
      inventoryQuery = inventoryQuery.where('product').in(productIds);
    }

    const total = await inventoryQuery.clone().countDocuments();
    const inventory = await inventoryQuery
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: inventory.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: inventory
    });
  } catch (error) {
    next(error);
  }
};
