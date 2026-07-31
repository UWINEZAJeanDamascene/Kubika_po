const mongoose = require("mongoose");
const { aggregateWithTimeout } = require("../../utils/mongoAggregation");
const Product = require("../../models/Product");
const InventoryBatch = require("../../models/InventoryBatch");
const StockMovement = require("../../models/StockMovement");
const dateHelpers = require("../../utils/dateHelpers");
const dashboardCache = require("../DashboardCacheService");

const DEAD_STOCK_LOOKBACK_DAYS = 90;
const TOP_MOVING_WINDOW_DAYS = 30;
const RECENT_MOVEMENTS_LIMIT = 10;

class InventoryDashboardService {
  static async get(companyId) {
     const cached = await dashboardCache.get(companyId, "inventory");
    if (cached) return cached;

    const [
      stockSummary,
      lowStockAlerts,
      deadStock,
      topMovingProducts,
      warehouseBreakdown,
      recentMovements,
    ] = await Promise.all([
      InventoryDashboardService._getStockSummary(companyId),
      InventoryDashboardService._getLowStockAlerts(companyId),
      InventoryDashboardService._getDeadStock(companyId),
      InventoryDashboardService._getTopMovingProducts(companyId, 5),
      InventoryDashboardService._getWarehouseBreakdown(companyId),
      InventoryDashboardService._getRecentMovements(
        companyId,
        RECENT_MOVEMENTS_LIMIT,
      ),
    ]);

    const deadSince = dateHelpers.lastNDays(DEAD_STOCK_LOOKBACK_DAYS).start;
    const movingWindow = dateHelpers.lastNDays(TOP_MOVING_WINDOW_DAYS);

    const result = {
      company_id: companyId,
      generated_at: new Date(),
      date_context: {
        dead_stock_no_dispatch_since: deadSince,
        dead_stock_lookback_days: DEAD_STOCK_LOOKBACK_DAYS,
        top_moving_window_start: movingWindow.start,
        top_moving_window_end: movingWindow.end,
        top_moving_window_days: TOP_MOVING_WINDOW_DAYS,
        recent_movements_limit: RECENT_MOVEMENTS_LIMIT,
      },
      summary: stockSummary,
      low_stock_alerts: {
        count: lowStockAlerts.length,
        items: lowStockAlerts,
      },
      dead_stock: {
        count: deadStock.length,
        total_value: dateHelpers.round2(
          deadStock.reduce((s, p) => s + p.stock_value, 0),
        ),
        items: deadStock,
      },
      top_moving_products: topMovingProducts,
      warehouse_breakdown: warehouseBreakdown,
      recent_movements: recentMovements,
    };

    await dashboardCache.set(companyId, "inventory", result);
    return result;
  }

