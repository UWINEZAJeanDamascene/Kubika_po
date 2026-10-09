const BudgetService = require("../services/budgetService");

function validateApprovalSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return "At least one approval step is required";
  const approverTypes = new Set(["user", "specific_user", "role", "any_manager", "department_head"]);
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const approverType = String(step.approver_type || "").toLowerCase();
    const required = Number(step.required_approvals ?? 1);
    if (!step.step_name || !approverTypes.has(approverType)) return `Step ${i + 1} has an invalid approver type or is missing a name`;
    if (!Number.isInteger(required) || required < 1) return `Step ${i + 1} must require at least one approval`;
    if (["user", "specific_user"].includes(approverType) && required > 1) return `Step ${i + 1} has one named approver, so it cannot require multiple approvals`;
    if (["user", "specific_user"].includes(approverType) && !step.approver_id) return `Step ${i + 1} must select an approver`;
    if (approverType === "role" && !step.approver_role) return `Step ${i + 1} must select an approver role`;
    step.approver_type = approverType;
    step.required_approvals = required;
    step.step_number = i + 1;
  }
  return null;
}

// ── CREATE ─────────────────────────────────────────────────────────────
exports.createBudget = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { name, fiscal_year } = req.body;

    if (!name || !fiscal_year) {
      return res
        .status(400)
        .json({ error: "name and fiscal_year are required" });
    }

    const budget = await BudgetService.create(companyId, req.body, userId);
    res.status(201).json({ success: true, data: budget });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: "BUDGET_DUPLICATE" });
    }
    res.status(400).json({ error: error.message });
  }
};

// ── LIST ───────────────────────────────────────────────────────────────
exports.getBudgets = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const {
      status,
      fiscal_year,
      type,
      department,
      search,
      page,
      limit,
      startDate,
      endDate,
    } = req.query;

    const result = await BudgetService.findAll(companyId, {
      status,
      fiscal_year,
      type,
      department,
      search,
      page,
      limit,
      startDate,
      endDate,
    });
    res.json({
      success: true,
      data: result.data,
      pagination: result.pagination,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ── GET BY ID ──────────────────────────────────────────────────────────
exports.getBudgetById = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;

    const budget = await BudgetService.findById(companyId, id);
    res.json({ success: true, data: budget });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Budget not found" });
    }
    res.status(400).json({ error: error.message });
  }
};

// ── UPDATE ─────────────────────────────────────────────────────────────
exports.updateBudget = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;

    const budget = await BudgetService.update(companyId, id, req.body, userId);
    res.json({ success: true, data: budget });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Budget not found" });
    }
    if (error.message === "BUDGET_NOT_DRAFT") return res.status(409).json({ error: "Only draft budgets can be edited" });
    res.status(400).json({ error: error.message });
  }
};

// ── DELETE ─────────────────────────────────────────────────────────────
exports.deleteBudget = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;

    await BudgetService.delete(companyId, id);
    res.json({ success: true, message: "Budget deleted successfully" });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Budget not found" });
    }
    if (error.message === "BUDGET_NOT_DRAFT") {
      return res.status(400).json({ error: "Can only delete draft budgets" });
    }
    res.status(400).json({ error: error.message });
  }
};

// ── UPSERT LINES ──────────────────────────────────────────────────────
exports.upsertLines = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;
    const { lines, replace_existing: replaceExisting = false } = req.body;

    if (!Array.isArray(lines) || (lines.length === 0 && !replaceExisting)) {
      return res.status(400).json({ error: "lines array is required" });
    }

    const result = await BudgetService.upsertLines(
      companyId,
      id,
      lines,
      userId,
      { replaceExisting },
    );
    res.json({ success: true, data: result });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Budget not found" });
    }
    if (error.message === "BUDGET_LOCKED") {
      return res.status(400).json({ error: "Budget is locked or closed" });
    }
    if (error.message === "BUDGET_NOT_DRAFT") return res.status(409).json({ error: "Only draft budgets can be edited" });
    if (error.message === "ACCOUNT_NOT_FOUND") {
      return res
        .status(400)
        .json({ error: "Account not found or belongs to different company" });
    }
    if (error.message === "PROJECT_NOT_FOUND") {
      return res
        .status(400)
        .json({ error: "Project not found or belongs to different company" });
    }
    res.status(400).json({ error: error.message });
  }
};

// ── GET LINES ──────────────────────────────────────────────────────────
exports.getLines = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { period_year, period_month } = req.query;

    const lines = await BudgetService.getLines(companyId, id, {
      period_year,
      period_month,
    });
    res.json({ success: true, data: lines });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ── APPROVE ────────────────────────────────────────────────────────────
exports.approveBudget = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;

    const budget = await BudgetService.approve(companyId, id, userId);
    res.json({
      success: true,
      data: budget,
      message: "Budget approved successfully",
    });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Budget not found" });
    }
    if (error.message === "APPROVAL_REQUIRED") return res.status(409).json({ error: "Submit this draft through the approval workflow before it can be approved" });
    if (error.message === "BUDGET_NOT_PENDING_APPROVAL") return res.status(409).json({ error: "Budget is not awaiting approval" });
    if (error.message === "APPROVER_NOT_AUTHORIZED") return res.status(403).json({ error: "You are not authorized for the current workflow step" });
    if (error.message === "BUDGET_SELF_APPROVAL_NOT_ALLOWED") return res.status(403).json({ error: "The requester cannot approve their own budget" });
    res.status(400).json({ error: error.message });
  }
};

// ── REJECT ─────────────────────────────────────────────────────────────
exports.rejectBudget = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;
    const { reason } = req.body || {};

    const budget = await BudgetService.reject(
      companyId,
      id,
      userId,
      reason || "",
    );
    res.json({ success: true, data: budget, message: "Budget rejected" });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Budget not found" });
    }
    if (error.message === "BUDGET_CANNOT_REJECT") {
      return res
        .status(400)
        .json({ error: "Budget cannot be rejected in its current status" });
    }
    res.status(400).json({ error: error.message });
  }
};

