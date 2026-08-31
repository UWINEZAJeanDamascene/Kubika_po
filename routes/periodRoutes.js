const express = require('express');
const router = express.Router();
const periodController = require('../controllers/periodController');
const { protect } = require('../middleware/auth');
const { attachCompanyId } = require('../middleware/companyContext');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

// Period definitions change only at open/close/lock, so they cache well. Every
// mutation below invalidates, because a stale "period is open" answer would let
// a posting through into a period that has just been closed.
//
// NOTE: closing or reopening a period also changes what the report cache is
// allowed to hold (a closed period's figures are immutable, a reopened one's
// are not), so these handlers invalidate the report type as well.
const cachePeriods = cacheMiddleware({ type: 'period', ttl: 600 });
const invalidatePeriods = cacheInvalidationMiddleware({ type: 'period', invalidateAll: true });
const invalidateReports = cacheInvalidationMiddleware({ type: 'report', invalidateAll: true });

// All period routes require auth and company context
router.use(protect);
router.use(attachCompanyId);

// POST /api/periods/generate - Generate 12 monthly periods for a fiscal year
router.post('/generate', invalidatePeriods, periodController.generateFiscalYear);

// GET /api/periods/current - Get the currently open period for today's date
router.get('/current', cachePeriods, periodController.getCurrentPeriod);

// POST /api/periods/year-end-close - Perform year-end close for a fiscal year
router.post('/year-end-close', invalidatePeriods, invalidateReports, periodController.performYearEndClose);

// GET /api/periods - List all periods. Filter: fiscal_year, status
router.get('/', cachePeriods, periodController.getAllPeriods);

// GET /api/periods/:id - Get single period
router.get('/:id', cachePeriods, periodController.getPeriod);

// POST /api/periods/:id/close - Close a period
router.post('/:id/close', invalidatePeriods, invalidateReports, periodController.closePeriod);

// POST /api/periods/:id/reopen - Reopen a closed period
router.post('/:id/reopen', invalidatePeriods, invalidateReports, periodController.reopenPeriod);

// POST /api/periods/:id/lock - Lock permanently
router.post('/:id/lock', invalidatePeriods, invalidateReports, periodController.lockPeriod);

module.exports = router;
