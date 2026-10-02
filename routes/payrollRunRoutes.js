const express = require("express");
const router = express.Router();
const {
  getPayrollRuns,
  getPayrollRunById,
  getPayrollRunAuditHistory,
  createPayrollRun,
  postPayrollRun,
  reversePayrollRun,
  deletePayrollRun,
  previewPayrollRun,
  createFromRecords,
  getAvailablePeriods,
  remitPaye,
  remitRssb,
  generateBankTransfer,
  confirmBankTransfer,
  exportStatutoryFiling,
  submitStatutoryFiling,
  getComplianceDeadlines,
} = require("../controllers/payrollRunController");
const { protect } = require("../middleware/auth");
const { requirePayrollPermission } = require("../middleware/payrollPermission");

router.use(protect);

// CRUD routes
router
  .route("/")
  .get(requirePayrollPermission("read"), getPayrollRuns)
  .post(requirePayrollPermission("create"), createPayrollRun);

// Preview journal entry before posting (MUST be before /:id)
router.route("/preview").get(requirePayrollPermission("read"), previewPayrollRun);

// Available periods — months that have finalised, unprocessed payroll records
// (MUST be before /:id so it is not treated as an id param)
router.route("/available-periods").get(requirePayrollPermission("read"), getAvailablePeriods);
router.route("/compliance/deadlines").get(requirePayrollPermission("read"), getComplianceDeadlines);

// Create payroll run from finalised employee records (MUST be before /:id)
router
  .route("/from-records")
  .post(requirePayrollPermission("create"), createFromRecords);

router.route("/:id/audit").get(requirePayrollPermission("read"), getPayrollRunAuditHistory);

router
  .route("/:id")
  .get(requirePayrollPermission("read"), getPayrollRunById)
  .delete(requirePayrollPermission("delete"), deletePayrollRun);

// Post payroll run (creates journal entry)
router.route("/:id/post").post(requirePayrollPermission("post"), postPayrollRun);

// Reverse payroll run
router.route("/:id/reverse").post(requirePayrollPermission("admin"), reversePayrollRun);

// Remittance tracking (Rwanda RRA / RSSB compliance)
router.route("/:id/remit-paye").post(requirePayrollPermission("remit"), remitPaye);
router.route("/:id/remit-rssb").post(requirePayrollPermission("remit"), remitRssb);

// Bank transfer export (CSV/Excel/XML for bank upload)
router.route("/:id/bank-transfer").get(requirePayrollPermission("export"), generateBankTransfer);
router.route("/:id/bank-transfer/confirm").post(requirePayrollPermission("pay"), confirmBankTransfer);
router.route("/:id/statutory-export/:type").get(requirePayrollPermission("export"), exportStatutoryFiling);
router.route("/:id/filings/:type").post(requirePayrollPermission("file"), submitStatutoryFiling);

module.exports = router;