// ── LOCK ───────────────────────────────────────────────────────────────
exports.lockBudget = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;

    const budget = await BudgetService.lock(companyId, id, userId);
    res.json({
      success: true,
      data: budget,
      message: "Budget locked successfully",
    });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Budget not found" });
    }
    if (error.message === "BUDGET_NOT_APPROVED") {
      return res.status(400).json({ error: "Can only lock approved budgets" });
    }
    res.status(400).json({ error: error.message });
  }
};

// ── UNLOCK ────────────────────────────────────────────────────────────
exports.unlockBudget = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;

    const budget = await BudgetService.unlock(companyId, id, userId);
    res.json({
      success: true,
      data: budget,
      message: "Budget unlocked successfully",
    });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Budget not found" });
    }
    if (error.message === "BUDGET_NOT_LOCKED") {
      return res.status(400).json({ error: "Can only unlock locked budgets" });
    }
    res.status(400).json({ error: error.message });
  }
};

// ── CLOSE ──────────────────────────────────────────────────────────────
exports.closeBudget = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;
    const { notes } = req.body || {};

    const budget = await BudgetService.close(
      companyId,
      id,
      userId,
      notes || "",
    );
    res.json({
      success: true,
      data: budget,
      message: "Budget closed successfully",
    });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Budget not found" });
    }
    if (error.message === "BUDGET_ALREADY_CLOSED") {
      return res.status(400).json({ error: "Budget is already closed" });
    }
    if (error.message === "BUDGET_NOT_APPROVED") {
      return res.status(400).json({ error: "Cannot close a draft budget" });
    }
    res.status(400).json({ error: error.message });
  }
};

// ── CLONE ──────────────────────────────────────────────────────────────
exports.cloneBudget = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;
    const { newPeriodStart, newPeriodEnd, newName } = req.body;

    if (!newPeriodStart || !newPeriodEnd) {
      return res
        .status(400)
        .json({ error: "newPeriodStart and newPeriodEnd are required" });
    }

    const budget = await BudgetService.clone(companyId, id, userId, {
      newPeriodStart,
      newPeriodEnd,
      newName,
    });
    res
      .status(201)
      .json({
        success: true,
        data: budget,
        message: "Budget cloned successfully",
      });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Source budget not found" });
    }
    res.status(400).json({ error: error.message });
  }
};

// ── SUMMARY ────────────────────────────────────────────────────────────
exports.getSummary = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const summary = await BudgetService.getSummary(companyId);
    res.json({ success: true, data: summary });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ── COMPARE ALL ────────────────────────────────────────────────────────
exports.getAllComparisons = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { status, type, periodStart, periodEnd } = req.query;

    const result = await BudgetService.getAllComparisons(companyId, {
      status,
      type,
      periodStart,
      periodEnd,
    });
    res.json({ success: true, data: result.data, summary: result.summary });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ── COMPARE SINGLE ────────────────────────────────────────────────────
exports.getComparison = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;

    const comparison = await BudgetService.getComparison(companyId, id);
    res.json({ success: true, data: comparison });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Budget not found" });
    }
    res.status(400).json({ error: error.message });
  }
};

// ── VARIANCE REPORT ────────────────────────────────────────────────────
exports.getVarianceReport = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { periodStart, periodEnd } = req.query;

    if (!periodStart || !periodEnd) {
      return res
        .status(400)
        .json({ error: "periodStart and periodEnd are required" });
    }

    const report = await BudgetService.getVarianceReport(companyId, id, {
      periodStart,
      periodEnd,
    });
    res.json({ success: true, data: report });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Budget not found" });
    }
    res.status(400).json({ error: error.message });
  }
};

// ── FORECASTS ──────────────────────────────────────────────────────────
exports.getRevenueForecast = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const months = Math.min(36, Math.max(1, parseInt(req.query.months) || 6));

    const forecast = await BudgetService.getRevenueForecast(companyId, months);
    res.json({ success: true, data: forecast });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getExpenseForecast = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const months = Math.min(36, Math.max(1, parseInt(req.query.months) || 6));

    const forecast = await BudgetService.getExpenseForecast(companyId, months);
    res.json({ success: true, data: forecast });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getCashFlowForecast = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const months = Math.min(36, Math.max(1, parseInt(req.query.months) || 6));

    const forecast = await BudgetService.getCashFlowForecast(companyId, months);
    res.json({ success: true, data: forecast });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ── BUDGET TRANSFERS ───────────────────────────────────────────────────

exports.createTransfer = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;
    const { from_line_id, to_line_id, amount, transfer_date, reason, notes } = req.body;

    if (!from_line_id || !to_line_id || !amount || !reason) {
      return res.status(400).json({
        error: "from_line_id, to_line_id, amount, and reason are required",
      });
    }

    const transfer = await BudgetService.createTransfer(companyId, id, {
      from_line_id,
      to_line_id,
      amount,
      transfer_date,
      reason,
      notes,
    }, userId);

    res.status(201).json({
      success: true,
      data: transfer,
      message: "Budget transfer request created successfully",
    });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Budget not found" });
    }
    if (error.message === "BUDGET_NOT_ACTIVE") {
      return res.status(400).json({ error: "Budget is not in an active state" });
    }
    if (error.message === "TRANSFER_INVALID_DATA") {
      return res.status(400).json({ error: "Invalid transfer data provided" });
    }
    if (error.message === "TRANSFER_SAME_LINE") {
      return res.status(400).json({ error: "Cannot transfer to the same budget line" });
    }
    if (error.message === "BUDGET_LINE_NOT_FOUND") {
      return res.status(404).json({ error: "One or both budget lines not found" });
    }
    if (["TRANSFER_INSUFFICIENT_BUDGET", "INSUFFICIENT_BUDGET"].includes(error.message)) {
      return res.status(400).json({ error: "Insufficient budget in source line" });
    }
    if (error.message === "BUDGET_PERIOD_LOCKED") return res.status(409).json({ error: "A source or destination budget period is locked for transfers" });
    if (error.message === "TRANSFER_ALREADY_PENDING") {
      return res.status(400).json({ error: "A transfer between these lines is already pending" });
    }
    res.status(400).json({ error: error.message });
  }
};

