const express = require("express");
const router = express.Router();
const budgetController = require("../controllers/budgetController");
const { protect } = require("../middleware/auth");
const { authorize } = require("../middleware/authorize");
const { attachCompanyId } = require("../middleware/companyContext");
const { cacheMiddleware, cacheInvalidationMiddleware } = require("../middleware/cacheMiddleware");

// All routes require authentication + company context
router.use(protect);
router.use(attachCompanyId);

// One pair of middlewares covers all 74 endpoints: cacheMiddleware only acts on
// GET, cacheInvalidationMiddleware only on POST/PUT/PATCH/DELETE.
//
// Invalidation is per-company rather than type-wide: this is a write-heavy
// module, and wiping every tenant's budget cache on each edit would throw away
// far more than it protects.
//
// Note the TTL is short because budget-vs-actual is derived from posted
// transactions, which do not go through these routes. Journal posting clears
// the 'budget' type via cacheService.invalidateFinancialReportCaches().
//
// Live-commitment exception: period-lock checks and encumbrance/actual-
// consumption balances are read immediately before a caller decides whether
// to liquidate/release an encumbrance, execute a transfer, or approve a step.
// A cached "not locked" or stale available-balance answer here is the same
// class of bug as a stale stock quantity at POS/GRN time, so these paths
// always read live rather than serving up to 300s of staleness.
const LIVE_BUDGET_READ_SUFFIXES = ['/period-locks/check', '/encumbrances/summary', '/actual-consumptions'];
router.use(cacheMiddleware({
  type: "budget",
  ttl: 300,
  skipCache: (req) => req.query.refresh === '1' || req.query.refresh === 'true'
    || LIVE_BUDGET_READ_SUFFIXES.some((suffix) => req.path.endsWith(suffix)),
}));
router.use(cacheInvalidationMiddleware({
  types: ["budget", "report"],
  invalidateDashboards: true,
}));

// ── Forecasts (must be before /:id routes to avoid conflicts) ──────────
router.get(
  "/forecast/revenue",
  authorize("budgets", "read"),
  budgetController.getRevenueForecast,
);
router.get(
  "/forecast/expense",
  authorize("budgets", "read"),
  budgetController.getExpenseForecast,
);
router.get(
  "/forecast/cashflow",
  authorize("budgets", "read"),
  budgetController.getCashFlowForecast,
);

// ── Summary & Comparisons (must be before /:id routes) ─────────────────
router.get(
  "/summary",
  authorize("budgets", "read"),
  budgetController.getSummary,
);
router.get(
  "/compare/all",
  authorize("budgets", "read"),
  budgetController.getAllComparisons,
);

// ── Budget CRUD ────────────────────────────────────────────────────────
router.post("/", authorize("budgets", "create"), budgetController.createBudget);
router.get("/", authorize("budgets", "read"), budgetController.getBudgets);

// ── Workflow Configuration (MUST be before /:id routes) ───────────────
router.get(
  "/workflow-configs",
  authorize("budgets", "read"),
  budgetController.getWorkflowConfigs,
);
router.get(
  "/workflow-configs/:configId",
  authorize("budgets", "read"),
  budgetController.getWorkflowConfigById,
);
router.post(
  "/workflow-configs",
  authorize("budgets", "admin"),
  budgetController.createWorkflowConfig,
);
router.put(
  "/workflow-configs/:configId",
  authorize("budgets", "admin"),
  budgetController.updateWorkflowConfig,
);
router.delete(
  "/workflow-configs/:configId",
  authorize("budgets", "admin"),
  budgetController.deleteWorkflowConfig,
);
router.post(
  "/workflow-configs/:configId/set-default",
  authorize("budgets", "admin"),
  budgetController.setDefaultWorkflowConfig,
);
router.post(
  "/workflow-configs/test-match",
  authorize("budgets", "read"),
  budgetController.testWorkflowMatch,
);

router.get(
  "/:id",
  authorize("budgets", "read"),
  budgetController.getBudgetById,
);
router.put(
  "/:id",
  authorize("budgets", "update"),
  budgetController.updateBudget,
);
router.delete(
  "/:id",
  authorize("budgets", "delete"),
  budgetController.deleteBudget,
);

