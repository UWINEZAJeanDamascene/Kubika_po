const express = require('express');
const router = express.Router();
const glCtrl = require('../controllers/glFinancialsController');
const { protect } = require('../middleware/auth');
const { attachCompanyId } = require('../middleware/companyContext');
const { cacheMiddleware } = require('../middleware/cacheMiddleware');

const cacheClosedReport = cacheMiddleware({
  type: 'report',
  ttl: 300,
  closedPeriodPersistent: true,
});

router.use(protect);
router.use(attachCompanyId);

// GET /api/gl-financials/pl
router.get('/pl', cacheClosedReport, glCtrl.getProfitAndLoss);

// GET /api/gl-financials/balance-sheet
router.get('/balance-sheet', cacheClosedReport, glCtrl.getBalanceSheet);

module.exports = router;