exports.getTransfers = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { status } = req.query;

    const transfers = await BudgetService.getTransfersByBudget(companyId, id, { status });
    res.json({ success: true, data: transfers });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.approveTransfer = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id, transferId } = req.params;

    const transfer = await BudgetService.approveTransfer(companyId, transferId, userId);
    res.json({
      success: true,
      data: transfer,
      message: "Budget transfer approved successfully",
    });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Transfer not found" });
    }
    if (error.message === "TRANSFER_NOT_PENDING") {
      return res.status(400).json({ error: "Transfer is not in pending status" });
    }
    if (error.message === "TRANSFER_ALREADY_PROCESSED") return res.status(409).json({ error: "Transfer has already been processed" });
    if (error.message === "TRANSFER_SELF_APPROVAL_NOT_ALLOWED") return res.status(403).json({ error: "The transfer requester cannot approve their own transfer" });
    if (error.message === "BUDGET_PERIOD_LOCKED") return res.status(409).json({ error: "A source or destination budget period is locked for transfers" });
    if (error.message === "INSUFFICIENT_BUDGET") return res.status(409).json({ error: "The source line has insufficient uncommitted budget" });
    res.status(400).json({ error: error.message });
  }
};

exports.rejectTransfer = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id, transferId } = req.params;
    const { reason } = req.body;

    const transfer = await BudgetService.rejectTransfer(companyId, transferId, userId, reason);
    res.json({
      success: true,
      data: transfer,
      message: "Budget transfer rejected",
    });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Transfer not found" });
    }
    if (error.message === "TRANSFER_CANNOT_REJECT") {
      return res.status(400).json({ error: "Transfer cannot be rejected in its current status" });
    }
    res.status(400).json({ error: error.message });
  }
};

exports.executeTransfer = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id, transferId } = req.params;

    const result = await BudgetService.executeTransfer(companyId, transferId, userId);
    res.json({
      success: true,
      data: result,
      message: "Budget transfer executed successfully",
    });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Transfer not found" });
    }
    if (error.message === "TRANSFER_NOT_APPROVED") {
      return res.status(400).json({ error: "Transfer must be approved before execution" });
    }
    if (error.message === "BUDGET_LINE_NOT_FOUND") {
      return res.status(404).json({ error: "Budget line no longer exists" });
    }
    if (error.message === "TRANSFER_INSUFFICIENT_BUDGET") {
      return res.status(400).json({ error: "Insufficient budget available for transfer" });
    }
    res.status(400).json({ error: error.message });
  }
};

exports.cancelTransfer = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id, transferId } = req.params;
    const { reason } = req.body;

    const transfer = await BudgetService.cancelTransfer(companyId, transferId, userId, reason);
    res.json({
      success: true,
      data: transfer,
      message: "Budget transfer cancelled",
    });
  } catch (error) {
    if (error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Transfer not found" });
    }
    if (error.message === "TRANSFER_CANNOT_CANCEL") {
      return res.status(400).json({ error: "Transfer cannot be cancelled in its current status" });
    }
    res.status(400).json({ error: error.message });
  }
};

// ── ENCUMBRANCES ───────────────────────────────────────────────────────

exports.createEncumbrance = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;
    const { budget_line_id, account_id, source_type, source_id, source_number, description, amount, expected_liquidation_date, notes } = req.body;

    if (!budget_line_id || !account_id || !source_type || !source_id || !amount || !description) {
      return res.status(400).json({ error: "budget_line_id, account_id, source_type, source_id, amount, and description are required" });
    }

    const encumbrance = await BudgetService.createEncumbrance(companyId, {
      budget_id: id,
      budget_line_id,
      account_id,
      source_type,
      source_id,
      source_number,
      description,
      amount,
      expected_liquidation_date,
      notes,
    }, userId);

    res.status(201).json({ success: true, data: encumbrance, message: "Encumbrance created successfully" });
  } catch (error) {
    if (error.message === "BUDGET_NOT_FOUND") {
      return res.status(404).json({ error: "Budget not found" });
    }
    if (error.message === "BUDGET_NOT_ACTIVE") {
      return res.status(400).json({ error: "Budget is not in an active state" });
    }
    if (error.message === "BUDGET_LINE_NOT_FOUND") {
      return res.status(404).json({ error: "No budget line found for this account" });
    }
    if (error.message === "INSUFFICIENT_BUDGET") {
      return res.status(400).json({ error: "Insufficient available budget for this encumbrance" });
    }
    if (error.message === "ENCUMBRANCE_ALREADY_EXISTS") {
      return res.status(400).json({ error: "An encumbrance already exists for this source document" });
    }
    res.status(400).json({ error: error.message });
  }
};