// ── Budget Lines ───────────────────────────────────────────────────────
router.post(
  "/:id/lines",
  authorize("budgets", "update"),
  budgetController.upsertLines,
);
router.get(
  "/:id/lines",
  authorize("budgets", "read"),
  budgetController.getLines,
);

// ── Budget Actions ─────────────────────────────────────────────────────
router.post(
  "/:id/approve",
  authorize("budgets", "approve"),
  budgetController.approveBudget,
);
router.post(
  "/:id/reject",
  authorize("budgets", "approve"),
  budgetController.rejectBudget,
);
router.post(
  "/:id/lock",
  authorize("budgets", "approve"),
  budgetController.lockBudget,
);
router.post(
  "/:id/unlock",
  authorize("budgets", "approve"),
  budgetController.unlockBudget,
);
router.post(
  "/:id/close",
  authorize("budgets", "approve"),
  budgetController.closeBudget,
);
router.post(
  "/:id/clone",
  authorize("budgets", "create"),
  budgetController.cloneBudget,
);

// ── Comparison & Reports ───────────────────────────────────────────────
router.get(
  "/:id/compare",
  authorize("budgets", "read"),
  budgetController.getComparison,
);
router.get(
  "/:id/variance-report",
  authorize("budgets", "read"),
  budgetController.getVarianceReport,
);

// ── Budget Transfers ───────────────────────────────────────────────────
router.post(
  "/:id/transfers",
  authorize("budgets", "update"),
  budgetController.createTransfer,
);
router.get(
  "/:id/transfers",
  authorize("budgets", "read"),
  budgetController.getTransfers,
);
router.post(
  "/:id/transfers/:transferId/approve",
  authorize("budgets", "approve"),
  budgetController.approveTransfer,
);
router.post(
  "/:id/transfers/:transferId/reject",
  authorize("budgets", "approve"),
  budgetController.rejectTransfer,
);
router.post(
  "/:id/transfers/:transferId/execute",
  authorize("budgets", "approve"),
  budgetController.executeTransfer,
);
router.post(
  "/:id/transfers/:transferId/cancel",
  authorize("budgets", "update"),
  budgetController.cancelTransfer,
);

// ── Encumbrances ───────────────────────────────────────────────────────
router.post(
  "/:id/encumbrances",
  authorize("budgets", "update"),
  budgetController.createEncumbrance,
);
router.get(
  "/:id/encumbrances",
  authorize("budgets", "read"),
  budgetController.getEncumbrances,
);
router.get(
  "/:id/actual-consumptions",
  authorize("budgets", "read"),
  budgetController.getActualConsumptions,
);
router.get(
  "/:id/encumbrances/summary",
  authorize("budgets", "read"),
  budgetController.getEncumbranceSummary,
);
router.post(
  "/encumbrances/:sourceType/:sourceId/liquidate",
  authorize("budgets", "approve"),
  budgetController.liquidateEncumbrance,
);
router.post(
  "/encumbrances/:sourceType/:sourceId/release",
  authorize("budgets", "update"),
  budgetController.releaseEncumbrance,
);
router.post(
  "/encumbrances/:encumbranceId/adjust",
  authorize("budgets", "update"),
  budgetController.adjustEncumbrance,
);

// ── Multi-Level Approvals ─────────────────────────────────────────────
router.post(
  "/:id/approvals/submit",
  authorize("budgets", "update"),
  budgetController.submitForApproval,
);
router.get(
  "/:id/approvals/history",
  authorize("budgets", "read"),
  budgetController.getApprovalHistory,
);
router.get(
  "/:id/approvals/:approvalId",
  authorize("budgets", "read"),
  budgetController.getApproval,
);
router.post(
  "/:id/approvals/:approvalId/approve",
  authorize("budgets", "approve"),
  budgetController.approveStep,
);
router.post(
  "/:id/approvals/:approvalId/reject",
  authorize("budgets", "approve"),
  budgetController.rejectApproval,
);
router.post(
  "/:id/approvals/:approvalId/request-changes",
  authorize("budgets", "approve"),
  budgetController.requestChanges,
);
router.post(
  "/:id/approvals/:approvalId/resubmit",
  authorize("budgets", "update"),
  budgetController.resubmitApproval,
);
router.post(
  "/:id/approvals/:approvalId/cancel",
  authorize("budgets", "update"),
  budgetController.cancelApproval,
);

