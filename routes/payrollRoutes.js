const express = require("express");
const router = express.Router();
const {
  getPayrollRecords,
  getPayrollById,
  createPayroll,
  updatePayroll,
  deletePayroll,
  processPayment,
  getPayrollSummary,
  calculatePayroll,
  bulkCreatePayroll,
  generatePayroll,
  finalisePayroll,
  getPayslip,
  getMyPayroll,
  backfillPayrollJournals,
  getPayrollPeriodInputs,
  savePayrollPeriodInput,
  approvePayrollPeriodInput,
  getPayrollAuditHistory,
  getPayrollPeriodInputAuditHistory,
} = require("../controllers/payrollController");
const { protect } = require("../middleware/auth");
const { requirePayrollPermission } = require("../middleware/payrollPermission");

router.use(protect);

// Employee self-service is tied to the authenticated email and tenant, not payroll-wide access.
router.route("/me").get(getMyPayroll);

// Calculate payroll (preview)
router.route("/calculate").post(requirePayrollPermission("read"), calculatePayroll);

// Summary
router.route("/summary").get(requirePayrollPermission("read"), getPayrollSummary);

// Approved attendance, leave, earnings, and deductions consumed by payroll generation
router.route("/period-inputs").get(requirePayrollPermission("read"), getPayrollPeriodInputs);
router.route("/period-inputs").post(requirePayrollPermission("update"), savePayrollPeriodInput);
router.route("/period-inputs/:inputId/approve").post(requirePayrollPermission("approve"), approvePayrollPeriodInput);
router.route("/period-inputs/:inputId/audit").get(requirePayrollPermission("read"), getPayrollPeriodInputAuditHistory);

// Bulk create
router.route("/bulk").post(requirePayrollPermission("create"), bulkCreatePayroll);

// Generate payroll from Employee Master (bulk run for all active or selected employees)
router.route("/generate").post(requirePayrollPermission("create"), generatePayroll);

// Backfill missing journal entries for existing finalised/paid payroll records
// GET  ?dry_run=true  → preview only (no writes)
// POST               → apply backfill
router
  .route("/backfill-journals")
  .get(requirePayrollPermission("admin"), backfillPayrollJournals)
  .post(requirePayrollPermission("admin"), backfillPayrollJournals);

// CRUD
router.route("/").get(requirePayrollPermission("read"), getPayrollRecords).post(requirePayrollPermission("create"), createPayroll);

router
  .route("/:id")
  .get(requirePayrollPermission("read"), getPayrollById)
  .put(requirePayrollPermission("update"), updatePayroll)
  .delete(requirePayrollPermission("delete"), deletePayroll);

// Process payment
router.route("/:id/pay").post(requirePayrollPermission("pay"), processPayment);

// Finalise payroll record (ready for PayrollRun)
router
  .route("/:id/finalise")
  .post(requirePayrollPermission("approve"), finalisePayroll);

// Get payslip
router.route("/:id/payslip").get(getPayslip);
router.route("/:id/audit").get(requirePayrollPermission("read"), getPayrollAuditHistory);

module.exports = router;