exports.getEncumbrances = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { status, account_id, budget_line_id } = req.query;

    const encumbrances = await BudgetService.getEncumbrances(companyId, id, {
      status,
      account_id,
      budget_line_id,
    });
    res.json({ success: true, data: encumbrances });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getActualConsumptions = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { account_id, budget_line_id } = req.query;

    const consumptions = await BudgetService.getActualConsumptions(companyId, id, {
      account_id,
      budget_line_id,
    });
    res.json({ success: true, data: consumptions });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getEncumbranceSummary = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;

    const summary = await BudgetService.getEncumbranceSummary(companyId, id);
    res.json({ success: true, data: summary });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.liquidateEncumbrance = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { sourceType, sourceId } = req.params;
    const { document_type, document_id, document_number, amount, date, notes } = req.body;

    if (!document_type || !document_id || !amount) {
      return res.status(400).json({ error: "document_type, document_id, and amount are required" });
    }

    const encumbrance = await BudgetService.liquidateEncumbrance(companyId, sourceType, sourceId, {
      document_type,
      document_id,
      document_number,
      amount,
      date,
      notes,
    }, userId);

    res.json({ success: true, data: encumbrance, message: "Encumbrance liquidated successfully" });
  } catch (error) {
    if (error.message === "ENCUMBRANCE_NOT_FOUND") {
      return res.status(404).json({ error: "Encumbrance not found" });
    }
    if (error.message === "LIQUIDATION_EXCEEDS_ENCUMBRANCE") {
      return res.status(400).json({ error: "Liquidation amount exceeds remaining encumbrance" });
    }
    res.status(400).json({ error: error.message });
  }
};

exports.releaseEncumbrance = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { sourceType, sourceId } = req.params;
    const { reason } = req.body;

    const encumbrance = await BudgetService.releaseEncumbrance(companyId, sourceType, sourceId, reason, userId);

    res.json({ success: true, data: encumbrance, message: "Encumbrance released successfully" });
  } catch (error) {
    if (error.message === "ENCUMBRANCE_NOT_FOUND") {
      return res.status(404).json({ error: "Encumbrance not found" });
    }
    if (error.message === "NO_REMAINING_ENCUMBRANCE") {
      return res.status(400).json({ error: "No remaining encumbrance to release" });
    }
    res.status(400).json({ error: error.message });
  }
};

exports.adjustEncumbrance = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { encumbranceId } = req.params;
    const { new_amount, reason } = req.body;

    if (!new_amount || !reason) {
      return res.status(400).json({ error: "new_amount and reason are required" });
    }

    const encumbrance = await BudgetService.adjustEncumbrance(companyId, encumbranceId, new_amount, reason, userId);

    res.json({ success: true, data: encumbrance, message: "Encumbrance adjusted successfully" });
  } catch (error) {
    if (error.message === "ENCUMBRANCE_NOT_FOUND") {
      return res.status(404).json({ error: "Encumbrance not found" });
    }
    if (error.message === "ENCUMBRANCE_CANNOT_ADJUST") {
      return res.status(400).json({ error: "Cannot adjust encumbrance in current status" });
    }
    if (error.message === "NEW_AMOUNT_BELOW_LIQUIDATED") {
      return res.status(400).json({ error: "New amount cannot be below already liquidated amount" });
    }
    if (error.message === "INSUFFICIENT_BUDGET_FOR_ADJUSTMENT") {
      return res.status(400).json({ error: "Insufficient budget for this adjustment" });
    }
    res.status(400).json({ error: error.message });
  }
};

// ── MULTI-LEVEL APPROVALS ─────────────────────────────────────────────

exports.submitForApproval = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;
    const { workflow_type, related_document_type, related_document_id, workflow_name, custom_steps, comments, priority, due_date } = req.body;

    const approval = await BudgetService.submitForApproval(companyId, {
      budget_id: id,
      workflow_type,
      related_document_type,
      related_document_id,
      workflow_name,
      custom_steps,
      comments,
      priority,
      due_date,
    }, userId);

    res.status(201).json({ success: true, data: approval, message: "Submitted for approval successfully" });
  } catch (error) {
    if (error.message === "BUDGET_NOT_FOUND") {
      return res.status(404).json({ error: "Budget not found" });
    }
    if (error.message === "APPROVAL_ALREADY_PENDING" || error.message === "ALREADY_PENDING_APPROVAL") {
      return res.status(400).json({ error: "An approval is already pending for this item" });
    }
    if (error.message === "BUDGET_NOT_DRAFT") return res.status(409).json({ error: "Only draft budgets can be submitted" });
    if (error.message === "BUDGET_LINES_REQUIRED") return res.status(400).json({ error: "Add at least one budget line before submitting" });
    if (error.message === "APPROVER_NOT_AUTHORIZED") {
      return res.status(403).json({ error: "You are not authorized to approve the current workflow step" });
    }
    if (error.message === "BUDGET_SELF_APPROVAL_NOT_ALLOWED") return res.status(403).json({ error: "The requester cannot approve their own budget" });
    res.status(400).json({ error: error.message });
  }
};

exports.approveStep = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id, approvalId } = req.params;
    const { comments } = req.body;

    const approval = await BudgetService.approveStep(companyId, approvalId, userId, comments);

    res.json({ success: true, data: approval, message: "Approved successfully" });
  } catch (error) {
    if (error.message === "APPROVAL_NOT_FOUND") {
      return res.status(404).json({ error: "Approval not found" });
    }
    if (error.message === "APPROVAL_NOT_ACTIVE") {
      return res.status(400).json({ error: "Approval is not in an active state" });
    }
    if (error.message === "APPROVER_NOT_AUTHORIZED") {
      return res.status(403).json({ error: "You are not authorized to approve the current workflow step" });
    }
    if (error.message === "APPROVAL_STEP_NOT_FOUND") {
      return res.status(400).json({ error: "Current approval step was not found" });
    }
    if (error.message === "ALREADY_APPROVED") {
      return res.status(400).json({ error: "You have already approved this step" });
    }
    if (error.message === "BUDGET_SELF_APPROVAL_NOT_ALLOWED") return res.status(403).json({ error: "The requester cannot approve their own budget" });
    res.status(400).json({ error: error.message });
  }
};

