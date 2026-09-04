/**
 * Consolidated dashboard route ownership.
 *
 * This file used to be two separately-mounted routers at the same base path
 * (`dashboard.routes.js` for the newer executive/inventory/sales/purchase/
 * finance/ratios/period-comparison widgets, and this file for the legacy
 * stats/activity/chart endpoints), relying on Express mount order for the
 * two path sets to not collide. Traffic verification confirmed both sets are
 * live (the frontend calls both `dashboardApi.getStats/getRecentActivities/
 * getLowStockAlerts/getTopSellingProducts/getTopClients/getSalesChart/
 * getStockMovementChart` and `dashboardApi.getExecutive/getInventory/
 * getSales/getPurchase/getFinance/getRatios/getPeriodComparison`), so neither
 * side is dead code to retire. Consolidating into one explicitly-ordered
 * router removes the "which file wins if a path is added twice" ambiguity
 * without changing any path, handler, or middleware behavior.
 */
const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { attachCompanyId } = require('../middleware/companyContext');
const { sessionMiddleware } = require('../middleware/cacheMiddleware');
const {
  getDashboardStats,
  getRecentActivities,
  getLowStockAlerts,
  getTopSellingProducts,
  getTopClients,
  getSalesChart,
  getStockMovementChart,
} = require('../controllers/dashboardController');

const ExecutiveDashboardService = require('../services/dashboards/ExecutiveDashboardService');
const InventoryDashboardService = require('../services/dashboards/InventoryDashboardService');
const SalesDashboardService = require('../services/dashboards/SalesDashboardService');
const PurchaseDashboardService = require('../services/dashboards/PurchaseDashboardService');
const FinanceDashboardService = require('../services/dashboards/FinanceDashboardService');
const RatiosWidgetService = require('../services/dashboards/RatiosWidgetService');
const PeriodComparisonService = require('../services/dashboards/PeriodComparisonService');
const dashboardCache = require('../services/DashboardCacheService');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

router.use(protect);
router.use(sessionMiddleware);
// Dashboards always read the latest committed totals; a stale executive
// summary or stock count is a correctness bug, not a performance win.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ── SQL-backed widget dashboards (attachCompanyId + reports:read) ─────────
router.get(
  '/executive',
  attachCompanyId,
  authorize('reports', 'read'),
  asyncHandler(async (req, res) => {
    const skipCache = req.query.refresh === '1' || req.query.refresh === 'true';
    if (skipCache) {
      await dashboardCache.invalidateDashboard(req.companyId, 'executive');
    }
    res.json(await ExecutiveDashboardService.get(req.companyId, { skipCache }));
  }),
);

router.get(
  '/inventory',
  attachCompanyId,
  authorize('reports', 'read'),
  asyncHandler(async (req, res) => {
    res.json(await InventoryDashboardService.get(req.companyId));
  }),
);

router.get(
  '/sales',
  attachCompanyId,
  authorize('reports', 'read'),
  asyncHandler(async (req, res) => {
    res.json(await SalesDashboardService.get(req.companyId));
  }),
);

router.get(
  '/purchase',
  attachCompanyId,
  authorize('reports', 'read'),
  asyncHandler(async (req, res) => {
    res.json(await PurchaseDashboardService.get(req.companyId));
  }),
);

router.get(
  '/finance',
  attachCompanyId,
  authorize('reports', 'read'),
  asyncHandler(async (req, res) => {
    res.json(await FinanceDashboardService.get(req.companyId));
  }),
);

router.get(
  '/ratios',
  attachCompanyId,
  authorize('reports', 'read'),
  asyncHandler(async (req, res) => {
    res.json(await RatiosWidgetService.get(req.companyId));
  }),
);

router.get(
  '/period-comparison',
  attachCompanyId,
  authorize('reports', 'read'),
  asyncHandler(async (req, res) => {
    res.json(await PeriodComparisonService.get(req.companyId));
  }),
);

router.post(
  '/cache/clear',
  attachCompanyId,
  authorize('settings', 'update'),
  async (req, res) => {
    try {
      await dashboardCache.invalidate(req.companyId);
      res.json({ success: true, message: 'Dashboard cache cleared' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ── Legacy stats/activity/chart endpoints (protect only, no attachCompanyId) ─
router.get('/stats', getDashboardStats);
router.get('/recent-activities', getRecentActivities);
router.get('/low-stock-alerts', getLowStockAlerts);
router.get('/top-selling-products', getTopSellingProducts);
router.get('/top-clients', getTopClients);
router.get('/sales-chart', getSalesChart);
router.get('/stock-movement-chart', getStockMovementChart);

module.exports = router;
