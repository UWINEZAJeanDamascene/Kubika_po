const { prisma } = require("../../lib/prisma");
const { toIdString } = require("../../utils/objectId");
const { decimalToNumber } = require("../../utils/decimalHelpers");
const dateHelpers = require("../../utils/dateHelpers");
const dashboardCache = require("../DashboardCacheService");
const journalAgg = require("../journalAggregationService");

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

  // ── Summary: single SQL scan (SUM/COUNT pushed to Postgres) ────────────────
  static async _getStockSummary(companyId) {
    const cid = toIdString(companyId);

    const rows = await prisma.$queryRaw`
      SELECT
        COUNT(*)::int AS total_sku_count,
        COALESCE(SUM(current_stock), 0)::float AS total_units,
        COALESCE(SUM(current_stock * average_cost), 0)::float AS total_value,
        COALESCE(SUM(reserved_quantity), 0)::float AS total_reserved,
        COUNT(*) FILTER (WHERE current_stock > 0)::int AS in_stock_count
      FROM products
      WHERE company_id = ${cid}
        AND is_active = true
        AND is_archived = false
        AND is_stockable = true
    `;

    const s = rows[0] || {};
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

  // ── Low-stock alerts: reorder-point fallback logic pushed into SQL ─────────
  static async _getLowStockAlerts(companyId) {
    const cid = toIdString(companyId);

    const rows = await prisma.$queryRaw`
      SELECT * FROM (
        SELECT
          p.id AS product_id,
          p.sku AS product_code,
          p.name AS product_name,
          w.id AS warehouse_id,
          w.name AS warehouse_name,
          ROUND(p.current_stock::numeric, 4)::float AS qty_on_hand,
          ROUND(p.reserved_quantity::numeric, 4)::float AS qty_reserved,
          ROUND((p.current_stock - p.reserved_quantity)::numeric, 4)::float AS qty_available,
          ROUND((CASE WHEN p.reorder_point > 0 THEN p.reorder_point ELSE p.low_stock_threshold END)::numeric, 4)::float AS reorder_point,
          p.reorder_quantity::float AS reorder_qty,
          ROUND(((CASE WHEN p.reorder_point > 0 THEN p.reorder_point ELSE p.low_stock_threshold END) - (p.current_stock - p.reserved_quantity))::numeric, 4)::float AS shortage
        FROM products p
        LEFT JOIN warehouses w ON w.id = p.default_warehouse_id
        WHERE p.company_id = ${cid}
          AND p.is_active = true
          AND p.is_archived = false
          AND p.is_stockable = true
      ) sub
      WHERE sub.reorder_point > 0 AND sub.qty_available <= sub.reorder_point
      ORDER BY sub.shortage DESC
    `;

    return rows;
  }

  // ── Dead stock: reuse journalAggregationService's outbound-activity lookup ─
  static async _getDeadStock(companyId) {
    const cid = toIdString(companyId);
    const ninetyDaysAgo = dateHelpers.lastNDays(DEAD_STOCK_LOOKBACK_DAYS).start;

    const activeProductIds = await journalAgg.getActiveOutboundProductIds(
      cid,
      ninetyDaysAgo,
    );

    const rows = await prisma.$queryRaw`
      SELECT
        p.id AS product_id,
        p.sku AS product_code,
        p.name AS product_name,
        ROUND(p.current_stock::numeric, 4)::float AS qty_on_hand,
        ROUND(p.average_cost::numeric, 6)::float AS avg_cost,
        ROUND((p.current_stock * p.average_cost)::numeric, 2)::float AS stock_value
      FROM products p
      WHERE p.company_id = ${cid}
        AND p.is_active = true
        AND p.is_archived = false
        AND p.is_stockable = true
        AND p.current_stock > 0
        AND NOT (p.id = ANY(${activeProductIds}::text[]))
      ORDER BY stock_value DESC
      LIMIT 20
    `;

    return rows.map((r) => ({ ...r, days_no_movement: DEAD_STOCK_LOOKBACK_DAYS }));
  }

  // ── Top moving: SQL GROUP BY + JOIN instead of full-scan + in-memory group ─
  static async _getTopMovingProducts(companyId, limit) {
    const cid = toIdString(companyId);
    const thirtyDays = dateHelpers.lastNDays(TOP_MOVING_WINDOW_DAYS);

    const rows = await prisma.$queryRaw`
      SELECT
        sm.product_id AS product_id,
        p.sku AS product_code,
        p.name AS product_name,
        ROUND(SUM(sm.quantity)::numeric, 4)::float AS total_qty,
        ROUND(SUM(sm.total_cost)::numeric, 2)::float AS total_value,
        COUNT(*)::int AS move_count
      FROM stock_movements sm
      JOIN products p ON p.id = sm.product_id
      WHERE sm.company_id = ${cid}
        AND (sm.reason = 'dispatch' OR sm.type = 'out')
        AND sm.movement_date >= ${thirtyDays.start}
        AND sm.movement_date <= ${thirtyDays.end}
      GROUP BY sm.product_id, p.sku, p.name
      ORDER BY total_qty DESC
      LIMIT ${limit}
    `;

    return rows;
  }

  // ── Warehouse breakdown: InventoryBatch grouped by warehouse in SQL ────────
  static async _getWarehouseBreakdown(companyId) {
    const cid = toIdString(companyId);

    const rows = await prisma.$queryRaw`
      SELECT
        ib.warehouse_id AS warehouse_id,
        w.name AS warehouse_name,
        w.code AS warehouse_code,
        COUNT(DISTINCT ib.product_id)::int AS sku_count,
        ROUND(SUM(ib.available_quantity)::numeric, 4)::float AS total_units,
        ROUND(SUM(ib.available_quantity * ib.unit_cost)::numeric, 2)::float AS total_value
      FROM inventory_batches ib
      JOIN warehouses w ON w.id = ib.warehouse_id
      WHERE ib.company_id = ${cid}
        AND ib.status <> 'exhausted'
        AND ib.available_quantity > 0
      GROUP BY ib.warehouse_id, w.name, w.code
      ORDER BY total_value DESC
    `;

    return rows;
  }

  // ── Recent movements: plain indexed findMany + include (no aggregation needed) ─
  static async _getRecentMovements(companyId, limit) {
    const cid = toIdString(companyId);

    const rows = await prisma.stockMovement.findMany({
      where: { companyId: cid },
      orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
      take: limit,
      select: {
        type: true,
        reason: true,
        quantity: true,
        unitCost: true,
        totalCost: true,
        movementDate: true,
        createdAt: true,
        productId: true,
        warehouseId: true,
        referenceNumber: true,
        referenceType: true,
        product: { select: { name: true, sku: true } },
        warehouse: { select: { name: true, code: true } },
      },
    });

    return rows.map((r) => ({
      type: r.type,
      reason: r.reason,
      quantity: decimalToNumber(r.quantity),
      qty: decimalToNumber(r.quantity),
      unitCost: decimalToNumber(r.unitCost),
      unit_cost: decimalToNumber(r.unitCost),
      totalCost: decimalToNumber(r.totalCost),
      total_cost: decimalToNumber(r.totalCost),
      movementDate: r.movementDate,
      createdAt: r.createdAt,
      created_at: r.createdAt,
      product: r.productId,
      product_id: r.productId,
      warehouse: r.warehouseId,
      warehouse_id: r.warehouseId,
      referenceNumber: r.referenceNumber,
      referenceType: r.referenceType,
      product_name: r.product ? r.product.name : null,
      product_code: r.product ? r.product.sku : null,
      warehouse_name: r.warehouse ? r.warehouse.name : null,
      warehouse_code: r.warehouse ? r.warehouse.code : null,
    }));
  }
}

module.exports = InventoryDashboardService;
