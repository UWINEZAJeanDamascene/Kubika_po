const {
  PettyCashFloat,
  PettyCashExpense,
  PettyCashReplenishment,
  PettyCashTransaction,
  PettyCashReconciliation,
} = require("../models/PettyCash");
const { BankAccount, BankTransaction } = require("../models/BankAccount");
const ChartOfAccountsService = require("../services/chartOfAccountsService");
const JournalService = require("../services/journalService");
const TaxAutomationService = require("../services/taxAutomationService");
const {
  DEFAULT_ACCOUNTS,
  CHART_OF_ACCOUNTS,
  getAccount,
  canPostToAccount,
} = require("../constants/chartOfAccounts");
const mongoose = require("mongoose");

// Helper: map petty cash category to default GL account code
function getDefaultExpenseAccount(category, subcategory = "") {
  const sub = (subcategory || "").toLowerCase().trim();
  switch (category) {
    case "office_stationery":
    case "office_supplies":
      return DEFAULT_ACCOUNTS.officeSupplies || "5610";
    case "travel_transport":
    case "transport":
      // Use Travel & Local Transport (5650) for parking, taxi, fuel, etc.
      // Use Transport & Delivery (5700) for courier, delivery, freight
      if (sub.includes("parking") || sub.includes("taxi") || sub.includes("moto") || sub.includes("fuel") || sub.includes("bus") || sub === "parking" || sub === "taxi_moto" || sub === "fuel" || sub === "bus_transport") {
        return DEFAULT_ACCOUNTS.travelAndTransport || "5650";
      }
      if (sub.includes("courier") || sub.includes("delivery") || sub.includes("freight") || sub.includes("shipping")) {
        return DEFAULT_ACCOUNTS.transport || "5700";
      }
      // Default to travel account for general transport expenses
      return DEFAULT_ACCOUNTS.travelAndTransport || "5650";
    case "meals_entertainment":
    case "meals":
    case "refreshments":
      return DEFAULT_ACCOUNTS.staffWelfareAndEntertainment || "5930";
    case "maintenance_repairs":
    case "maintenance":
      return DEFAULT_ACCOUNTS.repairsAndMaintenance || "5710";
    case "staff_welfare":
    case "medical":
      return DEFAULT_ACCOUNTS.staffWelfareAndEntertainment || "5930";
    case "marketing_sales":
      return DEFAULT_ACCOUNTS.marketing || "5850";
    case "utilities_misc":
    case "utilities":
    case "communications":
      // Check for MoMo fees by keyword or subcategory code from dropdown
      if (sub.includes("momo") || sub.includes("mobile money") || sub === "momo_fees") {
        return DEFAULT_ACCOUNTS.mobileMoneyFees || "5920";
      }
      // Check for utilities by keyword or subcategory code
      if (sub.includes("utilities") || sub.includes("airtime") || sub.includes("internet") || sub === "airtime") {
        return DEFAULT_ACCOUNTS.utilities || "5600";
      }
      return DEFAULT_ACCOUNTS.miscellaneousExpenses || "5910";
    case "miscellaneous":
    case "other":
    default:
      return DEFAULT_ACCOUNTS.miscellaneousExpenses || "5910";
  }
}

// Helper to build warnings for specific categories
function buildExpenseWarnings(float, category, amount) {
  const warnings = [];
  const limit = float?.floatAmount || 0;
  if (category === "maintenance_repairs" || category === "maintenance") {
    if (limit > 0 && amount >= limit * 0.5) {
      warnings.push(
        "This maintenance expense is large relative to the petty cash float. Consider routing through a purchase order instead."
      );
    }
  }
  return warnings;
}

// Helper to get current balance (computed from transactions)
async function getCurrentBalance(floatId) {
  const float = await PettyCashFloat.findById(floatId);
  if (!float) return 0;

  // Check if cache is valid
  if (float.cacheValid) {
    return float.cachedBalance;
  }

  // Compute from transactions
  const transactions = await PettyCashTransaction.find({ float: floatId }).sort(
    { transactionDate: 1, createdAt: 1 },
  );

  // Sum all transaction amounts (opening transaction already includes the opening balance)
  let balance = 0;
  for (const tx of transactions) {
    balance += tx.amount;
  }

  // Update cache
  float.cachedBalance = balance;
  float.cacheValid = true;
  float.cacheLastComputed = new Date();
  await float.save();

  return balance;
}

// Helper to invalidate cache
async function invalidateCache(floatId) {
  await PettyCashFloat.findByIdAndUpdate(floatId, { cacheValid: false });
}

// Helper to calculate imprest replenishment amount
// In imprest system, replenishment restores float to the fixed floatAmount
async function calculateImprestReplenishmentAmount(floatId) {
  const float = await PettyCashFloat.findById(floatId);
  if (!float) return null;

  // If not in imprest mode, return null (use regular replenishment)
  if (!float.imprestMode) {
    return null;
  }

  const currentBalance = await getCurrentBalance(floatId);

  // Calculate amount needed to restore to fixed float amount
  const replenishmentAmount = float.floatAmount - currentBalance;

  return {
    floatAmount: float.floatAmount,
    currentBalance,
    replenishmentAmount: Math.max(0, replenishmentAmount),
    isImprest: true,
  };
}