exports.rejectApproval = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id, approvalId } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: "Rejection reason is required" });
    }

    const approval = await BudgetService.rejectApproval(companyId, approvalId, userId, reason);

    res.json({ success: true, data: approval, message: "Approval rejected" });
  } catch (error) {
    if (error.message === "APPROVAL_NOT_FOUND") {
      return res.status(404).json({ error: "Approval not found" });
    }
    if (error.message === "APPROVAL_NOT_ACTIVE") {
      return res.status(400).json({ error: "Approval is not in an active state" });
    }
    if (["APPROVER_NOT_AUTHORIZED", "BUDGET_SELF_APPROVAL_NOT_ALLOWED"].includes(error.message)) return res.status(403).json({ error: "You are not authorized to reject this workflow step" });
    if (error.message === "APPROVAL_ACTION_NOT_ALLOWED") return res.status(403).json({ error: "Rejection is not allowed at this approval step" });
    res.status(400).json({ error: error.message });
  }
};

exports.requestChanges = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id, approvalId } = req.params;
    const { changes_required } = req.body;

    if (!changes_required) {
      return res.status(400).json({ error: "Changes required description is needed" });
    }

    const approval = await BudgetService.requestChanges(companyId, approvalId, userId, changes_required);

    res.json({ success: true, data: approval, message: "Changes requested" });
  } catch (error) {
    if (error.message === "APPROVAL_NOT_FOUND") {
      return res.status(404).json({ error: "Approval not found" });
    }
    if (error.message === "APPROVAL_NOT_ACTIVE") {
      return res.status(400).json({ error: "Approval is not in an active state" });
    }
    if (["APPROVER_NOT_AUTHORIZED", "BUDGET_SELF_APPROVAL_NOT_ALLOWED"].includes(error.message)) return res.status(403).json({ error: "You are not authorized to request changes at this step" });
    if (error.message === "APPROVAL_ACTION_NOT_ALLOWED") return res.status(403).json({ error: "Changes cannot be requested at this approval step" });
    res.status(400).json({ error: error.message });
  }
};

exports.resubmitApproval = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id, approvalId } = req.params;
    const { comments } = req.body;

    const approval = await BudgetService.resubmitApproval(companyId, approvalId, userId, comments);

    res.json({ success: true, data: approval, message: "Resubmitted for approval" });
  } catch (error) {
    if (error.message === "APPROVAL_NOT_FOUND") {
      return res.status(404).json({ error: "Approval not found" });
    }
    if (error.message === "NO_CHANGES_REQUESTED") {
      return res.status(400).json({ error: "No changes were requested for this approval" });
    }
    res.status(400).json({ error: error.message });
  }
};

exports.cancelApproval = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id, approvalId } = req.params;
    const { reason } = req.body;

    const approval = await BudgetService.cancelApproval(companyId, approvalId, userId, reason);

    res.json({ success: true, data: approval, message: "Approval cancelled" });
  } catch (error) {
    if (error.message === "APPROVAL_NOT_FOUND") {
      return res.status(404).json({ error: "Approval not found" });
    }
    if (error.message === "CANNOT_CANCEL") {
      return res.status(400).json({ error: "Cannot cancel approval in current state" });
    }
    res.status(400).json({ error: error.message });
  }
};

exports.getApprovalHistory = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;

    const approvals = await BudgetService.getApprovalHistory(companyId, id);
    res.json({ success: true, data: approvals });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getApproval = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id, approvalId } = req.params;

    const approval = await BudgetService.getApproval(companyId, approvalId);
    res.json({ success: true, data: approval });
  } catch (error) {
    if (error.message === "APPROVAL_NOT_FOUND") {
      return res.status(404).json({ error: "Approval not found" });
    }
    res.status(400).json({ error: error.message });
  }
};

exports.getMyPendingApprovals = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const userRole = req.user?.role || req.role;

    const approvals = await BudgetService.getPendingApprovals(companyId, userId, userRole);
    res.json({ success: true, data: approvals, count: approvals.length });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ── VARIANCE ALERTS ───────────────────────────────────────────────────

exports.getAlertConfiguration = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;

    const config = await BudgetService.getAlertConfiguration(companyId, id === "default" ? null : id);
    res.json({ success: true, data: config });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.updateAlertConfiguration = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;
    const data = req.body;

    const config = await BudgetService.updateAlertConfiguration(
      companyId,
      id === "default" ? null : id,
      data,
      userId
    );
    res.json({ success: true, data: config, message: "Alert configuration updated" });
  } catch (error) {
    if (error.message.includes("Warning threshold must be less than critical")) {
      return res.status(400).json({ error: "Invalid thresholds: warning < critical < exceeded required" });
    }
    res.status(400).json({ error: error.message });
  }
};

