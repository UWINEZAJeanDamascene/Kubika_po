/**
 * Phase 3 dashboard API — seven read endpoints + manual cache clear.
 * Each GET requires reports:read; POST /cache/clear requires settings:update.
 * Responses are the raw service payloads (no { success, data } wrapper).
 */
const express = require('express')
const router = express.Router()

const { protect } = require('../middleware/auth')
const { authorize } = require('../middleware/authorize')
const { attachCompanyId } = require('../middleware/companyContext')
const { sessionMiddleware } = require('../middleware/cacheMiddleware')

const ExecutiveDashboardService = require('../services/dashboards/ExecutiveDashboardService')
const InventoryDashboardService = require('../services/dashboards/InventoryDashboardService')
const SalesDashboardService = require('../services/dashboards/SalesDashboardService')
const PurchaseDashboardService = require('../services/dashboards/PurchaseDashboardService')
const FinanceDashboardService = require('../services/dashboards/FinanceDashboardService')
const RatiosWidgetService = require('../services/dashboards/RatiosWidgetService')
const PeriodComparisonService = require('../services/dashboards/PeriodComparisonService')
const dashboardCache = require('../services/DashboardCacheService')

router.use(protect)
router.use(sessionMiddleware)

function asyncHandler (fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

// attachCompanyId only on Phase 3 routes so legacy /stats etc. still fall through to dashboardRoutes.js
// Order matches Phase 3 spec listing
router.get('/executive',
  attachCompanyId,
  authorize('reports', 'read'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const skipCache = req.query.refresh === '1' || req.query.refresh === 'true'
    if (skipCache) {
      await dashboardCache.invalidateDashboard(req.companyId, 'executive')
    }
    res.json(await ExecutiveDashboardService.get(req.companyId, { skipCache }))
  })
)

router.get('/inventory',
  attachCompanyId,
  authorize('reports', 'read'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json(await InventoryDashboardService.get(req.companyId))
  })
)

router.get('/sales',
  attachCompanyId,
  authorize('reports', 'read'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json(await SalesDashboardService.get(req.companyId))
  })
)

router.get('/purchase',
  attachCompanyId,
  authorize('reports', 'read'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json(await PurchaseDashboardService.get(req.companyId))
  })
)

router.get('/finance',
  attachCompanyId,
  authorize('reports', 'read'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json(await FinanceDashboardService.get(req.companyId))
  })
)

router.get('/ratios',
  attachCompanyId,
  authorize('reports', 'read'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json(await RatiosWidgetService.get(req.companyId))
  })
)

router.get('/period-comparison',
  attachCompanyId,
  authorize('reports', 'read'),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json(await PeriodComparisonService.get(req.companyId))
  })
)

router.post('/cache/clear',
  attachCompanyId,
  authorize('settings', 'update'),
  async (req, res) => {
    try {
      await dashboardCache.invalidate(req.companyId)
      res.json({ success: true, message: 'Dashboard cache cleared' })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  }
)

module.exports = router