// @desc    Get all petty cash floats for a company
// @route   GET /api/petty-cash/floats
// @access  Private
exports.getFloats = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { isActive } = req.query;

    const query = { company: companyId };
    if (isActive !== undefined) {
      query.isActive = isActive === "true";
    }

    const floats = await PettyCashFloat.find(query)
      .populate("custodian", "name email")
      .sort({ createdAt: -1 });

    // Calculate current balance for each float
    const floatsWithBalance = await Promise.all(
      floats.map(async (float) => {
        // Calculate balance from transactions
        const transactions = await PettyCashTransaction.find({ float: float._id });
        const currentBalance = transactions.reduce((sum, tx) => sum + (tx.amount || 0), 0);

        return {
          ...float.toObject(),
          currentBalance,
        };
      }),
    );

    res.json({
      success: true,
      count: floatsWithBalance.length,
      data: floatsWithBalance,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single petty cash float
// @route   GET /api/petty-cash/floats/:id
// @access  Private
exports.getFloat = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const float = await PettyCashFloat.findOne({
      _id: req.params.id,
      company: companyId,
    }).populate("custodian", "name email");

    if (!float) {
      return res
        .status(404)
        .json({ success: false, message: "Petty cash float not found" });
    }

    // Calculate current balance
    const transactions = await PettyCashTransaction.find({ float: float._id });
    const currentBalance = transactions.reduce((sum, tx) => sum + (tx.amount || 0), 0);

    res.json({
      success: true,
      data: {
        ...float.toObject(),
        currentBalance,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new petty cash float
// @route   POST /api/petty-cash/floats
// @access  Private
exports.createFloat = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const pettyCashFloat = new PettyCashFloat({
      ...req.body,
      company: companyId,
      custodian: req.user._id, // Use current user as custodian
      currentBalance: req.body.openingBalance || 0,
    });

    await pettyCashFloat.save();

    // Create opening transaction
    await PettyCashTransaction.create({
      company: companyId,
      float: pettyCashFloat._id,
      type: "opening",
      amount: req.body.openingBalance || 0,
      balanceAfter: req.body.openingBalance || 0,
      description: "Opening balance set",
      createdBy: req.user._id,
    });

    // Create journal entry for opening float
    // Debit: Petty Cash (1050), Credit: Cash in Hand (1000)
    if (req.body.openingBalance > 0) {
      try {
        await JournalService.createEntry(companyId, req.user._id, {
          date: new Date(),
          description: `Petty Cash Float Opening: ${pettyCashFloat.name}`,
          sourceType: "petty_cash",
          sourceId: pettyCashFloat._id,
          sourceReference: "Float Opening",
          lines: [
            JournalService.createDebitLine(
              DEFAULT_ACCOUNTS.pettyCash,
              req.body.openingBalance,
              `Opening petty cash float: ${pettyCashFloat.name}`,
            ),
            JournalService.createCreditLine(
              DEFAULT_ACCOUNTS.cashInHand,
              req.body.openingBalance,
              `Opening petty cash float: ${pettyCashFloat.name}`,
            ),
          ],
          isAutoGenerated: true,
        });
      } catch (journalError) {
        console.error(
          "Failed to create journal entry for petty cash float:",
          journalError,
        );
        // Don't fail the request if journal entry fails
      }
    }

    res.status(201).json({
      success: true,
      data: pettyCashFloat,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update petty cash float
// @route   PUT /api/petty-cash/floats/:id
// @access  Private
exports.updateFloat = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    let pettyCashFloat = await PettyCashFloat.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!pettyCashFloat) {
      return res
        .status(404)
        .json({ success: false, message: "Petty cash float not found" });
    }

    // Don't allow changing company
    const { company, ...updateData } = req.body;

    Object.assign(pettyCashFloat, updateData);
    await pettyCashFloat.save();

    res.json({
      success: true,
      data: pettyCashFloat,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete petty cash float (soft delete - deactivate)
// @route   DELETE /api/petty-cash/floats/:id
// @access  Private
exports.deleteFloat = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const pettyCashFloat = await PettyCashFloat.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!pettyCashFloat) {
      return res
        .status(404)
        .json({ success: false, message: "Petty cash float not found" });
    }

    // Soft delete - just deactivate
    pettyCashFloat.isActive = false;
    await pettyCashFloat.save();

    res.json({
      success: true,
      message: "Petty cash float deactivated",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all expenses for a float
// @route   GET /api/petty-cash/expenses
// @access  Private
exports.getExpenses = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      floatId,
      status,
      category,
      startDate,
      endDate,
      page = 1,
      limit = 50,
    } = req.query;

    const query = { company: companyId };

    if (floatId) query.float = floatId;
    if (status) query.status = status;
    if (category) query.category = category;

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const expenses = await PettyCashExpense.find(query)
      .populate("float", "name")
      .populate("approvedBy", "name email")
      .sort({ date: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await PettyCashExpense.countDocuments(query);

    res.json({
      success: true,
      count: expenses.length,
      total,
      pages: Math.ceil(total / limit),
      data: expenses,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single expense
// @route   GET /api/petty-cash/expenses/:id
// @access  Private
exports.getExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const expense = await PettyCashExpense.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate("float", "name")
      .populate("approvedBy", "name email");

    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }

    res.json({
      success: true,
      data: expense,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new expense
// @route   POST /api/petty-cash/expenses
// @access  Private
exports.createExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { float: floatId, amount } = req.body;

    // Validate the float belongs to this company
    if (floatId) {
      const float = await PettyCashFloat.findOne({
        _id: floatId,
        company: companyId,
      });
      if (!float) {
        return res
          .status(404)
          .json({ success: false, message: "Petty cash float not found" });
      }
      if (!float.isActive) {
        return res.status(400).json({
          success: false,
          message: "Cannot add expense to inactive float",
        });
      }
      // Balance check: ensure float has sufficient funds
      if (amount && amount > 0) {
        const currentBalance = await getCurrentBalance(float._id);
        if (amount > currentBalance) {
          return res.status(409).json({
            success: false,
            code: "INSUFFICIENT_PETTY_CASH",
            message: "Insufficient petty cash balance for this expense",
            currentBalance,
            requestedAmount: amount,
            shortfall: amount - currentBalance,
          });
        }
      }
    }

    const expense = new PettyCashExpense({
      ...req.body,
      company: companyId,
    });

    await expense.save();

    res.status(201).json({
      success: true,
      data: expense,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update expense
// @route   PUT /api/petty-cash/expenses/:id
// @access  Private
exports.updateExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    let expense = await PettyCashExpense.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }

    // Only allow updating pending expenses
    if (expense.status !== "pending") {
      return res
        .status(400)
        .json({ success: false, message: "Can only update pending expenses" });
    }

    const { company, ...updateData } = req.body;
    Object.assign(expense, updateData);
    await expense.save();

    res.json({
      success: true,
      data: expense,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Approve/reject expense
// @route   PUT /api/petty-cash/expenses/:id/approve
// @access  Private
exports.approveExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { status, notes } = req.body;

    let expense = await PettyCashExpense.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }

    // Guard: can only approve/reject expenses that are currently pending
    if (expense.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Cannot approve/reject expense with status '${expense.status}'. Only pending expenses can be approved or rejected.`,
      });
    }

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status. Must be approved or rejected.",
      });
    }

    expense.status = status;
    expense.approvedBy = req.user._id;
    expense.approvedAt = new Date();
    if (notes) expense.notes = notes;

    await expense.save();

    // Create transaction record
    const float = await PettyCashFloat.findById(expense.float);
    const currentBalance = await getCurrentBalance(float._id);
    const balanceAfter = currentBalance - expense.amount;

    await PettyCashTransaction.create({
      company: companyId,
      float: expense.float,
      type: "expense",
      reference: expense._id,
      referenceType: "PettyCashExpense",
      voucherNumber: expense.voucherNumber, // Link to expense voucher
      amount: -expense.amount,
      balanceAfter,
      description: `Expense: ${expense.description}`,
      expenseAccountId: expense.expenseAccountId || null,
      receiptRef: expense.receiptNumber || null,
      createdBy: req.user._id,
      notes: `Status: ${status}`,
    });

    // Create journal entry when expense is approved
    // Uses TaxAutomationService for centralized tax computation
    if (status === "approved" && expense.amount > 0) {
      try {
        const expenseCategory = expense.category || "otherExpenses";
        const expenseAccount =
          DEFAULT_ACCOUNTS[expenseCategory] || DEFAULT_ACCOUNTS.otherExpenses;
        const taxRatePct = expense.taxRatePct || 0;

        // Use TaxAutomationService for tax computation
        const expenseTax = await TaxAutomationService.computeExpenseTax(
          companyId,
          {
            expenseAccountCode: expenseAccount,
            netAmount: expense.amount,
            taxRatePct,
          },
        );

        const journalLines = [
          JournalService.createDebitLine(
            expenseAccount,
            expenseTax.netAmount,
            `Petty cash expense: ${expense.description}`,
          ),
        ];

        // Add VAT Input line if tax > 0
        if (expenseTax.taxAmount > 0) {
          journalLines.push(
            JournalService.createDebitLine(
              DEFAULT_ACCOUNTS.vatInput || "2210",
              expenseTax.taxAmount,
              "Input VAT on petty cash expense",
            ),
          );
        }

        // Credit Petty Cash for total (net + tax)
        journalLines.push(
          JournalService.createCreditLine(
            DEFAULT_ACCOUNTS.pettyCash,
            expenseTax.grossAmount,
            `Petty cash expense: ${expense.description}`,
          ),
        );

        await JournalService.createEntry(companyId, req.user._id, {
          date: expense.date || new Date(),
          description: `Petty Cash Expense: ${expense.description}`,
          sourceType: "petty_cash_expense",
          sourceId: expense._id,
          sourceReference: expense.description,
          lines: journalLines,
          isAutoGenerated: true,
        });
      } catch (journalError) {
        console.error(
          "Failed to create journal entry for petty cash expense:",
          journalError,
        );
      }
    }

    res.json({
      success: true,
      data: expense,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete expense
// @route   DELETE /api/petty-cash/expenses/:id
// @access  Private
exports.deleteExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const expense = await PettyCashExpense.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }

    // Only allow deleting pending expenses
    if (expense.status !== "pending") {
      return res
        .status(400)
        .json({ success: false, message: "Can only delete pending expenses" });
    }

    await expense.deleteOne();

    res.json({
      success: true,
      message: "Expense deleted",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all replenishment requests
// @route   GET /api/petty-cash/replenishments
// @access  Private
exports.getReplenishments = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      floatId,
      status,
      startDate,
      endDate,
      page = 1,
      limit = 50,
    } = req.query;

    const query = { company: companyId };

    if (floatId) query.float = floatId;
    if (status) query.status = status;

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const replenishments = await PettyCashReplenishment.find(query)
      .populate("float", "name")
      .populate("requestedBy", "name email")
      .populate("approvedBy", "name email")
      .populate("completedBy", "name email")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await PettyCashReplenishment.countDocuments(query);

    res.json({
      success: true,
      count: replenishments.length,
      total,
      pages: Math.ceil(total / limit),
      data: replenishments,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create replenishment request
// @route   POST /api/petty-cash/replenishments
// @access  Private
exports.createReplenishment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { float: floatId, bank_account_id, amount } = req.body;

    // Validate float belongs to this company
    if (floatId) {
      const float = await PettyCashFloat.findOne({
        _id: floatId,
        company: companyId,
      });
      if (!float) {
        return res
          .status(404)
          .json({ success: false, message: "Petty cash float not found" });
      }
    }

    // Validate bank account if provided
    if (bank_account_id) {
      const bankAcc = await BankAccount.findOne({
        _id: bank_account_id,
        company: companyId,
        isActive: true,
      });
      if (!bankAcc) {
        return res.status(404).json({
          success: false,
          message: "Bank account not found or inactive",
        });
      }
    }

    const replenishment = new PettyCashReplenishment({
      ...req.body,
      company: companyId,
      requestedBy: req.user._id,
      bank_account_id: bank_account_id || null,
    });

    await replenishment.save();

    res.status(201).json({
      success: true,
      data: replenishment,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Approve replenishment request
// @route   PUT /api/petty-cash/replenishments/:id/approve
// @access  Private
exports.approveReplenishment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { notes } = req.body;

    let replenishment = await PettyCashReplenishment.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!replenishment) {
      return res
        .status(404)
        .json({ success: false, message: "Replenishment request not found" });
    }

    if (replenishment.status !== "pending") {
      return res
        .status(400)
        .json({ success: false, message: "Can only approve pending requests" });
    }

    replenishment.status = "approved";
    replenishment.approvedBy = req.user._id;
    replenishment.approvedAt = new Date();
    if (notes) replenishment.notes = notes;

    await replenishment.save();

    res.json({
      success: true,
      data: replenishment,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Complete replenishment (cash provided)
// @route   PUT /api/petty-cash/replenishments/:id/complete
// @access  Private
exports.completeReplenishment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { actualAmount, notes } = req.body;

    let replenishment = await PettyCashReplenishment.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!replenishment) {
      return res
        .status(404)
        .json({ success: false, message: "Replenishment request not found" });
    }

    if (replenishment.status !== "approved") {
      return res.status(400).json({
        success: false,
        message: "Can only complete approved requests",
      });
    }

    replenishment.status = "completed";
    replenishment.actualAmount = actualAmount || replenishment.amount;
    replenishment.completedBy = req.user._id;
    replenishment.completedAt = new Date();
    if (notes) replenishment.notes = notes;

    await replenishment.save();

    // Get current balance before replenishment
    const float = await PettyCashFloat.findById(replenishment.float);
    const currentBalance = await getCurrentBalance(float._id);
    const replenishAmount = replenishment.actualAmount || replenishment.amount;
    const balanceAfter = currentBalance + replenishAmount;

    await PettyCashTransaction.create({
      company: companyId,
      float: replenishment.float,
      type: "replenishment",
      reference: replenishment._id,
      referenceType: "PettyCashReplenishment",
      amount: replenishment.actualAmount || replenishment.amount,
      balanceAfter,
      description: `Replenishment: ${replenishment.reason}`,
      createdBy: req.user._id,
    });

    // Create journal entry when replenishment is completed
    // DR: Petty Cash float's ledgerAccountId
    // CR: Source bank account ledgerAccountId (if known) else Cash in Hand
    if (replenishAmount > 0) {
      const floatForJournal = await PettyCashFloat.findById(
        replenishment.float,
      );
      const pettyCashAccountId =
        (floatForJournal && floatForJournal.ledgerAccountId) ||
        DEFAULT_ACCOUNTS.pettyCash;

      let creditAccountId = DEFAULT_ACCOUNTS.cashInHand;
      if (replenishment.bank_account_id) {
        const srcBank = await BankAccount.findById(
          replenishment.bank_account_id,
        );
        if (srcBank) {
          creditAccountId =
            srcBank.ledgerAccountId || DEFAULT_ACCOUNTS.cashAtBank;
        }
      }

      const narration = `Petty Cash Replenishment: ${replenishment.reason || replenishment.replenishmentNumber}`;
      try {
        await JournalService.createEntry(companyId, req.user._id, {
          date: new Date(),
          description: narration,
          sourceType: "petty_cash_replenishment",
          sourceId: replenishment._id,
          sourceReference: replenishment.replenishmentNumber || "Replenishment",
          lines: [
            JournalService.createDebitLine(
              pettyCashAccountId,
              replenishAmount,
              narration,
            ),
            JournalService.createCreditLine(
              creditAccountId,
              replenishAmount,
              narration,
            ),
          ],
          isAutoGenerated: true,
        });
        // If bank account was the source, invalidate its cached balance
        if (replenishment.bank_account_id) {
          await BankAccount.findByIdAndUpdate(replenishment.bank_account_id, {
            cacheValid: false,
          });
        }
      } catch (journalError) {
        console.error(
          "Failed to create journal entry for petty cash replenishment:",
          journalError.message,
        );
      }
    }

    res.json({
      success: true,
      data: replenishment,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reject replenishment request
// @route   PUT /api/petty-cash/replenishments/:id/reject
// @access  Private
exports.rejectReplenishment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reason } = req.body;

    let replenishment = await PettyCashReplenishment.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!replenishment) {
      return res
        .status(404)
        .json({ success: false, message: "Replenishment request not found" });
    }

    if (replenishment.status !== "pending") {
      return res
        .status(400)
        .json({ success: false, message: "Can only reject pending requests" });
    }

    replenishment.status = "rejected";
    if (reason) replenishment.notes = reason;

    await replenishment.save();

    res.json({
      success: true,
      data: replenishment,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single replenishment request
// @route   GET /api/petty-cash/replenishments/:id
// @access  Private
exports.getReplenishment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const replenishment = await PettyCashReplenishment.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate("float", "name ledgerAccountId")
      .populate("requestedBy", "name email")
      .populate("approvedBy", "name email")
      .populate("completedBy", "name email")
      .populate("bank_account_id", "name accountType ledgerAccountId");
    if (!replenishment) {
      return res
        .status(404)
        .json({ success: false, message: "Replenishment not found" });
    }
    res.json({ success: true, data: replenishment });
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel a replenishment request
// @route   PUT /api/petty-cash/replenishments/:id/cancel
// @access  Private
exports.cancelReplenishment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reason } = req.body;
    const replenishment = await PettyCashReplenishment.findOne({
      _id: req.params.id,
      company: companyId,
    });
    if (!replenishment) {
      return res
        .status(404)
        .json({ success: false, message: "Replenishment not found" });
    }
    if (!["pending", "approved"].includes(replenishment.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel a replenishment with status '${replenishment.status}'`,
      });
    }
    replenishment.status = "cancelled";
    if (reason) replenishment.notes = reason;
    await replenishment.save();
    res.json({ success: true, data: replenishment });
  } catch (error) {
    next(error);
  }
};

// @desc    Get petty cash report
// @route   GET /api/petty-cash/report
// @access  Private
exports.getReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { floatId, startDate, endDate } = req.query;

    // Build date filter
    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    // Get all floats or specific float
    const floatQuery = { company: companyId, isActive: true };
    if (floatId) floatQuery._id = floatId;

    const floats = await PettyCashFloat.find(floatQuery).populate(
      "custodian",
      "name email",
    );

    const report = await Promise.all(
      floats.map(async (float) => {
        // Get expenses for this float in the date range
        const expenseQuery = {
          float: float._id,
          status: { $in: ["approved", "reimbursed"] },
        };

        if (startDate || endDate) {
          expenseQuery.date = dateFilter;
        }

        const expenses = await PettyCashExpense.find(expenseQuery).sort({
          date: -1,
        });

        // Group expenses by category
        const expensesByCategory = {};
        let totalExpenses = 0;

        expenses.forEach((exp) => {
          const cat = exp.category || "other";
          if (!expensesByCategory[cat]) {
            expensesByCategory[cat] = {
              category: cat,
              total: 0,
              count: 0,
              items: [],
            };
          }
          expensesByCategory[cat].total += exp.amount;
          expensesByCategory[cat].count += 1;
          expensesByCategory[cat].items.push(exp);
          totalExpenses += exp.amount;
        });

        // Get replenishments
        const replQuery = {
          float: float._id,
          status: "completed",
        };

        if (startDate || endDate) {
          replQuery.completedAt = dateFilter;
        }

        const replenishments = await PettyCashReplenishment.find(replQuery);
        const totalReplenishments = replenishments.reduce(
          (sum, rep) => sum + (rep.actualAmount || rep.amount || 0),
          0,
        );

        // Calculate balance from transactions
        const allTransactions = await PettyCashTransaction.find({ float: float._id });
        const currentBalance = allTransactions.reduce((sum, tx) => sum + (tx.amount || 0), 0);

        // Get recent transactions
        const transactions = await PettyCashTransaction.find({
          float: float._id,
        })
          .populate("createdBy", "name")
          .sort({ date: -1 })
          .limit(20);

        return {
          float: {
            _id: float._id,
            name: float.name,
            openingBalance: float.openingBalance,
            custodian: float.custodian,
            location: float.location,
          },
          summary: {
            openingBalance: float.openingBalance,
            totalExpenses,
            totalReplenishments,
            currentBalance,
            expenseCount: expenses.length,
            replenishmentCount: replenishments.length,
          },
          expensesByCategory: Object.values(expensesByCategory),
          transactions,
          expenses: expenses.slice(0, 50), // Limit to 50 most recent
        };
      }),
    );

    // Calculate totals across all floats
    const grandTotal = report.reduce(
      (acc, r) => ({
        openingBalance: acc.openingBalance + r.summary.openingBalance,
        totalExpenses: acc.totalExpenses + r.summary.totalExpenses,
        totalReplenishments:
          acc.totalReplenishments + r.summary.totalReplenishments,
        currentBalance: acc.currentBalance + r.summary.currentBalance,
        expenseCount: acc.expenseCount + r.summary.expenseCount,
        replenishmentCount:
          acc.replenishmentCount + r.summary.replenishmentCount,
      }),
      {
        openingBalance: 0,
        totalExpenses: 0,
        totalReplenishments: 0,
        currentBalance: 0,
        expenseCount: 0,
        replenishmentCount: 0,
      },
    );

    res.json({
      success: true,
      data: {
        report,
        grandTotal,
        dateRange: {
          startDate,
          endDate,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get petty cash summary/dashboard
// @route   GET /api/petty-cash/summary
// @access  Private
exports.getSummary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    // Get all active floats
    const floats = await PettyCashFloat.find({
      company: companyId,
      isActive: true,
    }).populate("custodian", "name email");

    // Calculate summary for each float
    const floatSummaries = await Promise.all(
      floats.map(async (float) => {
        const expenses = await PettyCashExpense.find({
          float: float._id,
          status: { $in: ["approved", "reimbursed"] },
        });

        const replenishments = await PettyCashReplenishment.find({
          float: float._id,
          status: "completed",
        });

        const pendingExpenses = await PettyCashExpense.countDocuments({
          float: float._id,
          status: "pending",
        });

        const pendingReplenishments =
          await PettyCashReplenishment.countDocuments({
            float: float._id,
            status: "pending",
          });

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayExpenses = await PettyCashExpense.find({
          float: float._id,
          date: { $gte: today },
          status: { $in: ["approved", "reimbursed"] },
        });

        const totalExpenses = expenses.reduce(
          (sum, exp) => sum + (exp.amount || 0),
          0,
        );
        const totalReplenishments = replenishments.reduce(
          (sum, rep) => sum + (rep.actualAmount || rep.amount || 0),
          0,
        );
        // Calculate balance from transactions
        const transactions = await PettyCashTransaction.find({ float: float._id });
        const currentBalance = transactions.reduce((sum, tx) => sum + (tx.amount || 0), 0);
        const todayTotal = todayExpenses.reduce(
          (sum, exp) => sum + (exp.amount || 0),
          0,
        );

        // Check if needs replenishment
        const needsReplenishment = currentBalance < float.minimumBalance;

        return {
          _id: float._id,
          name: float.name,
          openingBalance: float.openingBalance,
          currentBalance,
          minimumBalance: float.minimumBalance,
          custodian: float.custodian,
          needsReplenishment,
          pendingExpenses,
          pendingReplenishments,
          todayTotal,
          totalExpenses,
          totalReplenishments,
        };
      }),
    );

    // Calculate totals
    const totals = floatSummaries.reduce(
      (acc, f) => ({
        totalOpeningBalance: acc.totalOpeningBalance + f.openingBalance,
        totalCurrentBalance: acc.totalCurrentBalance + f.currentBalance,
        totalTodayExpenses: acc.totalTodayExpenses + f.todayTotal,
        totalPendingExpenses: acc.totalPendingExpenses + f.pendingExpenses,
        totalPendingReplenishments:
          acc.totalPendingReplenishments + f.pendingReplenishments,
      }),
      {
        totalOpeningBalance: 0,
        totalCurrentBalance: 0,
        totalTodayExpenses: 0,
        totalPendingExpenses: 0,
        totalPendingReplenishments: 0,
      },
    );

    res.json({
      success: true,
      data: {
        floats: floatSummaries,
        totals,
        floatCount: floats.length,
        needsReplenishment: floatSummaries.filter((f) => f.needsReplenishment)
          .length,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get transactions history
// @route   GET /api/petty-cash/transactions
// @access  Private
exports.getTransactions = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      floatId,
      type,
      startDate,
      endDate,
      page = 1,
      limit = 50,
    } = req.query;

    const query = { company: companyId };

    if (floatId) query.float = floatId;
    if (type) query.type = type;

    if (startDate || endDate) {
      query.transactionDate = {};
      if (startDate) query.transactionDate.$gte = new Date(startDate);
      if (endDate) query.transactionDate.$lte = new Date(endDate);
    }

    const transactions = await PettyCashTransaction.find(query)
      .populate("float", "name")
      .populate("createdBy", "name email")
      .sort({ transactionDate: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await PettyCashTransaction.countDocuments(query);

    res.json({
      success: true,
      count: transactions.length,
      total,
      pages: Math.ceil(total / limit),
      data: transactions,
    });
  } catch (error) {
    next(error);
  }
};

// =====================================================
// NEW API ENDPOINTS PER MODULE 4 SPEC
// =====================================================

// @desc    Get all petty cash funds (new endpoint per spec)
// @route   GET /api/petty-cash/funds
// @access  Private
exports.getFunds = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { isActive } = req.query;

    const query = { company: companyId };
    if (isActive !== undefined) {
      query.isActive = isActive === "true";
    }

    const floats = await PettyCashFloat.find(query)
      .populate("custodian", "name email")
      .sort({ createdAt: -1 });

    // Calculate current balance for each float
    const floatsWithBalance = await Promise.all(
      floats.map(async (float) => {
        const currentBalance = await getCurrentBalance(float._id);
        const replenishmentNeeded = float.floatAmount - currentBalance;

        // Calculate imprest replenishment if applicable
        const imprestData = float.imprestMode
          ? await calculateImprestReplenishmentAmount(float._id)
          : null;

        return {
          _id: float._id,
          name: float.name,
          ledgerAccountId: float.ledgerAccountId,
          custodian: float.custodian,
          floatAmount: float.floatAmount,
          imprestMode: float.imprestMode,
          currentBalance,
          replenishmentNeeded: Math.max(0, replenishmentNeeded),
          imprestReplenishmentAmount: imprestData?.replenishmentAmount || null,
          isActive: float.isActive,
          createdAt: float.createdAt,
        };
      }),
    );

    res.json({
      success: true,
      count: floatsWithBalance.length,
      data: floatsWithBalance,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create petty cash fund (new endpoint per spec)
// @route   POST /api/petty-cash/funds
// @access  Private
exports.createFund = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      name,
      ledgerAccountId,
      custodianId,
      floatAmount,
      openingBalance,
      imprestMode,
      notes,
    } = req.body;

    // Validate required fields
    if (!name) {
      return res
        .status(400)
        .json({ success: false, message: "Name is required" });
    }
    if (!floatAmount && floatAmount !== 0) {
      return res
        .status(400)
        .json({ success: false, message: "Float amount is required" });
    }

    // Validate opening balance doesn't exceed float amount
    if (openingBalance && openingBalance > floatAmount) {
      return res.status(400).json({
        success: false,
        code: "OPENING_BALANCE_EXCEEDS_FLOAT",
        message: `Opening balance (${openingBalance}) cannot exceed the float amount (${floatAmount}). Please adjust the opening balance or increase the float limit.`,
        floatAmount,
        openingBalance,
      });
    }

    const pettyCashFloat = new PettyCashFloat({
      company: companyId,
      name,
      ledgerAccountId: ledgerAccountId || "1050",
      custodian: custodianId || req.user._id,
      openingBalance: openingBalance || 0,
      floatAmount: floatAmount,
      currentBalance: openingBalance || 0,
      imprestMode: imprestMode !== undefined ? imprestMode : true, // Default to imprest mode
      isActive: true,
      notes,
    });

    await pettyCashFloat.save();

    // Create opening transaction if opening balance > 0
    if (openingBalance && openingBalance > 0) {
      const float = await PettyCashFloat.findById(pettyCashFloat._id);
      await PettyCashTransaction.create({
        company: companyId,
        float: pettyCashFloat._id,
        type: "opening",
        amount: openingBalance,
        balanceAfter: openingBalance, // The balance after opening is the opening balance itself
        description: "Opening balance",
        createdBy: req.user._id,
      });

      // Create journal entry for opening float
      // Debit: Petty Cash (1050), Credit: Cash in Hand (1000)
      try {
        await JournalService.createEntry(companyId, req.user._id, {
          date: new Date(),
          description: `Petty Cash Float Opening: ${name}`,
          sourceType: "petty_cash_opening",
          sourceId: pettyCashFloat._id,
          sourceReference: "Float Opening",
          lines: [
            JournalService.createDebitLine(
              DEFAULT_ACCOUNTS.pettyCash,
              openingBalance,
              `Opening petty cash float: ${name}`,
            ),
            JournalService.createCreditLine(
              DEFAULT_ACCOUNTS.cashInHand,
              openingBalance,
              `Opening petty cash float: ${name}`,
            ),
          ],
          isAutoGenerated: true,
        });
      } catch (journalError) {
        console.error(
          "Failed to create journal entry for petty cash float:",
          journalError,
        );
      }
    }

    res.status(201).json({
      success: true,
      data: {
        _id: pettyCashFloat._id,
        name: pettyCashFloat.name,
        ledgerAccountId: pettyCashFloat.ledgerAccountId,
        floatAmount: pettyCashFloat.floatAmount,
        currentBalance: pettyCashFloat.currentBalance,
        isActive: pettyCashFloat.isActive,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Record top-up (cash transferred from bank to petty cash)
// @route   POST /api/petty-cash/funds/:id/top-up
// @access  Private
// Journal Entry: DR Petty Cash (float's ledgerAccountId), CR Bank (bank account's ledgerAccountId)
exports.topUp = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { amount, bank_account_id, description, transactionDate } = req.body;

    // Validate required fields
    if (!amount || amount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Valid amount is required" });
    }

    // Validate bank_account_id is required
    if (!bank_account_id) {
      return res.status(422).json({
        success: false,
        code: "BANK_ACCOUNT_REQUIRED",
        message: "bank_account_id is required for top-up",
      });
    }

    // Find the bank account and validate it exists and is active
    const bankAccount = await BankAccount.findOne({
      _id: bank_account_id,
      company: companyId,
    });

    if (!bankAccount) {
      return res.status(404).json({
        success: false,
        code: "BANK_ACCOUNT_NOT_FOUND",
        message: "Bank account not found",
      });
    }

    if (!bankAccount.isActive) {
      return res.status(400).json({
        success: false,
        code: "BANK_ACCOUNT_INACTIVE",
        message: "Cannot use inactive bank account",
      });
    }

    // Validate bank has sufficient balance using BankTransaction records
    // (account-specific — not shared via ledgerAccountId across multiple accounts)
    const bankCurrentBalance = await BankAccount.computeBalanceFromTransactions(
      bankAccount._id,
      bankAccount.openingBalance,
    );

    if (bankCurrentBalance < amount) {
      return res.status(409).json({
        success: false,
        code: "INSUFFICIENT_BANK_BALANCE",
        message: "Insufficient bank account balance",
        currentBalance: bankCurrentBalance,
        requestedAmount: amount,
        shortfall: amount - bankCurrentBalance,
      });
    }

    // Find the float
    const float = await PettyCashFloat.findOne({ _id: id, company: companyId });
    if (!float) {
      return res
        .status(404)
        .json({ success: false, message: "Petty cash fund not found" });
    }

    if (!float.isActive) {
      return res.status(400).json({
        success: false,
        message: "Cannot add to inactive petty cash fund",
      });
    }

    const txDate = transactionDate ? new Date(transactionDate) : new Date();

    // Get current balance
    const currentBalance = await getCurrentBalance(float._id);
    const newBalance = currentBalance + amount;

    // Validate that top-up won't exceed float amount
    if (float.floatAmount && newBalance > float.floatAmount) {
      const excess = newBalance - float.floatAmount;
      return res.status(409).json({
        success: false,
        code: "FLOAT_AMOUNT_EXCEEDED",
        message: `This top-up would exceed the fund's float amount of ${float.floatAmount}. Current balance: ${currentBalance}, Top-up amount: ${amount}, Excess: ${excess}. Please reduce the top-up amount or increase the float limit.`,
        floatAmount: float.floatAmount,
        currentBalance,
        requestedAmount: amount,
        newBalance,
        excess,
      });
    }

    // Create transaction record
    const transaction = await PettyCashTransaction.create({
      company: companyId,
      float: float._id,
      type: "top_up",
      amount: amount,
      balanceAfter: newBalance,
      description: description || `Top-up from bank`,
      transactionDate: txDate,
      createdBy: req.user._id,
    });

    // Invalidate cache
    await invalidateCache(float._id);

    // Get accounts
    const pettyCashAccount =
      float.ledgerAccountId || DEFAULT_ACCOUNTS.pettyCash;
    const bankLedgerAccount =
      bankAccount.ledgerAccountId || DEFAULT_ACCOUNTS.cashAtBank;

    // Create journal entry
    // Debit: Petty Cash (from float's ledgerAccountId)
    // Credit: Bank (from bank account's ledgerAccountId)
    try {
      const journalEntry = await JournalService.createEntry(
        companyId,
        req.user._id,
        {
          date: txDate,
          description: `Petty Cash Top-up - ${float.name} - ${transaction.referenceNo}`,
          sourceType: "petty_cash_topup",
          sourceId: transaction._id,
          sourceReference: transaction.referenceNo,
          lines: [
            JournalService.createDebitLine(
              pettyCashAccount,
              amount,
              `Petty cash top-up: ${transaction.referenceNo}`,
            ),
            JournalService.createCreditLine(
              bankLedgerAccount,
              amount,
              `Petty cash top-up from ${bankAccount.name}: ${transaction.referenceNo}`,
            ),
          ],
          isAutoGenerated: true,
        },
      );

      // Update transaction with journal entry ID
      transaction.journalEntryId = journalEntry._id;
      await transaction.save();

      // Create a BankTransaction record on the source bank account (withdrawal).
      // This is the authoritative per-account debit record — it makes the balance
      // reduce immediately and appears in the bank account's own transaction history.
      // (Journal entries use a shared ledgerAccountId so cannot be used per-account.)
      try {
        await bankAccount.addTransaction({
          type: "withdrawal",
          amount,
          description: description || `Petty Cash Top-up to ${float.name}`,
          referenceNumber: transaction.referenceNo,
          referenceType: "PettyCashFloat",
          reference: float._id,
          date: txDate,
          createdBy: req.user._id,
          notes: `Petty cash fund: ${float.name} — ${transaction.referenceNo}`,
          journalEntryId: journalEntry._id,
        });
      } catch (btErr) {
        // Non-fatal — journal entry already exists; balance recalculated on next fetch
        console.error(
          "Failed to create BankTransaction for petty cash top-up:",
          btErr.message,
        );
      }
    } catch (journalError) {
      console.error(
        "Failed to create journal entry for petty cash top-up:",
        journalError,
      );
    }

    res.status(201).json({
      success: true,
      data: {
        _id: transaction._id,
        referenceNo: transaction.referenceNo,
        type: "top_up",
        amount,
        balanceAfter: newBalance,
        description: transaction.description,
        bankAccountId: bank_account_id,
        bankAccountName: bankAccount.name,
        transactionDate: transaction.transactionDate,
        createdAt: transaction.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Record expense (cash paid out for an expense)
// @route   POST /api/petty-cash/funds/:id/expense
// @access  Private
// Journal Entry: DR expense_account_id (or 1250 for staff advance), CR 1050 Petty Cash
exports.recordExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const {
      amount,
      expenseAccountId: providedExpenseAccountId,
      description,
      receiptRef,
      transactionDate,
      category,
      subcategory,
      recipientType,
      isTaxable,
      isStaffAdvance,
      purpose,
      receiptUploadUrl,
      receiptUploadName,
    } = req.body;

    // Validate required fields
    if (!amount || amount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Valid amount is required" });
    }

    // Validate category
    const expenseCategory = category || "miscellaneous";
    const expenseSubcategory = subcategory || "";

    // Determine the effective GL account
    let effectiveExpenseAccountId = providedExpenseAccountId;
    if (!effectiveExpenseAccountId) {
      effectiveExpenseAccountId = getDefaultExpenseAccount(
        expenseCategory,
        expenseSubcategory,
      );
    }

    // Validate expense account exists and allows direct posting
    const accountCheck = canPostToAccount(effectiveExpenseAccountId);
    if (!accountCheck.valid) {
      return res.status(400).json({
        success: false,
        code: accountCheck.reason,
        message: `Cannot post to account ${effectiveExpenseAccountId}: ${accountCheck.reason === "ACCOUNT_NO_POSTING" ? "This is a header/summary account and cannot be posted to directly" : "Account not found"}`,
      });
    }

    // Find the float
    const float = await PettyCashFloat.findOne({ _id: id, company: companyId });
    if (!float) {
      return res
        .status(404)
        .json({ success: false, message: "Petty cash fund not found" });
    }

    if (!float.isActive) {
      return res.status(400).json({
        success: false,
        message: "Cannot record expense on inactive petty cash fund",
      });
    }

    const txDate = transactionDate ? new Date(transactionDate) : new Date();

    // Get current balance
    const currentBalance = await getCurrentBalance(float._id);
    const newBalance = currentBalance - amount;

    // Business Rule: current_balance cannot go below zero
    if (newBalance < 0) {
      return res.status(409).json({
        success: false,
        code: "INSUFFICIENT_PETTY_CASH",
        message: "Insufficient petty cash balance",
        currentBalance,
        requestedAmount: amount,
        shortfall: amount - currentBalance,
      });
    }

    // Build warnings (e.g. maintenance approaching float limit)
    const warnings = buildExpenseWarnings(float, expenseCategory, amount);

    // Determine journal debit account
    // Staff advances are short-term receivables, not expenses
    let journalDebitAccountId = effectiveExpenseAccountId;
    let isAdvance = false;
    if (isStaffAdvance === true || category === "staff_advance") {
      journalDebitAccountId = DEFAULT_ACCOUNTS.employeeAdvances || "1250";
      isAdvance = true;
    }

    // Create expense record with auto-generated voucher number
    const expense = await PettyCashExpense.create({
      company: companyId,
      float: float._id,
      description: description || "Petty cash expense",
      amount,
      expenseAccountId: effectiveExpenseAccountId,
      category: expenseCategory,
      subcategory: expenseSubcategory,
      recipientType: recipientType || null,
      isTaxable: isTaxable || false,
      isStaffAdvance: isAdvance,
      staffAdvanceStatus: isAdvance ? "outstanding" : null,
      purpose: purpose || null,
      date: txDate,
      receiptNumber: receiptRef,
      receiptUploadUrl: receiptUploadUrl || undefined,
      receiptUploadName: receiptUploadName || undefined,
      status: "approved", // Auto-approved for direct expense recording
      approvedBy: req.user._id,
      approvedAt: new Date(),
    });

    // Re-fetch expense to get the auto-generated voucherNumber from pre-save hook
    const expenseWithVoucher = await PettyCashExpense.findById(expense._id);

    // Create transaction record linked to expense voucher
    const transaction = await PettyCashTransaction.create({
      company: companyId,
      float: float._id,
      type: "expense",
      reference: expenseWithVoucher._id,
      referenceType: "PettyCashExpense",
      voucherNumber: expenseWithVoucher.voucherNumber,
      amount: -amount,
      balanceAfter: newBalance,
      description: description || "Petty cash expense",
      expenseAccountId: effectiveExpenseAccountId,
      receiptRef,
      transactionDate: txDate,
      createdBy: req.user._id,
    });

    // Invalidate cache
    await invalidateCache(float._id);

    // Create journal entry
    // Debit: effectiveExpenseAccountId (or Employee Advances for staff advance)
    // Credit: Petty Cash (from float's ledgerAccountId)
    const pettyCashAccount =
      float.ledgerAccountId || DEFAULT_ACCOUNTS.pettyCash;
    try {
      const journalLines = [
        JournalService.createDebitLine(
          journalDebitAccountId,
          amount,
          `Petty cash ${isAdvance ? "advance" : "expense"}: ${transaction.referenceNo}`,
        ),
        JournalService.createCreditLine(
          pettyCashAccount,
          amount,
          `Petty cash ${isAdvance ? "advance" : "expense"}: ${transaction.referenceNo}`,
        ),
      ];

      const journalEntry = await JournalService.createEntry(
        companyId,
        req.user._id,
        {
          date: txDate,
          description: `Petty Cash ${isAdvance ? "Advance" : "Expense"} - ${description || (isAdvance ? "Advance" : "Expense")} - ${transaction.referenceNo}`,
          sourceType: isAdvance
            ? "petty_cash_advance"
            : "petty_cash_expense",
          sourceId: transaction._id,
          sourceReference: transaction.referenceNo,
          lines: journalLines,
          isAutoGenerated: true,
        },
      );

      // Update transaction with journal entry ID
      transaction.journalEntryId = journalEntry._id;
      await transaction.save();

      // Manually invalidate the petty cash float cache
      try {
        await PettyCashFloat.findByIdAndUpdate(float._id, {
          $set: { cacheValid: false },
        });
      } catch (e) {
        console.error("Failed to invalidate petty cash cache:", e);
      }
    } catch (journalError) {
      console.error(
        "Failed to create journal entry for petty cash expense:",
        journalError,
      );
    }

    res.status(201).json({
      success: true,
      warnings: warnings.length > 0 ? warnings : undefined,
      data: {
        _id: transaction._id,
        referenceNo: transaction.referenceNo,
        voucherNumber: expenseWithVoucher.voucherNumber,
        expenseId: expenseWithVoucher._id,
        type: "expense",
        amount,
        balanceAfter: newBalance,
        description: transaction.description,
        expenseAccountId: effectiveExpenseAccountId,
        category: expenseCategory,
        subcategory: expenseSubcategory,
        isStaffAdvance: isAdvance,
        receiptRef,
        transactionDate: transaction.transactionDate,
        createdAt: transaction.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get transaction history with running balance for a fund
// @route   GET /api/petty-cash/funds/:id/transactions
// @access  Private
exports.getFundTransactions = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { startDate, endDate, type, page = 1, limit = 50 } = req.query;

    // Find the float
    const float = await PettyCashFloat.findOne({ _id: id, company: companyId });
    if (!float) {
      return res
        .status(404)
        .json({ success: false, message: "Petty cash fund not found" });
    }

    // Build query
    const query = { company: companyId, float: id };

    if (type) query.type = type;

    if (startDate || endDate) {
      query.transactionDate = {};
      if (startDate) query.transactionDate.$gte = new Date(startDate);
      if (endDate) query.transactionDate.$lte = new Date(endDate);
    }

    // Get transactions sorted by date
    const transactions = await PettyCashTransaction.find(query)
      .populate("createdBy", "name email")
      .sort({ transactionDate: 1, createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await PettyCashTransaction.countDocuments(query);

    // Get ALL transactions to calculate running balance properly (chronologically)
    // This ensures correct balance calculation regardless of pagination
    const allTransactions = await PettyCashTransaction.find(query)
      .sort({ transactionDate: 1, createdAt: 1 })
      .lean();

    // Calculate running balance for ALL transactions (oldest to newest)
    let cumulativeBalance = 0;
    const balanceMap = new Map();
    for (const tx of allTransactions) {
      cumulativeBalance += tx.amount;
      balanceMap.set(tx._id.toString(), cumulativeBalance);
    }

    // Resolve account names for expense accounts + float ledger account (top-up / replenishment)
    const floatLedgerId = float.ledgerAccountId || DEFAULT_ACCOUNTS.pettyCash;
    const expenseAccountIds = [
      ...new Set(
        [
          ...transactions.map((tx) => tx.expenseAccountId).filter(Boolean),
          floatLedgerId,
        ],
      ),
    ];
    const expenseAccounts = {};
    if (expenseAccountIds.length > 0) {
      for (const accountId of expenseAccountIds) {
        try {
          const account = await ChartOfAccountsService.getAccountByCode(
            companyId,
            accountId,
          );
          if (account) {
            expenseAccounts[accountId] = account.name;
          }
        } catch (e) {
          // Account lookup failed, continue without name
        }
      }
    }

    const transactionsWithRunningBalance = transactions.map((tx) => {
      const isExpenseLike = tx.type === "expense";
      const ledgerAccountId = isExpenseLike
        ? tx.expenseAccountId
        : floatLedgerId;
      return {
        _id: tx._id,
        referenceNo: tx.referenceNo,
        voucherNumber: tx.voucherNumber || null,
        type: tx.type,
        typeLabel:
          tx.type === "top_up"
            ? "Top Up"
            : tx.type === "expense"
              ? "Expense"
              : tx.type === "opening"
                ? "Opening"
                : tx.type === "replenishment"
                  ? "Replenishment"
                  : tx.type === "adjustment"
                    ? "Adjustment"
                    : "Closing",
        amount: Math.abs(tx.amount),
        runningBalance: balanceMap.get(tx._id.toString()),
        description: tx.description,
        expenseAccountId: ledgerAccountId || null,
        expenseAccountName: ledgerAccountId
          ? expenseAccounts[ledgerAccountId] || null
          : null,
        receiptRef: tx.receiptRef || null,
        journalEntryId: tx.journalEntryId || null,
        transactionDate: tx.transactionDate,
        createdAt: tx.createdAt,
        createdBy: tx.createdBy,
      };
    });

    // Get current balance
    const currentBalance = await getCurrentBalance(float._id);
    const replenishmentNeeded = float.floatAmount - currentBalance;

    res.json({
      success: true,
      count: transactionsWithRunningBalance.length,
      total,
      pages: Math.ceil(total / limit),
      data: {
        fund: {
          _id: float._id,
          name: float.name,
          ledgerAccountId: float.ledgerAccountId,
          floatAmount: float.floatAmount,
          imprestMode: float.imprestMode,
          currentBalance,
          replenishmentNeeded: Math.max(0, replenishmentNeeded),
        },
        transactions: transactionsWithRunningBalance,
      },
    });
  } catch (error) {
    next(error);
  }
};

// =====================================================
// CASH COUNT RECONCILIATION METHODS
// =====================================================

// @desc    Create cash count reconciliation
// @route   POST /api/petty-cash/funds/:id/cash-count
// @access  Private
exports.createCashCount = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { countDate, cashDenominations, notes } = req.body;

    // Find the float
    const float = await PettyCashFloat.findOne({ _id: id, company: companyId });
    if (!float) {
      return res
        .status(404)
        .json({ success: false, message: "Petty cash fund not found" });
    }

    if (!float.isActive) {
      return res.status(400).json({
        success: false,
        message: "Cannot count inactive petty cash fund",
      });
    }

    // Get system balance at time of count
    const systemBalance = await getCurrentBalance(float._id);

    // Calculate physical cash total from denominations
    const physicalCashTotal = cashDenominations.reduce(
      (sum, denom) => sum + (denom.total || 0),
      0,
    );

    // Calculate difference
    const difference = physicalCashTotal - systemBalance;

    // Determine difference type
    let differenceType = "balanced";
    if (difference < 0) {
      differenceType = "shortage";
    } else if (difference > 0) {
      differenceType = "overage";
    }

    // Create reconciliation record
    const reconciliation = await PettyCashReconciliation.create({
      company: companyId,
      float: float._id,
      countDate: countDate ? new Date(countDate) : new Date(),
      systemBalance,
      cashDenominations,
      physicalCashTotal,
      difference,
      differenceType,
      countedBy: req.user._id,
      status: "pending",
      notes,
    });

    res.status(201).json({
      success: true,
      data: {
        _id: reconciliation._id,
        reconciliationNumber: reconciliation.reconciliationNumber,
        countDate: reconciliation.countDate,
        systemBalance,
        physicalCashTotal,
        difference,
        differenceType,
        status: reconciliation.status,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all reconciliations for a float
// @route   GET /api/petty-cash/funds/:id/reconciliations
// @access  Private
exports.getReconciliations = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { status, page = 1, limit = 20 } = req.query;

    // Find the float
    const float = await PettyCashFloat.findOne({ _id: id, company: companyId });
    if (!float) {
      return res
        .status(404)
        .json({ success: false, message: "Petty cash fund not found" });
    }

    const query = { company: companyId, float: id };
    if (status) query.status = status;

    const reconciliations = await PettyCashReconciliation.find(query)
      .populate("countedBy", "name email")
      .populate("approvedBy", "name email")
      .sort({ countDate: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await PettyCashReconciliation.countDocuments(query);

    res.json({
      success: true,
      count: reconciliations.length,
      total,
      pages: Math.ceil(total / limit),
      data: reconciliations,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single reconciliation
// @route   GET /api/petty-cash/reconciliations/:id
// @access  Private
exports.getReconciliation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const reconciliation = await PettyCashReconciliation.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate("float", "name")
      .populate("countedBy", "name email")
      .populate("approvedBy", "name email");

    if (!reconciliation) {
      return res
        .status(404)
        .json({ success: false, message: "Reconciliation not found" });
    }

    res.json({
      success: true,
      data: reconciliation,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Approve/reject cash count and post shortage/overage
// @route   PUT /api/petty-cash/reconciliations/:id/approve
// @access  Private
exports.approveReconciliation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { status, discrepancyExplanation } = req.body;

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be approved or rejected",
      });
    }

    const reconciliation = await PettyCashReconciliation.findOne({
      _id: req.params.id,
      company: companyId,
    }).populate("float");

    if (!reconciliation) {
      return res
        .status(404)
        .json({ success: false, message: "Reconciliation not found" });
    }

    if (reconciliation.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Cannot ${status} reconciliation with status '${reconciliation.status}'`,
      });
    }

    reconciliation.status = status;
    reconciliation.approvedBy = req.user._id;
    reconciliation.approvedAt = new Date();
    if (discrepancyExplanation) {
      reconciliation.discrepancyExplanation = discrepancyExplanation;
    }

    // If approving and there's a shortage or overage, create journal entry
    if (status === "approved" && reconciliation.differenceType !== "balanced") {
      const float = reconciliation.float;
      const difference = Math.abs(reconciliation.difference);

      if (difference > 0) {
        try {
          const lines = [];

          if (reconciliation.differenceType === "shortage") {
            // Shortage: DR Shortage/Overage Expense, CR Petty Cash
            lines.push(
              JournalService.createDebitLine(
                reconciliation.shortageOverageAccountId || DEFAULT_ACCOUNTS.otherExpenses,
                difference,
                `Petty cash shortage - ${reconciliation.reconciliationNumber}`,
              ),
              JournalService.createCreditLine(
                float.ledgerAccountId || DEFAULT_ACCOUNTS.pettyCash,
                difference,
                `Petty cash shortage - ${reconciliation.reconciliationNumber}`,
              ),
            );

            // Create adjustment transaction (negative amount for shortage)
            await PettyCashTransaction.create({
              company: companyId,
              float: float._id,
              type: "adjustment",
              amount: -difference,
              balanceAfter: reconciliation.systemBalance - difference,
              description: `Shortage adjustment - ${reconciliation.reconciliationNumber}`,
              createdBy: req.user._id,
            });
          } else {
            // Overage: DR Petty Cash, CR Shortage/Overage Income
            // Use 4900 (Other Income) for overage
            const overageAccountId = "4900";
            lines.push(
              JournalService.createDebitLine(
                float.ledgerAccountId || DEFAULT_ACCOUNTS.pettyCash,
                difference,
                `Petty cash overage - ${reconciliation.reconciliationNumber}`,
              ),
              JournalService.createCreditLine(
                overageAccountId,
                difference,
                `Petty cash overage - ${reconciliation.reconciliationNumber}`,
              ),
            );

            // Create adjustment transaction (positive amount for overage)
            await PettyCashTransaction.create({
              company: companyId,
              float: float._id,
              type: "adjustment",
              amount: difference,
              balanceAfter: reconciliation.systemBalance + difference,
              description: `Overage adjustment - ${reconciliation.reconciliationNumber}`,
              createdBy: req.user._id,
            });
          }

          const journalEntry = await JournalService.createEntry(
            companyId,
            req.user._id,
            {
              date: new Date(),
              description: `Petty Cash ${reconciliation.differenceType === "shortage" ? "Shortage" : "Overage"} - ${reconciliation.reconciliationNumber}`,
              sourceType: "petty_cash_reconciliation",
              sourceId: reconciliation._id,
              sourceReference: reconciliation.reconciliationNumber,
              lines,
              isAutoGenerated: true,
            },
          );

          reconciliation.journalEntryId = journalEntry._id;

          // Invalidate cache
          await invalidateCache(float._id);
        } catch (journalError) {
          console.error(
            "Failed to create journal entry for reconciliation:",
            journalError,
          );
          // Don't fail the approval if journal entry fails
        }
      }
    }

    await reconciliation.save();

    res.json({
      success: true,
      data: reconciliation,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get imprest replenishment calculation
// @route   GET /api/petty-cash/funds/:id/imprest-calculation
// @access  Private
exports.getImprestCalculation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;

    const float = await PettyCashFloat.findOne({ _id: id, company: companyId });
    if (!float) {
      return res
        .status(404)
        .json({ success: false, message: "Petty cash fund not found" });
    }

    const calculation = await calculateImprestReplenishmentAmount(float._id);

    if (!calculation) {
      return res.json({
        success: true,
        data: {
          isImprest: false,
          message: "Fund is not in imprest mode",
        },
      });
    }

    res.json({
      success: true,
      data: calculation,
    });
  } catch (error) {
    next(error);
  }
};
