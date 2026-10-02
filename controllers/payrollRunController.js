const PayrollRunService = require("../services/payrollRunService");
const PayrollRun = require("../models/PayrollRun");
const Payroll = require("../models/Payroll");
const { parsePagination, paginationMeta } = require("../utils/pagination");
const { runInPrismaTransaction } = require("../services/transactionService");
const { recordPayrollAudit, runSnapshot } = require("../services/payrollAuditService");
const { dbClient } = require("../lib/prisma");

// @desc    Get available periods (months with finalised, unprocessed payroll records)
// @route   GET /api/payroll-runs/available-periods
// @access  Private
const getAvailablePeriods = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const periods = await PayrollRunService.getAvailablePeriods(companyId);
    res.status(200).json({
      success: true,
      data: periods,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all payroll runs for company
// @route   GET /api/payroll-runs
// @access  Private
const getPayrollRuns = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { status, startDate, endDate } = req.query;

    const filter = { company: companyId };
    if (status) filter.status = status;
    if (startDate || endDate) {
      filter.payment_date = {};
      if (startDate) filter.payment_date.$gte = new Date(startDate);
      if (endDate) filter.payment_date.$lte = new Date(endDate);
    }

    const { page, limit, skip } = parsePagination(req.query);
    const total = await PayrollRun.countDocuments(filter);
    const payrollRuns = await PayrollRun.find(filter)
      .populate("bank_account_id", "name accountCode")
      .populate("salary_account_id", "name code")
      .populate("tax_payable_account_id", "name code")
      .populate("posted_by", "name")
      .sort({ payment_date: -1 })
      .skip(skip)
      .limit(limit);

    res.status(200).json({
      success: true,
      count: payrollRuns.length,
      data: payrollRuns,
      pagination: paginationMeta(page, limit, total),
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single payroll run
// @route   GET /api/payroll-runs/:id
// @access  Private
const getPayrollRunById = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;

    const payrollRun = await PayrollRun.findOne({
      _id: id,
      company: companyId,
    })
      .populate("bank_account_id", "name accountCode")
      .populate("salary_account_id", "name code")
      .populate("tax_payable_account_id", "name code")
      .populate("other_deductions_account_id", "name code")
      .populate("posted_by", "name");

    if (!payrollRun) {
      return res.status(404).json({
        success: false,
        message: "Payroll run not found",
      });
    }

    res.status(200).json({
      success: true,
      data: payrollRun,
    });
  } catch (error) {
    next(error);
  }
};

const getPayrollRunAuditHistory = async (req, res, next) => {
  try {
    const companyId = String(req.user.company._id);
    const events = await dbClient().payrollAuditEvent.findMany({
      where: { companyId, entityType: "payroll_run", entityId: String(req.params.id) },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return res.json({ success: true, data: events });
  } catch (error) { return next(error); }
};

// @desc    Create new payroll run (draft)
// @route   POST /api/payroll-runs
// @access  Private (admin, manager)
const createPayrollRun = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;

    const payrollRun = await PayrollRunService.create(
      companyId,
      req.body,
      userId,
    );

    res.status(201).json({
      success: true,
      data: payrollRun,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Post payroll run (create journal entry)
// @route   POST /api/payroll-runs/:id/post
// @access  Private (admin)
const postPayrollRun = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    const { id } = req.params;

    const payrollRun = await PayrollRunService.post(companyId, id, userId);

    res.status(200).json({
      success: true,
      data: payrollRun,
      message: "Payroll run posted successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reverse payroll run
// @route   POST /api/payroll-runs/:id/reverse
// @access  Private (admin)
const reversePayrollRun = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    const { id } = req.params;
    const { reason, reversal_date } = req.body;

    const payrollRun = await PayrollRunService.reverse(
      companyId,
      id,
      { reason, reversal_date },
      userId,
    );

    res.status(200).json({
      success: true,
      data: payrollRun,
      message: "Payroll run reversed successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete payroll run (draft only)
// @route   DELETE /api/payroll-runs/:id
// @access  Private (admin)
const deletePayrollRun = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;

    const payrollRun = await PayrollRun.findOne({
      _id: id,
      company: companyId,
    });

    if (!payrollRun) {
      return res.status(404).json({
        success: false,
        message: "Payroll run not found",
      });
    }

    if (payrollRun.status !== "draft") {
      return res.status(400).json({
        success: false,
        message: "Can only delete draft payroll runs",
      });
    }

    const before = runSnapshot(payrollRun);
    await runInPrismaTransaction(async () => {
      await Payroll.updateMany({ payroll_run_id: payrollRun._id, record_status: "finalised" }, { payroll_run_id: null });
      await payrollRun.deleteOne();
      await recordPayrollAudit({ companyId, userId: req.user._id, action: "payroll.run.deleted", entityType: "payroll_run", entityId: id, before, after: null, req });
    });

    res.status(200).json({
      success: true,
      message: "Payroll run deleted",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Preview journal entry before posting
// @route   GET /api/payroll-runs/preview
// @access  Private (admin, manager)
const previewPayrollRun = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const data = {
      pay_period_start: new Date(req.query.pay_period_start),
      pay_period_end: new Date(req.query.pay_period_end),
      salary_account_id: req.query.salary_account_id,
      tax_payable_account_id: req.query.tax_payable_account_id,
      bank_account_id: req.query.bank_account_id,
      other_deductions_account_id: req.query.other_deductions_account_id,
    };

    const preview = await PayrollRunService.preview(companyId, data);

    res.status(200).json({
      success: true,
      data: preview,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create payroll run from finalised employee records
// @route   POST /api/payroll-runs/from-records
// @access  Private (admin, manager)
const createFromRecords = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;

    const data = {
      pay_period_start: req.body.pay_period_start
        ? new Date(req.body.pay_period_start)
        : null,
      pay_period_end: req.body.pay_period_end
        ? new Date(req.body.pay_period_end)
        : null,
      payment_date: new Date(req.body.payment_date),
      // Pass explicit period selectors so the service does not have to derive
      // period.month/year from the pay_period_start date (which is timezone-fragile).
      period_month: req.body.period_month
        ? parseInt(req.body.period_month, 10)
        : undefined,
      period_year: req.body.period_year
        ? parseInt(req.body.period_year, 10)
        : undefined,
      salary_account_id: req.body.salary_account_id,
      tax_payable_account_id: req.body.tax_payable_account_id,
      bank_account_id: req.body.bank_account_id,
      other_deductions_account_id: req.body.other_deductions_account_id,
      notes: req.body.notes,
    };

    const payrollRun = await PayrollRunService.createFromRecords(
      companyId,
      data,
      userId,
    );

    res.status(201).json({
      success: true,
      data: payrollRun,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Mark PAYE as remitted (Rwanda RRA compliance)
// @route   POST /api/payroll-runs/:id/remit-paye
// @access  Private (admin)
const remitPaye = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    const payrollRun = await PayrollRunService.remitPaye(companyId, req.params.id, req.body, userId);
    res.status(200).json({
      success: true,
      data: payrollRun,
      message: "PAYE remitted successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Mark RSSB contributions as remitted (Rwanda RRA compliance)
// @route   POST /api/payroll-runs/:id/remit-rssb
// @access  Private (admin)
const remitRssb = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    const payrollRun = await PayrollRunService.remitRssb(companyId, req.params.id, req.body, userId);
    res.status(200).json({
      success: true,
      data: payrollRun,
      message: "RSSB contributions remitted successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Generate bank transfer data (CSV/Excel/XML for bank upload)
// @route   GET /api/payroll-runs/:id/bank-transfer
// @access  Private (admin, manager)
const generateBankTransfer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const data = await PayrollRunService.generateBankTransferData(companyId, req.params.id);
    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

const confirmBankTransfer = async (req, res, next) => {
  try {
    const data = await PayrollRunService.confirmBankTransfer(
      req.user.company._id, req.params.id, req.body, req.user._id,
    );
    res.status(200).json({ success: true, data, message: "Salary bank payment confirmation recorded" });
  } catch (error) { next(error); }
};

const exportStatutoryFiling = async (req, res, next) => {
  try {
    const filing = await PayrollRunService.generateStatutoryFilingCsv(req.user.company._id, req.params.id, req.params.type);
    res.status(200).json({ success: true, data: filing });
  } catch (error) { next(error); }
};

const submitStatutoryFiling = async (req, res, next) => {
  try {
    const data = await PayrollRunService.submitStatutoryFiling(req.user.company._id, req.params.id, req.params.type, req.body, req.user._id);
    res.status(200).json({ success: true, data, message: `${String(req.params.type).toUpperCase()} filing evidence recorded` });
  } catch (error) { next(error); }
};

const getComplianceDeadlines = async (req, res, next) => {
  try {
    const data = await PayrollRunService.getComplianceDeadlines(req.user.company._id, req.query);
    res.status(200).json({ success: true, count: data.length, data });
  } catch (error) { next(error); }
};

module.exports = {
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
};