// Global: Get my pending approvals across all budgets
router.get(
  "/approvals/my-pending",
  authorize("budgets", "approve"),
  budgetController.getMyPendingApprovals,
);

// ── Variance Alerts ────────────────────────────────────────────────────
router.get(
  "/:id/alerts/config",
  authorize("budgets", "read"),
  budgetController.getAlertConfiguration,
);
router.put(
  "/:id/alerts/config",
  authorize("budgets", "update"),
  budgetController.updateAlertConfiguration,
);
router.post(
  "/:id/alerts/check",
  authorize("budgets", "read"),
  budgetController.checkVariance,
);
router.get(
  "/alerts/attention-needed",
  authorize("budgets", "read"),
  budgetController.getBudgetsNeedingAttention,
);
router.post(
  "/alerts/run-checks",
  authorize("budgets", "admin"),
  budgetController.runVarianceChecks,
);

// ── Budget Period Locking ─────────────────────────────────────────────
router.get(
  "/:id/period-locks",
  authorize("budgets", "read"),
  budgetController.getPeriodLocks,
);
router.post(
  "/:id/period-locks/lock",
  authorize("budgets", "update"),
  budgetController.lockPeriod,
);
router.post(
  "/:id/period-locks/unlock",
  authorize("budgets", "update"),
  budgetController.unlockPeriod,
);
router.get(
  "/:id/period-locks/check",
  authorize("budgets", "read"),
  budgetController.checkPeriodLock,
);
router.put(
  "/:id/period-locks/settings",
  authorize("budgets", "update"),
  budgetController.updateLockSettings,
);
router.post(
  "/period-locks/run-auto",
  authorize("budgets", "admin"),
  budgetController.runAutoLock,
);

// ── Revision Tracking ──────────────────────────────────────────────────
router.get(
  "/:id/revisions",
  authorize("budgets", "read"),
  budgetController.getRevisionHistory,
);
router.get(
  "/:id/revisions/stats",
  authorize("budgets", "read"),
  budgetController.getRevisionStats,
);
router.get(
  "/:id/revisions/:revisionNumber",
  authorize("budgets", "read"),
  budgetController.getRevision,
);
router.get(
  "/:id/revisions/compare",
  authorize("budgets", "read"),
  budgetController.compareRevisions,
);
router.post(
  "/:id/revisions/rollback",
  authorize("budgets", "admin"),
  budgetController.rollbackToRevision,
);

// ── Import/Export ───────────────────────────────────────────────────────
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

// Download import template
router.get(
  "/import/template",
  authorize("budgets", "read"),
  budgetController.downloadImportTemplate,
);

// Parse import file (step 1: upload and parse)
router.post(
  "/import/parse",
  authorize("budgets", "create"),
  upload.single("file"),
  budgetController.parseImport,
);

// Validate import data (step 2: validate against database)
router.post(
  "/import/validate",
  authorize("budgets", "create"),
  budgetController.validateImport,
);

// Execute import (step 3: save to database)
router.post(
  "/import/execute",
  authorize("budgets", "create"),
  budgetController.executeImport,
);

// ── BUDGET SCENARIOS / WHAT-IF ANALYSIS ────────────────────────────────

// Get all scenarios for a budget
router.get(
  "/:id/scenarios",
  authorize("budgets", "read"),
  budgetController.getScenarios,
);

// Create a new scenario from an existing budget
router.post(
  "/:id/scenarios",
  authorize("budgets", "create"),
  budgetController.createScenario,
);

// Compare multiple scenarios
router.post(
  "/scenarios/compare",
  authorize("budgets", "read"),
  budgetController.compareScenarios,
);

// Set a scenario as primary
router.post(
  "/scenarios/:scenarioId/set-primary",
  authorize("budgets", "update"),
  budgetController.setPrimaryScenario,
);

// Delete a scenario
router.delete(
  "/scenarios/:scenarioId",
  authorize("budgets", "delete"),
  budgetController.deleteScenario,
);

module.exports = router;
