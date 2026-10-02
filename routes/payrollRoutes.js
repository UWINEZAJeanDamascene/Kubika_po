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
  backfillPayrollJournals,
  getPayrollPeriodInputs,
  savePayrollPeriodInput,
  approvePayrollPeriodInput,
} = require("../controllers/payrollController");
const { protect, authorize } = require("../middleware/auth");

router.use(protect);

// Calculate payroll (preview)
router.route("/calculate").post(calculatePayroll);

// Summary
router.route("/summary").get(getPayrollSummary);

// Approved attendance, leave, earnings, and deductions consumed by payroll generation
router.route("/period-inputs").get(authorize("admin", "manager"), getPayrollPeriodInputs);
router.route("/period-inputs").post(authorize("admin", "manager"), savePayrollPeriodInput);
router.route("/period-inputs/:inputId/approve").post(authorize("admin", "manager"), approvePayrollPeriodInput);

// Bulk create
router.route("/bulk").post(bulkCreatePayroll);

// Generate payroll from Employee Master (bulk run for all active or selected employees)
router.route("/generate").post(authorize("admin", "manager"), generatePayroll);

// Backfill missing journal entries for existing finalised/paid payroll records
// GET  ?dry_run=true  → preview only (no writes)
// POST               → apply backfill
router
  .route("/backfill-journals")
  .get(authorize("admin", "manager"), backfillPayrollJournals)
  .post(authorize("admin", "manager"), backfillPayrollJournals);

// CRUD
router.route("/").get(getPayrollRecords).post(createPayroll);

router
  .route("/:id")
  .get(getPayrollById)
  .put(updatePayroll)
  .delete(deletePayroll);

// Process payment
router.route("/:id/pay").post(authorize("admin", "manager"), processPayment);

// Finalise payroll record (ready for PayrollRun)
router
  .route("/:id/finalise")
  .post(authorize("admin", "manager"), finalisePayroll);

// Get payslip
router.route("/:id/payslip").get(getPayslip);

module.exports = router;
