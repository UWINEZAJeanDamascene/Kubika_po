const express = require('express');
const router = express.Router();

// General Ledger controller (separate file for maintainability)
const { getGeneralLedger, getGeneralLedgerSummary } = require('../controllers/generalLedgerController');

// Trial Balance controller
const { getTrialBalance } = require('../controllers/trialBalanceController');

// P&L Statement controller
const { getPLStatement } = require('../controllers/plStatementController');

// Balance Sheet controller
const { getBalanceSheet } = require('../controllers/balanceSheetController');

// Cash Flow controller
const { getCashFlow } = require('../controllers/cashFlowController');

// Financial Ratios controller
const { getFinancialRatios } = require('../controllers/financialRatiosController');

// Liability Reports controller
const { getDebtMaturitySchedule, getInterestExpenseAnalysis } = require('../controllers/liabilityReportsController');
const laborCostReportController = require('../controllers/laborCostReportController');

// Budget vs Actual report
const BudgetService = require('../services/budgetService');

const { protect } = require('../middleware/auth');
const { attachCompanyId } = require('../middleware/companyContext');
const { cacheMiddleware, sessionMiddleware } = require('../middleware/cacheMiddleware');

router.use(protect);
router.use(attachCompanyId);
router.use(sessionMiddleware);

// General ledger, trial balance, P&L, balance sheet, cash flow, ratios, and
// liability reports can all be immutable once their covered period is closed.
const cacheClosedReport = (ttl) => cacheMiddleware({
  type: 'report',
  ttl,
  closedPeriodPersistent: true,
});

// General Ledger routes
// GET /api/reports/general-ledger (requires: account_id, date_from, date_to)
router.get('/general-ledger', cacheClosedReport(900), getGeneralLedger);
// GET /api/reports/general-ledger/summary (requires: date_from, date_to)
router.get('/general-ledger/summary', cacheClosedReport(300), getGeneralLedgerSummary);

// Trial Balance route
// GET /api/reports/trial-balance (requires: date_from, date_to)
router.get('/trial-balance', cacheClosedReport(300), getTrialBalance);

// P&L Statement route (detailed)
// GET /api/reports/profit-and-loss (requires: date_from, date_to)
router.get('/profit-and-loss', cacheClosedReport(300), getPLStatement);

// Balance Sheet route
router.get('/balance-sheet', cacheClosedReport(300), getBalanceSheet);

// Cash Flow route
router.get('/cash-flow', cacheClosedReport(900), getCashFlow);

// Financial Ratios route
router.get('/financial-ratios', cacheClosedReport(300), getFinancialRatios);

// Liability Reports routes
// GET /api/reports/debt-maturity (requires: as_of_date)
router.get('/debt-maturity', cacheClosedReport(300), getDebtMaturitySchedule);

// GET /api/reports/interest-expense (requires: date_from, date_to)
router.get('/interest-expense', cacheClosedReport(300), getInterestExpenseAnalysis);

// Budget vs Actual route
router.get('/budget-vs-actual', cacheClosedReport(300), async (req, res) => {
  try {
    const companyId = req.companyId;
    const { budgetId } = req.query;

    if (!budgetId) {
      return res.status(400).json({ success: false, error: 'budgetId is required' });
    }

    const comparison = await BudgetService.getComparison(companyId, budgetId);
    res.json({ success: true, data: comparison });
  } catch (error) {
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Budget not found' });
    }
    res.status(400).json({ success: false, error: error.message });
  }
});

// Labor Cost Analysis routes
router.get('/labor-cost-analysis', cacheClosedReport(300), laborCostReportController.getLaborCostAnalysis);
router.get('/payroll-audit-trail', cacheClosedReport(300), laborCostReportController.getPayrollAuditTrail);

module.exports = router;