exports.checkVariance = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;

    const result = await BudgetService.checkVarianceAndAlert(companyId, id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getBudgetsNeedingAttention = async (req, res) => {
  try {
    const companyId = req.user.company._id;

    const budgets = await BudgetService.getBudgetsNeedingAttention(companyId);
    res.json({ success: true, data: budgets, count: budgets.length });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.runVarianceChecks = async (req, res) => {
  try {
    const companyId = req.user.company._id;

    const results = await BudgetService.runVarianceChecks(companyId);
    res.json({ success: true, data: results, message: `Checked ${results.checked} budgets, ${results.alerted} alerted` });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ── BUDGET PERIOD LOCKING ─────────────────────────────────────────────

exports.getPeriodLocks = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { year } = req.query;

    const locks = await BudgetService.getPeriodLocks(companyId, id);
    const periods = await BudgetService.getLockedPeriods(companyId, id, { year: year ? parseInt(year) : undefined });

    res.json({
      success: true,
      data: {
        settings: {
          auto_lock: locks.auto_lock,
          fiscal_year_end: locks.fiscal_year_end,
          year_end_lock: locks.year_end_lock,
        },
        locked_periods: periods,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.lockPeriod = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;
    const { year, month, reason, allow_transfers, allow_encumbrances } = req.body;

    if (!year || !month) {
      return res.status(400).json({ error: "Year and month are required" });
    }

    const locks = await BudgetService.lockPeriod(companyId, id, year, month, {
      reason,
      allow_transfers,
      allow_encumbrances,
    }, userId);

    res.json({ success: true, data: locks, message: `Period ${year}-${month} locked successfully` });
  } catch (error) {
    if (error.message === "BUDGET_NOT_FOUND") {
      return res.status(404).json({ error: "Budget not found" });
    }
    if (error.message === "PERIOD_ALREADY_LOCKED") {
      return res.status(400).json({ error: "Period is already locked" });
    }
    res.status(400).json({ error: error.message });
  }
};

exports.unlockPeriod = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;
    const { year, month } = req.body;

    if (!year || !month) {
      return res.status(400).json({ error: "Year and month are required" });
    }

    const locks = await BudgetService.unlockPeriod(companyId, id, year, month, userId);

    res.json({ success: true, data: locks, message: `Period ${year}-${month} unlocked successfully` });
  } catch (error) {
    if (error.message === "NO_LOCKS_FOUND") {
      return res.status(404).json({ error: "No locks found for this budget" });
    }
    if (error.message === "PERIOD_NOT_LOCKED") {
      return res.status(400).json({ error: "Period is not locked" });
    }
    res.status(400).json({ error: error.message });
  }
};

exports.checkPeriodLock = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { year, month } = req.query;

    if (!year || !month) {
      return res.status(400).json({ error: "Year and month are required" });
    }

    const isLocked = await BudgetService.isPeriodLocked(companyId, id, parseInt(year), parseInt(month));

    res.json({ success: true, data: { is_locked: isLocked } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.updateLockSettings = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;
    const { auto_lock, fiscal_year_end, year_end_lock } = req.body;

    const locks = await BudgetService.updateAutoLockSettings(companyId, id, {
      auto_lock,
      fiscal_year_end,
      year_end_lock,
    }, userId);

    res.json({ success: true, data: locks, message: "Lock settings updated successfully" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.runAutoLock = async (req, res) => {
  try {
    const companyId = req.user.company._id;

    const results = await BudgetService.runAutoLock(companyId);
    res.json({
      success: true,
      data: results,
      message: `Auto-lock processed ${results.processed} budgets, locked ${results.locked} periods`,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ── REVISION TRACKING ─────────────────────────────────────────────────

exports.getRevisionHistory = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { change_type, startDate, endDate, limit } = req.query;

    const revisions = await BudgetService.getRevisionHistory(companyId, id, {
      change_type,
      startDate,
      endDate,
      limit: limit ? parseInt(limit) : 100,
    });

    res.json({ success: true, data: revisions, count: revisions.length });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getRevision = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id, revisionNumber } = req.params;

    const revision = await BudgetService.getRevision(companyId, id, parseInt(revisionNumber));
    res.json({ success: true, data: revision });
  } catch (error) {
    if (error.message === "REVISION_NOT_FOUND") {
      return res.status(404).json({ error: "Revision not found" });
    }
    res.status(400).json({ error: error.message });
  }
};

exports.compareRevisions = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { rev1, rev2 } = req.query;

    if (!rev1 || !rev2) {
      return res.status(400).json({ error: "Two revision numbers required (rev1 and rev2)" });
    }

    const comparison = await BudgetService.compareRevisions(companyId, id, parseInt(rev1), parseInt(rev2));
    res.json({ success: true, data: comparison });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.rollbackToRevision = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;
    const { revisionNumber, reason } = req.body;

    if (!revisionNumber) {
      return res.status(400).json({ error: "Revision number is required" });
    }

    if (!reason) {
      return res.status(400).json({ error: "Rollback reason is required" });
    }

    const result = await BudgetService.rollbackToRevision(companyId, id, revisionNumber, userId, reason);
    res.json({ success: true, data: result, message: `Rolled back to revision ${revisionNumber}` });
  } catch (error) {
    if (error.message === "REVISION_NOT_FOUND") {
      return res.status(404).json({ error: "Revision not found" });
    }
    if (error.message === "CANNOT_ROLLBACK_NO_SNAPSHOT") {
      return res.status(400).json({ error: "Cannot rollback - no snapshot available for this revision" });
    }
    res.status(400).json({ error: error.message });
  }
};

exports.getRevisionStats = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;

    const stats = await BudgetService.getRevisionStats(companyId, id);
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ── WORKFLOW CONFIGURATION ─────────────────────────────────────────────

exports.getWorkflowConfigs = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const BudgetWorkflowConfig = require("../models/BudgetWorkflowConfig");

    const { workflow_type, is_active, is_default } = req.query;

    const query = { company_id: companyId };
    if (workflow_type) query.workflow_type = workflow_type;
    if (is_active !== undefined) query.is_active = is_active === "true";
    if (is_default !== undefined) query.is_default = is_default === "true";

    const configs = await BudgetWorkflowConfig.find(query)
      .sort({ priority: -1, createdAt: -1 });

    res.json({ success: true, data: configs });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getWorkflowConfigById = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const BudgetWorkflowConfig = require("../models/BudgetWorkflowConfig");
    const { configId } = req.params;

    const config = await BudgetWorkflowConfig.findOne({
      _id: configId,
      company_id: companyId,
    });

    if (!config) {
      return res.status(404).json({ error: "Workflow configuration not found" });
    }

    res.json({ success: true, data: config });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.createWorkflowConfig = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const BudgetWorkflowConfig = require("../models/BudgetWorkflowConfig");

    const {
      name,
      description,
      workflow_type,
      min_amount,
      max_amount,
      department_scope,
      department_ids,
      steps,
      is_default,
      priority,
      settings,
    } = req.body;

    if (!name || !workflow_type || !steps || steps.length === 0) {
      return res.status(400).json({
        error: "name, workflow_type, and at least one step are required",
      });
    }

    const stepError = validateApprovalSteps(steps);
    if (stepError) return res.status(400).json({ error: stepError });

    // If setting as default, unset any existing default for this type
    if (is_default) {
      await BudgetWorkflowConfig.updateMany(
        { company_id: companyId, workflow_type, is_default: true },
        { $set: { is_default: false } }
      );
    }

    const config = await BudgetWorkflowConfig.create({
      company_id: companyId,
      name,
      description,
      workflow_type,
      min_amount: min_amount || 0,
      max_amount: max_amount || null,
      department_scope: department_scope || "all",
      department_ids: department_ids || [],
      steps,
      is_default: is_default || false,
      priority: priority || 0,
      settings: settings || {},
      created_by: userId,
    });

    res.status(201).json({
      success: true,
      data: config,
      message: "Workflow configuration created successfully",
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        error: "A default workflow already exists for this type",
      });
    }
    res.status(400).json({ error: error.message });
  }
};

exports.updateWorkflowConfig = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const BudgetWorkflowConfig = require("../models/BudgetWorkflowConfig");
    const { configId } = req.params;

    const {
      name,
      description,
      workflow_type,
      min_amount,
      max_amount,
      department_scope,
      department_ids,
      steps,
      is_active,
      is_default,
      priority,
      settings,
    } = req.body;

    const config = await BudgetWorkflowConfig.findOne({
      _id: configId,
      company_id: companyId,
    });

    if (!config) {
      return res.status(404).json({ error: "Workflow configuration not found" });
    }

    if (steps !== undefined) {
      const stepError = validateApprovalSteps(steps);
      if (stepError) return res.status(400).json({ error: stepError });
    }

    // Re-validate step numbers if steps provided

    // If setting as default, unset any existing default for this type
    if (is_default && !config.is_default) {
      await BudgetWorkflowConfig.updateMany(
        {
          company_id: companyId,
          workflow_type: workflow_type || config.workflow_type,
          is_default: true,
          _id: { $ne: configId },
        },
        { $set: { is_default: false } }
      );
    }

    // Update fields
    if (name !== undefined) config.name = name;
    if (description !== undefined) config.description = description;
    if (workflow_type !== undefined) config.workflow_type = workflow_type;
    if (min_amount !== undefined) config.min_amount = min_amount;
    if (max_amount !== undefined) config.max_amount = max_amount;
    if (department_scope !== undefined) config.department_scope = department_scope;
    if (department_ids !== undefined) config.department_ids = department_ids;
    if (steps !== undefined) config.steps = steps;
    if (is_active !== undefined) config.is_active = is_active;
    if (is_default !== undefined) config.is_default = is_default;
    if (priority !== undefined) config.priority = priority;
    if (settings !== undefined) config.settings = { ...config.settings, ...settings };

    config.updated_by = userId;
    await config.save();

    res.json({
      success: true,
      data: config,
      message: "Workflow configuration updated successfully",
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        error: "A default workflow already exists for this type",
      });
    }
    res.status(400).json({ error: error.message });
  }
};

exports.deleteWorkflowConfig = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const BudgetWorkflowConfig = require("../models/BudgetWorkflowConfig");
    const { configId } = req.params;

    const config = await BudgetWorkflowConfig.findOne({
      _id: configId,
      company_id: companyId,
    });

    if (!config) {
      return res.status(404).json({ error: "Workflow configuration not found" });
    }

    // Prevent deleting the last active default workflow
    if (config.is_default) {
      const otherDefault = await BudgetWorkflowConfig.findOne({
        company_id: companyId,
        workflow_type: config.workflow_type,
        is_default: true,
        _id: { $ne: configId },
        is_active: true,
      });

      if (!otherDefault) {
        return res.status(400).json({
          error: "Cannot delete the only default workflow for this type. Create another default first.",
        });
      }
    }

    await BudgetWorkflowConfig.deleteOne({ _id: configId });

    res.json({
      success: true,
      message: "Workflow configuration deleted successfully",
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.setDefaultWorkflowConfig = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const BudgetWorkflowConfig = require("../models/BudgetWorkflowConfig");
    const { configId } = req.params;

    const config = await BudgetWorkflowConfig.findOne({
      _id: configId,
      company_id: companyId,
    });

    if (!config) {
      return res.status(404).json({ error: "Workflow configuration not found" });
    }

    // Unset any existing default for this workflow type
    await BudgetWorkflowConfig.updateMany(
      {
        company_id: companyId,
        workflow_type: config.workflow_type,
        is_default: true,
        _id: { $ne: configId },
      },
      { $set: { is_default: false } }
    );

    config.is_default = true;
    config.updated_by = userId;
    await config.save();

    res.json({
      success: true,
      data: config,
      message: "Workflow set as default successfully",
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.testWorkflowMatch = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const BudgetWorkflowConfig = require("../models/BudgetWorkflowConfig");

    const { workflow_type, amount, department_id } = req.body;

    if (!workflow_type) {
      return res.status(400).json({ error: "workflow_type is required" });
    }

    const matchingWorkflow = await BudgetWorkflowConfig.findMatchingWorkflow(
      companyId,
      workflow_type,
      amount || 0,
      department_id || null
    );

    if (!matchingWorkflow) {
      return res.json({
        success: true,
        data: null,
        message: "No matching workflow found",
      });
    }

    res.json({
      success: true,
      data: {
        workflow: matchingWorkflow,
        matched_criteria: {
          workflow_type,
          amount,
          department_id,
        },
      },
      message: "Matching workflow found",
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ── IMPORT: PARSE FILE ─────────────────────────────────────────────────
exports.parseImport = async (req, res) => {
  try {
    const BudgetImportService = require("../services/budgetImportService");

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const fileType = req.file.mimetype || req.file.originalname?.split('.').pop();
    const parsedData = await BudgetImportService.parseFile(req.file.buffer, fileType);

    res.json({
      success: true,
      data: parsedData,
      message: "File parsed successfully",
    });
  } catch (error) {
    if (error.message === 'EXCEL_NO_BUDGET_SHEET') {
      return res.status(400).json({ error: "Excel file must have a 'Budget' sheet" });
    }
    res.status(400).json({ error: error.message });
  }
};

// ── IMPORT: VALIDATE ───────────────────────────────────────────────────
exports.validateImport = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const BudgetImportService = require("../services/budgetImportService");

    const { parsedData } = req.body;

    if (!parsedData) {
      return res.status(400).json({ error: "parsedData is required" });
    }

    const validation = await BudgetImportService.validateImport(companyId, parsedData);

    res.json({
      success: true,
      data: validation,
      message: validation.isValid ? "Validation passed" : "Validation found issues",
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ── IMPORT: EXECUTE ────────────────────────────────────────────────────
exports.executeImport = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const BudgetImportService = require("../services/budgetImportService");

    const { validatedData, options } = req.body;

    if (!validatedData) {
      return res.status(400).json({ error: "validatedData is required" });
    }

    const results = await BudgetImportService.executeImport(
      companyId,
      userId,
      validatedData,
      options || {}
    );

    res.json({
      success: results.errors.length === 0 || (options?.skipErrors && results.budgetsCreated + results.budgetsUpdated > 0),
      data: results,
      message: results.errors.length === 0
        ? `Import completed: ${results.budgetsCreated} budgets created, ${results.budgetsUpdated} updated, ${results.linesCreated} lines created, ${results.linesUpdated} updated`
        : `Import completed with ${results.errors.length} errors`,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ── IMPORT: DOWNLOAD TEMPLATE ────────────────────────────────────────
exports.downloadImportTemplate = async (req, res) => {
  try {
    const BudgetImportService = require("../services/budgetImportService");

    const { format = 'excel' } = req.query;

    if (!['excel', 'csv'].includes(format)) {
      return res.status(400).json({ error: "Format must be 'excel' or 'csv'" });
    }

    const templateBuffer = await BudgetImportService.generateTemplate(format);

    const contentType = format === 'excel'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv';

    const filename = format === 'excel'
      ? 'budget_import_template.xlsx'
      : 'budget_import_template.csv';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(templateBuffer);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ── SCENARIOS / WHAT-IF ANALYSIS ───────────────────────────────────────

// Create a new scenario
exports.createScenario = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;
    const { scenario_type, scenario_name, adjustments, notes } = req.body;

    if (!scenario_type) {
      return res.status(400).json({ error: "scenario_type is required" });
    }

    const validTypes = ['base', 'optimistic', 'pessimistic', 'custom'];
    if (!validTypes.includes(scenario_type)) {
      return res.status(400).json({ error: "Invalid scenario_type. Must be: base, optimistic, pessimistic, custom" });
    }

    const scenario = await BudgetService.createScenario(companyId, id, userId, {
      scenario_type,
      scenario_name,
      adjustments,
      notes
    });

    res.json({
      success: true,
      data: scenario,
      message: "Scenario created successfully",
    });
  } catch (error) {
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ error: "Budget not found" });
    }
    if (error.message === 'SCENARIO_EXISTS') {
      return res.status(400).json({ error: "A scenario of this type already exists for this budget" });
    }
    res.status(400).json({ error: error.message });
  }
};

// Get all scenarios for a budget
exports.getScenarios = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;

    const scenarios = await BudgetService.getScenarios(companyId, id);

    res.json({
      success: true,
      data: scenarios,
      count: scenarios.length,
    });
  } catch (error) {
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ error: "Budget not found" });
    }
    res.status(400).json({ error: error.message });
  }
};

// Compare scenarios
exports.compareScenarios = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { scenarioIds } = req.body;

    if (!scenarioIds || !Array.isArray(scenarioIds) || scenarioIds.length < 2) {
      return res.status(400).json({ error: "At least 2 scenarioIds are required for comparison" });
    }

    const comparison = await BudgetService.compareScenarios(companyId, scenarioIds);

    res.json({
      success: true,
      data: comparison,
    });
  } catch (error) {
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ error: "One or more scenarios not found" });
    }
    if (error.message === 'MINIMUM_2_SCENARIOS_REQUIRED') {
      return res.status(400).json({ error: "At least 2 scenarios are required for comparison" });
    }
    res.status(400).json({ error: error.message });
  }
};

// Set a scenario as primary
exports.setPrimaryScenario = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { scenarioId } = req.params;

    const scenario = await BudgetService.setPrimaryScenario(companyId, scenarioId, userId);

    res.json({
      success: true,
      data: scenario,
      message: "Scenario set as primary successfully",
    });
  } catch (error) {
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ error: "Scenario not found" });
    }
    if (error.message === 'NOT_A_SCENARIO') {
      return res.status(400).json({ error: "This budget is not part of a scenario group" });
    }
    res.status(400).json({ error: error.message });
  }
};

// Delete a scenario
exports.deleteScenario = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { scenarioId } = req.params;

    const result = await BudgetService.deleteScenario(companyId, scenarioId, userId);

    res.json({
      success: true,
      data: result,
      message: "Scenario deleted successfully",
    });
  } catch (error) {
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ error: "Scenario not found" });
    }
    if (error.message === 'NOT_A_SCENARIO') {
      return res.status(400).json({ error: "This budget is not part of a scenario group" });
    }
    if (error.message === 'CANNOT_DELETE_PRIMARY_SCENARIO') {
      return res.status(400).json({ error: "Cannot delete the primary scenario. Set another scenario as primary first." });
    }
    res.status(400).json({ error: error.message });
  }
};