  // ── Summary: query Product (the source of truth for currentStock) ──────────
  static async _getStockSummary(companyId) {
    const coid = new mongoose.Types.ObjectId(companyId);
    const result = await aggregateWithTimeout(
      Product,
      [
        {
          $match: {
            company: coid,
            isActive: true,
            isArchived: { $ne: true },
            isStockable: { $ne: false },
          },
        },
        {
          $group: {
            _id: null,
            total_sku_count: { $sum: 1 },
            total_units: {
              $sum: { $toDouble: { $ifNull: ["$currentStock", 0] } },
            },
            total_value: {
              $sum: {
                $multiply: [
                  { $toDouble: { $ifNull: ["$currentStock", 0] } },
                  { $toDouble: { $ifNull: ["$averageCost", 0] } },
                ],
              },
            },
            total_reserved: {
              $sum: { $toDouble: { $ifNull: ["$reservedQuantity", 0] } },
            },
            in_stock_count: {
              $sum: {
                $cond: [
                  {
                    $gt: [{ $toDouble: { $ifNull: ["$currentStock", 0] } }, 0],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ],
      "dashboard",
    );

    const s = result[0] || {};
    const total_sku_count = s.total_sku_count || 0;
    const total_units = s.total_units || 0;
    const total_reserved = s.total_reserved || 0;
    const in_stock_count = s.in_stock_count || 0;
    return {
      total_sku_count,
      total_units: dateHelpers.round2(total_units),
      total_value: dateHelpers.round2(s.total_value || 0),
      total_reserved: dateHelpers.round2(total_reserved),
      total_available: dateHelpers.round2(total_units - total_reserved),
      in_stock_count,
      zero_stock_count: total_sku_count - in_stock_count,
    };
  }

  // ── Low-stock alerts: query Product directly ──────────────────────────────
  static async _getLowStockAlerts(companyId) {
    const coid = new mongoose.Types.ObjectId(companyId);
    const results = await aggregateWithTimeout(
      Product,
      [
        {
          $match: {
            company: coid,
            isActive: true,
            isArchived: { $ne: true },
            isStockable: { $ne: false },
          },
        },
        {
          $addFields: {
            _currentStock: { $toDouble: { $ifNull: ["$currentStock", 0] } },
            _reservedQty: { $toDouble: { $ifNull: ["$reservedQuantity", 0] } },
            _reorderQty: { $toDouble: { $ifNull: ["$reorderQuantity", 0] } },
            // Use reorderPoint when explicitly set > 0, otherwise fall back to
            // lowStockThreshold — which is what the Products page "Low Stock"
            // status uses (isLowStock virtual: currentStock <= lowStockThreshold)
            _reorderPoint: {
              $let: {
                vars: {
                  rp: { $toDouble: { $ifNull: ["$reorderPoint", 0] } },
                  lt: { $toDouble: { $ifNull: ["$lowStockThreshold", 0] } },
                },
                in: {
                  $cond: [{ $gt: ["$$rp", 0] }, "$$rp", "$$lt"],
                },
              },
            },
          },
        },
        {
          $addFields: {
            _available: { $subtract: ["$_currentStock", "$_reservedQty"] },
          },
        },
        {
          $match: {
            _reorderPoint: { $gt: 0 },
            // Use $lte to match the Products page isLowStock virtual which
            // uses cs <= th (currentStock <= lowStockThreshold)
            $expr: { $lte: ["$_available", "$_reorderPoint"] },
          },
        },
        {
          $lookup: {
            from: "warehouses",
            localField: "defaultWarehouse",
            foreignField: "_id",
            as: "_warehouseArr",
          },
        },
        {
          $project: {
            product_id: "$_id",
            product_code: "$sku",
            product_name: "$name",
            warehouse_id: { $arrayElemAt: ["$_warehouseArr._id", 0] },
            warehouse_name: { $arrayElemAt: ["$_warehouseArr.name", 0] },
            qty_on_hand: { $round: ["$_currentStock", 4] },
            qty_reserved: { $round: ["$_reservedQty", 4] },
            qty_available: { $round: ["$_available", 4] },
            reorder_point: { $round: ["$_reorderPoint", 4] },
            reorder_qty: "$_reorderQty",
            shortage: {
              $round: [{ $subtract: ["$_reorderPoint", "$_available"] }, 4],
            },
          },
        },
        { $sort: { shortage: -1 } },
      ],
      "dashboard",
    );

    return results;
  }

  // ── Dead stock: StockMovement for activity + Product for stock qty ─────────
  static async _getDeadStock(companyId) {
    const ninetyDaysAgo = dateHelpers.lastNDays(DEAD_STOCK_LOOKBACK_DAYS).start;
    const coid = new mongoose.Types.ObjectId(companyId);

    const moves = await StockMovement.find({
      company: companyId,
      movementDate: { $gte: ninetyDaysAgo },
    }).lean();
    const activeMoves = (moves || []).filter((m) => {
      const reason = m.reason || m.movement_type;
      const type = m.type || m.movement_type;
      return ['dispatch', 'transfer_out'].includes(reason) || type === 'out';
    });
    const rawIds = activeMoves
      .map((m) => m.product || m.product_id)
      .filter(Boolean);
    const activeProductIds = Array.from(
      new Set(rawIds.map((id) => id.toString())),
    ).map((id) => new mongoose.Types.ObjectId(id));

    const results = await aggregateWithTimeout(
      Product,
      [
        {
          $match: {
            company: coid,
            isActive: true,
            isArchived: { $ne: true },
            isStockable: { $ne: false },
            _id: { $nin: activeProductIds },
          },
        },
        {
          $addFields: {
            _currentStock: { $toDouble: { $ifNull: ["$currentStock", 0] } },
            _avgCost: { $toDouble: { $ifNull: ["$averageCost", 0] } },
          },
        },
        {
          $match: { _currentStock: { $gt: 0 } },
        },
        {
          $project: {
            product_id: "$_id",
            product_code: "$sku",
            product_name: "$name",
            qty_on_hand: { $round: ["$_currentStock", 4] },
            avg_cost: { $round: ["$_avgCost", 6] },
            stock_value: {
              $round: [{ $multiply: ["$_currentStock", "$_avgCost"] }, 2],
            },
            days_no_movement: DEAD_STOCK_LOOKBACK_DAYS,
          },
        },
        { $sort: { stock_value: -1 } },
        { $limit: 20 },
      ],
      "dashboard",
    );

    return results;
  }

  // ── Top moving: unchanged (already queries StockMovement correctly) ────────
  static async _getTopMovingProducts(companyId, limit) {
    const thirtyDays = dateHelpers.lastNDays(TOP_MOVING_WINDOW_DAYS);

    const results = await aggregateWithTimeout(
      StockMovement,
      [
        {
          $match: {
            $and: [
              {
                $or: [
                  { company: new mongoose.Types.ObjectId(companyId) },
                  { company_id: new mongoose.Types.ObjectId(companyId) },
                  { company: companyId },
                  { company_id: companyId },
                ],
              },
              {
                $or: [
                  { reason: "dispatch" },
                  { type: "out" },
                  { movement_type: "dispatch" },
                ],
              },
              {
                $or: [
                  {
                    movementDate: {
                      $gte: thirtyDays.start,
                      $lte: thirtyDays.end,
                    },
                  },
                  {
                    created_at: {
                      $gte: thirtyDays.start,
                      $lte: thirtyDays.end,
                    },
                  },
                ],
              },
            ],
          },
        },
        {
          $group: {
            _id: { $ifNull: ["$product", "$product_id"] },
            total_qty: {
              $sum: { $ifNull: ["$quantity", { $ifNull: ["$qty", 0] }] },
            },
            total_value: {
              $sum: {
                $ifNull: ["$totalCost", { $ifNull: ["$total_cost", 0] }],
              },
            },
            move_count: { $sum: 1 },
          },
        },
        { $sort: { total_qty: -1 } },
        { $limit: limit },
        {
          $lookup: {
            from: "products",
            localField: "_id",
            foreignField: "_id",
            as: "product",
          },
        },
        { $unwind: "$product" },
        {
          $project: {
            product_id: "$_id",
            product_code: { $ifNull: ["$product.code", "$product.sku"] },
            product_name: "$product.name",
            total_qty: { $toDouble: { $round: ["$total_qty", 4] } },
            total_value: { $toDouble: { $round: ["$total_value", 2] } },
            move_count: 1,
          },
        },
      ],
      "dashboard",
    );

    return results;
  }

  // ── Warehouse breakdown: use InventoryBatch (has company+warehouse+qty+cost) ─
  static async _getWarehouseBreakdown(companyId) {
    const coid = new mongoose.Types.ObjectId(companyId);
    const results = await aggregateWithTimeout(
      InventoryBatch,
      [
        {
          $match: {
            company: coid,
            status: { $nin: ["exhausted"] },
          },
        },
        {
          $addFields: {
            _availableQty: {
              $toDouble: { $ifNull: ["$availableQuantity", 0] },
            },
            _unitCost: { $toDouble: { $ifNull: ["$unitCost", 0] } },
          },
        },
        {
          $match: { _availableQty: { $gt: 0 } },
        },
        {
          $group: {
            _id: "$warehouse",
            _products: { $addToSet: "$product" },
            total_units: { $sum: "$_availableQty" },
            total_value: {
              $sum: { $multiply: ["$_availableQty", "$_unitCost"] },
            },
          },
        },
        {
          $lookup: {
            from: "warehouses",
            localField: "_id",
            foreignField: "_id",
            as: "_warehouse",
          },
        },
        { $unwind: "$_warehouse" },
        {
          $project: {
            warehouse_id: "$_id",
            warehouse_name: "$_warehouse.name",
            warehouse_code: "$_warehouse.code",
            sku_count: { $size: "$_products" },
            total_units: { $round: ["$total_units", 4] },
            total_value: { $round: ["$total_value", 2] },
          },
        },
        { $sort: { total_value: -1 } },
      ],
      "dashboard",
    );

    return results;
  }

  // ── Recent movements: unchanged ──────────────────────────────────────────
  static async _getRecentMovements(companyId, limit) {
    const companyOid = new mongoose.Types.ObjectId(companyId);

    return aggregateWithTimeout(
      StockMovement,
      [
        {
          $match: {
            $or: [{ company: companyOid }, { company_id: companyOid }],
          },
        },
        { $sort: { movementDate: -1, createdAt: -1 } },
        { $limit: limit },
        {
          $addFields: {
            _pid: { $ifNull: ["$product", "$product_id"] },
            _wid: { $ifNull: ["$warehouse", "$warehouse_id"] },
          },
        },
        {
          $lookup: {
            from: "products",
            localField: "_pid",
            foreignField: "_id",
            as: "_prod",
          },
        },
        { $unwind: { path: "$_prod", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "warehouses",
            localField: "_wid",
            foreignField: "_id",
            as: "_wh",
          },
        },
        { $unwind: { path: "$_wh", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            type: 1,
            reason: 1,
            quantity: 1,
            qty: 1,
            unitCost: 1,
            unit_cost: 1,
            totalCost: 1,
            total_cost: 1,
            movementDate: 1,
            createdAt: 1,
            created_at: 1,
            product: 1,
            product_id: 1,
            warehouse: 1,
            warehouse_id: 1,
            referenceNumber: 1,
            referenceType: 1,
            product_name: "$_prod.name",
            product_code: { $ifNull: ["$_prod.code", "$_prod.sku"] },
            warehouse_name: "$_wh.name",
            warehouse_code: "$_wh.code",
          },
        },
      ],
      "dashboard",
    );
  }
}

module.exports = InventoryDashboardService;
