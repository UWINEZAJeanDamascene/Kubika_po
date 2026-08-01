const Expense = require("../models/Expense");
const mongoose = require("mongoose");
const { BankAccount, BankTransaction } = require("../models/BankAccount");
const ChartOfAccount = require("../models/ChartOfAccount");
const JournalService = require("../services/journalService");
const JournalEntry = require("../models/JournalEntry");
const AuditService = require("../services/auditService");
const BudgetService = require("../services/budgetService");

// @desc    Get all expenses for a company
// @route   GET /api/expenses
// @access  Private
exports.getExpenses = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      type,
      startDate,
      endDate,
      expenseAccountId,
      paymentMethod,
      page = 1,
      limit = 50,
    } = req.query;

    const query = { company: companyId };

    if (type) {
      query.type = type;
    }

    // Filter by expense account
    if (expenseAccountId) {
      query.expense_account_id = expenseAccountId;
    }

    // Filter by payment method
    if (paymentMethod) {
      query.payment_method = paymentMethod;
    }

    if (startDate || endDate) {
      query.expenseDate = {};
      if (startDate) query.expenseDate.$gte = new Date(startDate);
      if (endDate) query.expenseDate.$lte = new Date(endDate);
    }

    const expenses = await Expense.find(query)
      .populate("createdBy", "name email")
      .populate("approvedBy", "name email")
      .populate("expense_account_id", "code name")
      .populate("bank_account_id", "accountCode accountName")
      .populate("petty_cash_fund_id", "name")
      .populate("department_id", "code name")
      .sort({ expenseDate: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Expense.countDocuments(query);

    // Transform to include populated Account and Method columns
    const transformedExpenses = expenses.map((exp) => {
      const transformed = {
        _id: exp._id,
        reference: exp.reference_no || exp.expenseNumber,
        date: exp.expenseDate || exp.expense_date,
        description: exp.description,
        account: exp.expense_account_id
          ? {
              _id: exp.expense_account_id._id,
              code: exp.expense_account_id.code,
              name: exp.expense_account_id.name,
            }
          : null,
        method: exp.payment_method || exp.paymentMethod,
        amount: exp.amount,
        taxAmount: exp.tax_amount || exp.vatAmount,
        totalAmount: exp.total_amount || exp.amount + (exp.tax_amount || 0),
        // Rwanda-specific currency fields
        currencyCode: exp.currencyCode || 'RWF',
        exchangeRate: exp.exchangeRate || 1,
        amountInRWF: exp.amountInRWF || exp.amount,
        taxAmountInRWF: exp.taxAmountInRWF || (exp.tax_amount || 0),
        totalAmountInRWF: exp.totalAmountInRWF || exp.total_amount || (exp.amount + (exp.tax_amount || 0)),
        // RRA Tax fields
        rraTaxCategory: exp.rraTaxCategory,
        isVATRecoverable: exp.isVATRecoverable,
        // Department
        department: exp.department_id && typeof exp.department_id === 'object'
          ? {
              _id: exp.department_id._id,
              code: exp.department_id.code,
              name: exp.department_id.name,
            }
          : null,
      status: exp.status,
      type: exp.type,
      bankAccount: exp.bank_account_id
        ? {
            _id: exp.bank_account_id._id,
            code: exp.bank_account_id.accountCode,
            name: exp.bank_account_id.accountName,
          }
        : null,
      pettyCashFund: exp.petty_cash_fund_id
        ? {
            _id: exp.petty_cash_fund_id._id,
            name: exp.petty_cash_fund_id.name,
          }
        : null,
      receiptRef: exp.receipt_ref,
      createdBy: exp.createdBy,
      createdAt: exp.createdAt,
      updatedAt: exp.updatedAt,
    };
    return transformed;
    });

    res.json({
      success: true,
      count: transformedExpenses.length,
      total,
      pages: Math.ceil(total / limit) || 1,
      currentPage: parseInt(page, 10) || 1,
      pagination: {
        total,
        pages: Math.ceil(total / limit) || 1,
        currentPage: parseInt(page, 10) || 1,
        limit: parseInt(limit, 10) || 50,
      },
      data: transformedExpenses,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single expense
// @route   GET /api/expenses/:id
// @access  Private
exports.getExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const expense = await Expense.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate("createdBy", "name email")
      .populate("approvedBy", "name email")
      .populate("expense_account_id", "code name")
      .populate("bank_account_id", "accountCode accountName")
      .populate("petty_cash_fund_id", "name")
      .populate("department_id", "code name");

    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }

    // Transform expense to include account info
    const transformedExpense = {
      _id: expense._id,
      reference: expense.reference_no || expense.expenseNumber,
      date: expense.expenseDate || expense.expense_date,
      description: expense.description,
      account: expense.expense_account_id
        ? {
            _id: expense.expense_account_id._id,
            code: expense.expense_account_id.code,
            name: expense.expense_account_id.name,
          }
        : null,
      method: expense.payment_method || expense.paymentMethod,
      amount: expense.amount,
      taxAmount: expense.tax_amount || expense.vatAmount,
      totalAmount:
        expense.total_amount || expense.amount + (expense.tax_amount || 0),
      // Rwanda-specific currency fields
      currencyCode: expense.currencyCode || 'RWF',
      exchangeRate: expense.exchangeRate || 1,
      amountInRWF: expense.amountInRWF || expense.amount,
      taxAmountInRWF: expense.taxAmountInRWF || (expense.tax_amount || 0),
      totalAmountInRWF: expense.totalAmountInRWF || expense.total_amount || (expense.amount + (expense.tax_amount || 0)),
      // RRA Tax fields
      rraTaxCategory: expense.rraTaxCategory,
      isVATRecoverable: expense.isVATRecoverable,
      // Department
      department: expense.department_id
        ? {
            _id: expense.department_id._id,
            code: expense.department_id.code,
            name: expense.department_id.name,
          }
        : null,
      status: expense.status,
      type: expense.type,
      category: expense.category,
      notes: expense.notes,
      bankAccount: expense.bank_account_id
        ? {
            _id: expense.bank_account_id._id,
            code: expense.bank_account_id.accountCode,
            name: expense.bank_account_id.accountName,
          }
        : null,
      pettyCashFund: expense.petty_cash_fund_id
        ? {
            _id: expense.petty_cash_fund_id._id,
            name: expense.petty_cash_fund_id.name,
          }
        : null,
      receiptRef: expense.receipt_ref,
      createdBy: expense.createdBy,
      approvedBy: expense.approvedBy,
      createdAt: expense.createdAt,
      updatedAt: expense.updatedAt,
    };

    res.json({
      success: true,
      data: transformedExpense,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new expense
// @route   POST /api/expenses
// @access  Private
exports.createExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      bankAccountId,
      bank_account_id,
      paid,
      paymentMethod,
      payment_method,
      expense_account_id,
      expenseAccountId,
      expense_date,
      expenseDate,
      total_amount,
      amount,
      tax_amount,
      taxAmount,
      type,
      description,
      reference,
      notes,
      status, // Allow setting status (e.g. if admin wants to create directly as 'posted')
      isRecurring,
      recurringFrequency,
      budget_id,
      budget_line_id,
      // Rwanda-specific fields
      department_id,
      departmentId,
      rraTaxCategory,
      currencyCode,
      exchangeRate,
      isVATRecoverable,
    } = req.body;

    // Normalize payment method - use payment_method if sent from frontend
    const normalizedPaymentMethod = payment_method || paymentMethod || "bank";
    // Normalize bank account ID
    const normalizedBankAccountId = bankAccountId || bank_account_id;
    // Use snake_case for backend fields
    const normalizedExpenseAccountId = expense_account_id || expenseAccountId;
    const normalizedExpenseDate = expense_date || expenseDate || new Date();
    const normalizedTotalAmount =
      total_amount || amount + (tax_amount || taxAmount || 0);
    const normalizedTaxAmount = tax_amount || taxAmount || 0;
    // Normalize Rwanda fields
    const normalizedDepartmentId = department_id || departmentId || null;

    const expense = new Expense({
      company: companyId,
      createdBy: req.user._id,
      posted_by: req.user._id,
      // Use snake_case field names to match the schema
      payment_method: normalizedPaymentMethod,
      expense_account_id: normalizedExpenseAccountId,
      expense_date: normalizedExpenseDate,
      total_amount: normalizedTotalAmount,
      tax_amount: normalizedTaxAmount,
      // Other fields
      type,
      description,
      reference,
      notes,
      amount: amount,
      status: status || "pending", // Default to pending
      isRecurring: isRecurring || false,
      recurringFrequency: recurringFrequency || "monthly",
      budget_id: budget_id || null,
      budget_line_id: budget_line_id || null,
      // Rwanda-specific fields
      department_id: normalizedDepartmentId,
      rraTaxCategory,
      currencyCode: currencyCode || 'RWF',
      exchangeRate: exchangeRate || 1,
      isVATRecoverable: isVATRecoverable !== undefined ? isVATRecoverable : true,
    });

    await expense.save();

    // Create encumbrance if budget is specified
    if (expense.budget_id && expense.budget_line_id) {
      try {
        const BudgetService = require('../services/budgetService');
        await BudgetService.createEncumbranceFromExpense(expense, req.user._id);
        console.log('[createExpense] Encumbrance created for expense:', expense._id);
      } catch (encErr) {
        console.error('Error creating encumbrance for expense:', encErr);
        // Don't fail the expense creation if encumbrance fails
      }
    }

    // If expense is paid immediately, create journal entry and bank transaction
    // Only do this if status is 'posted' or 'approved' (if auto-posting is allowed)
    // For now, let's only create journals if explicitly paid and status allows it
    console.log('[createExpense] paid:', paid, 'paymentMethod:', normalizedPaymentMethod, 'status:', expense.status, 'bankAccountId:', bankAccountId);
    if (
      paid &&
      normalizedPaymentMethod &&
      (expense.status === "posted" || expense.status === "approved" || expense.status === "pending")
    ) {
      const bankPaymentMethods = ["bank_transfer", "cheque", "mobile_money", "bank", "cash", "petty_cash", "credit_card", "payable"];
      let bankAccountCode = null;
      let bankAccount = null;

      // Get bank account info if needed
      if (normalizedBankAccountId && bankPaymentMethods.includes(normalizedPaymentMethod)) {
        console.log('[createExpense] Fetching bank account:', normalizedBankAccountId);
        try {
          bankAccount = await BankAccount.findOne({
            _id: normalizedBankAccountId,
            company: companyId,
            isActive: true,
          });
          console.log('[createExpense] Bank account found:', bankAccount ? bankAccount._id : null, 'name:', bankAccount?.accountName);
          if (bankAccount) {
            bankAccountCode = bankAccount.accountCode;
          }
        } catch (err) {
          console.error("Error fetching bank account:", err);
        }
      }

      // Get expense account code for proper journal posting
      let expenseAccountCode = null;
      try {
        const expenseAccount = await ChartOfAccount.findById(expense.expense_account_id);
        if (expenseAccount) {
          expenseAccountCode = expenseAccount.code;
        }
      } catch (err) {
        console.error("Error fetching expense account:", err);
      }

      // Create journal entry for expense payment
      let journalEntry = null;
      try {
        journalEntry = await JournalService.createExpenseEntry(companyId, req.user.id, {
          _id: expense._id,
          description: expense.description || expense.type,
          date: expense.expenseDate || new Date(),
          amount: expense.total_amount || (expense.amount + (expense.tax_amount || 0)),
          vatAmount: expense.tax_amount || 0,
          withholdingTax: expense.withholdingTax || 0,
          category: expense.type,
          paymentMethod: normalizedPaymentMethod,
          bankAccountCode: bankAccountCode,
          expenseAccountCode: expenseAccountCode,
        });
      } catch (journalError) {
        console.error(
          "Error creating journal entry for expense:",
          journalError,
        );
      }

      // Create Bank Transaction using addTransaction() so cachedBalance is correctly reduced
      if (bankAccount && bankPaymentMethods.includes(normalizedPaymentMethod)) {
        try {
          await bankAccount.addTransaction({
            type: "withdrawal",
            amount: (expense.total_amount || (expense.amount + (expense.tax_amount || 0))) - (expense.withholdingTax || 0),
            description: `Expense paid: ${expense.description || expense.type}`,
            date: expense.expenseDate || new Date(),
            referenceNumber: expense.reference || "",
            paymentMethod: expense.payment_method,
            status: "completed",
            reference: expense._id,
            referenceType: "Expense",
            createdBy: req.user._id,
            notes: `Payment for expense: ${expense.description || expense.type}`,
            journalEntryId: journalEntry?._id || null,
          });
        } catch (bankError) {
          console.error(
            "Error creating bank transaction for expense:",
            bankError,
          );
        }
      }

      // Liquidate encumbrance immediately if expense is paid
      if (expense.budget_id) {
        try {
          if (expense.encumbrance_id) {
            await BudgetService.liquidateEncumbranceFromExpense(
              expense,
              req.user._id,
              {
                document_type: "expense_payment",
                document_id: expense._id.toString(),
                document_number:
                  expense.reference_no ||
                  `EXP-${expense._id.toString().slice(-5)}`,
                date: new Date(),
                notes: "Expense created and paid immediately",
              },
            );
          }
        } catch (encErr) {
          console.error('Error liquidating encumbrance on create:', encErr);
        }
      }
    }

    res.status(201).json({
      success: true,
      data: expense,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update expense
// @route   PUT /api/expenses/:id
// @access  Private
exports.updateExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    let expense = await Expense.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }

    // Don't allow changing company or createdBy
    const { company, createdBy, bankAccountId, department_id, ...updateData } = req.body;

    // Check if expense is being marked as paid with bank transfer
    const isBeingPaid = updateData.paid === true && !expense.paid;
    const paymentMethod = updateData.paymentMethod || updateData.payment_method;
    const bankPaymentMethods = ["bank_transfer", "cheque", "mobile_money", "bank", "cash", "petty_cash", "credit_card", "payable"];

    // Get bank account info if needed for journal entry and bank transaction
    let bankAccount = null;
    let bankAccountCode = null;
    if (bankAccountId && bankPaymentMethods.includes(paymentMethod)) {
      try {
        bankAccount = await BankAccount.findOne({
          _id: bankAccountId,
          company: companyId,
          isActive: true,
        });
        if (bankAccount) {
          bankAccountCode = bankAccount.accountCode;
        }
      } catch (err) {
        console.error("Error fetching bank account:", err);
      }
    }

    // Assign bank account and department to expense
    if (bankAccountId) {
      expense.bank_account_id = bankAccountId;
    }
    if (department_id) {
      expense.department_id = department_id;
    }

    Object.assign(expense, updateData);
    await expense.save();

    // Get expense account code for proper journal posting
    let expenseAccountCode = null;
    try {
      const expenseAccount = await ChartOfAccount.findById(expense.expense_account_id);
      if (expenseAccount) {
        expenseAccountCode = expenseAccount.code;
      }
    } catch (err) {
      console.error("Error fetching expense account:", err);
    }

    // Create journal entry for expense payment
    let journalEntry = null;
    if (isBeingPaid) {
      try {
        journalEntry = await JournalService.createExpenseEntry(companyId, req.user.id, {
          _id: expense._id,
          description: expense.description || expense.type,
          date: expense.expenseDate || new Date(),
          amount: expense.total_amount || (expense.amount + (expense.tax_amount || 0)),
          vatAmount: expense.tax_amount || 0,
          withholdingTax: expense.withholdingTax || 0,
          category: expense.type,
          paymentMethod: paymentMethod,
          bankAccountCode: bankAccountCode,
          expenseAccountCode: expenseAccountCode,
        });
      } catch (journalError) {
        console.error(
          "Error creating journal entry for expense:",
          journalError,
        );
        // Don't fail the expense update if journal entry fails
      }
    }

    // Create bank transaction if expense is being marked as paid with bank transfer, cheque, or mobile money
    let bankTransaction = null;
    if (
      isBeingPaid &&
      bankPaymentMethods.includes(paymentMethod) &&
      bankAccount
    ) {
      try {
        const totalAmount = expense.total_amount || (expense.amount + (expense.tax_amount || 0));
        const netPaid = totalAmount - (expense.withholdingTax || 0);
        // Use addTransaction which properly handles cachedBalance
        const transaction = await bankAccount.addTransaction({
          type: "withdrawal",
          amount: netPaid,
          description: `Expense paid: ${expense.description || expense.type}`,
          date: new Date(),
          referenceNumber: expense.reference || "",
          paymentMethod: paymentMethod,
          status: "completed",
          reference: expense._id,
          referenceType: "Expense",
          createdBy: req.user._id,
          notes: `Payment for expense: ${expense.description || expense.type}`,
          journalEntryId: journalEntry?._id || null,
        });

        bankTransaction = transaction;
      } catch (bankError) {
        console.error("Error creating bank transaction:", bankError);
      }
    }

    // Liquidate encumbrance if expense is being paid and has budget
    if (isBeingPaid && expense.budget_id) {
      try {
        if (expense.encumbrance_id) {
          await BudgetService.liquidateEncumbranceFromExpense(
            expense,
            req.user._id,
            {
              document_type: "expense_payment",
              document_id: expense._id.toString(),
              document_number:
                expense.reference_no ||
                `EXP-${expense._id.toString().slice(-5)}`,
              date: new Date(),
              notes: "Expense marked as paid",
            },
          );
        }
      } catch (encErr) {
        console.error('Error liquidating encumbrance on update:', encErr);
      }
    }

    res.json({
      success: true,
      data: expense,
      bankTransaction: bankTransaction,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete expense
// @route   DELETE /api/expenses/:id
// @access  Private
exports.deleteExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const expense = await Expense.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }

    // Soft delete - mark as cancelled
    expense.status = "cancelled";
    await expense.save();

    res.json({
      success: true,
      message: "Expense cancelled",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reverse an expense
// @route   POST /api/expenses/:id/reverse
// @access  Private
exports.reverseExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reason } = req.body;

    const expense = await Expense.findOne({
      _id: req.params.id,
      company: companyId,
    }).populate("expense_account_id", "code name");

    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }

    if (expense.status === "reversed") {
      return res
        .status(400)
        .json({ success: false, message: "Expense already reversed" });
    }

    // Create reversal journal entry
    let reversalJournalEntry = null;
    if (expense.journal_entry_id) {
      try {
        const originalEntry = await JournalEntry.findById(expense.journal_entry_id);

        if (originalEntry && Array.isArray(originalEntry.lines) && originalEntry.lines.length >= 2) {
          const reversalLines = originalEntry.lines.map((line) => ({
            accountCode: line.accountCode,
            accountName: line.accountName,
            description: `REVERSAL: ${line.description || expense.description}`,
            debit: line.credit || 0,
            credit: line.debit || 0,
          }));

          reversalJournalEntry = await JournalEntry.create({
            company: companyId,
            date: new Date(),
            description: `Expense Reversal - ${expense.description} - EXP#${expense.reference_no}`,
            sourceType: "expense_reversal",
            sourceId: `expense_reversal_${companyId}_${expense._id}`,
            sourceReference: expense.reference_no,
            reference: expense.reference_no,
            status: "posted",
            lines: reversalLines,
            postedBy: req.user._id,
            createdBy: req.user._id,
            isAutoGenerated: false,
            _skipAutoBankSync: expense.payment_method === "bank" && Boolean(expense.bank_account_id),
            bankAccountId: expense.bank_account_id || undefined,
            notes: reason || `Reversal of expense ${expense.reference_no}`,
          });
        }
      } catch (journalError) {
        console.error("Error creating reversal journal entry:", journalError);
        return res.status(500).json({
          success: false,
          message: "Failed to create reversal journal entry",
          error: journalError.message,
        });
      }
    }

    if (!reversalJournalEntry) {
      return res.status(400).json({
        success: false,
        message: "Cannot reverse expense without a posted journal entry",
      });
    }

    // Restore bank account balance if applicable
    if (expense.payment_method === "bank" && expense.bank_account_id) {
      const bankAccount = await BankAccount.findOne({
        _id: expense.bank_account_id,
        company: companyId,
      });
      if (bankAccount) {
        bankAccount.currentBalance = (bankAccount.currentBalance || 0) + (expense.total_amount || 0);
        await bankAccount.save();
      }
    }

    // Update expense status to reversed
    expense.status = "reversed";
    expense.reversal_journal_entry_id = reversalJournalEntry
      ? reversalJournalEntry._id
      : null;
    await expense.save();

    res.json({
      success: true,
      message: "Expense reversed successfully",
      data: expense,
      reversalJournalEntry: reversalJournalEntry,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get expense summary by type for a period
// @route   GET /api/expenses/summary
// @access  Private
exports.getExpenseSummary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate } = req.query;

    const match = {
      company: companyId,
      status: { $ne: "cancelled" },
    };

    if (startDate || endDate) {
      match.expenseDate = {};
      if (startDate) match.expenseDate.$gte = new Date(startDate);
      if (endDate) match.expenseDate.$lte = new Date(endDate);
    }

    const summary = await Expense.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$type",
          total: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]);

    // Transform to object
    const result = {
      salariesWages: 0,
      rent: 0,
      utilities: 0,
      transportDelivery: 0,
      marketingAdvertising: 0,
      otherExpenses: 0,
      interestIncome: 0,
      otherIncome: 0,
      totalOperating: 0,
      totalOtherIncome: 0,
    };

    summary.forEach((item) => {
      const type = item._id;
      const total = item.total;

      switch (type) {
        case "salaries_wages":
          result.salariesWages = total;
          result.totalOperating += total;
          break;
        case "rent":
          result.rent = total;
          result.totalOperating += total;
          break;
        case "utilities":
          result.utilities = total;
          result.totalOperating += total;
          break;
        case "transport_delivery":
          result.transportDelivery = total;
          result.totalOperating += total;
          break;
        case "marketing_advertising":
          result.marketingAdvertising = total;
          result.totalOperating += total;
          break;
        case "other_expense":
          result.otherExpenses = total;
          result.totalOperating += total;
          break;
        case "interest_income":
          result.interestIncome = total;
          result.totalOtherIncome += total;
          break;
        case "other_income":
          result.otherIncome = total;
          result.totalOtherIncome += total;
          break;
      }
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get expense accounts for dropdown
// @route   GET /api/expenses/accounts
// @access  Private
exports.getExpenseAccounts = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    // Debug: Log company ID
    console.log(
      `[ExpenseController] Fetching accounts for company: ${companyId}`,
    );

    // Fetch ALL active accounts for debugging
    const allAccounts = await ChartOfAccount.find({
      company: companyId,
      isActive: true,
    })
      .select("_id code name type")
      .sort({ code: 1 });

    console.log(
      `[ExpenseController] Total active accounts: ${allAccounts.length}`,
    );

    // Filter for expense accounts
    const accounts = allAccounts.filter(
      (acc) => acc.type === "expense" || acc.type === "cogs",
    );

    // Debug: Log count
    console.log(
      `[ExpenseController] Found ${accounts.length} expense accounts`,
    );

    res.json({
      success: true,
      data: accounts,
    });
  } catch (error) {
    console.error(
      "[ExpenseController] Error fetching expense accounts:",
      error,
    );
    next(error);
  }
};

// @desc    Bulk create expenses
// @route   POST /api/expenses/bulk
// @access  Private
exports.bulkCreateExpenses = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { expenses } = req.body;

    if (!expenses || !Array.isArray(expenses) || expenses.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No expenses provided" });
    }

    const createdExpenses = await Promise.all(
      expenses.map(async (expenseData) => {
        const expense = new Expense({
          ...expenseData,
          company: companyId,
          createdBy: req.user._id,
        });
        await expense.save();
        return expense;
      }),
    );

    res.status(201).json({
      success: true,
      count: createdExpenses.length,
      data: createdExpenses,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Approve an expense
// @route   PUT /api/expenses/:id/approve
// @access  Private
exports.approveExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const expenseId = req.params.id;
    const userId = req.user._id;

    const expense = await Expense.findOne({
      _id: expenseId,
      company: companyId,
    });

    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }

    if (expense.status !== "pending") {
      return res
        .status(400)
        .json({
          success: false,
          message: `Expense is already ${expense.status}`,
        });
    }

    expense.status = "approved";
    expense.approvedBy = userId;
    expense.approvedAt = new Date();

    await expense.save();

    // Log the approval action
    await AuditService.logExpenseAction({
      companyId,
      userId,
      action: 'approved',
      expenseId: expense._id,
      changes: { status: 'approved', previousStatus: 'pending' },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    res.json({
      success: true,
      data: expense,
      message: "Expense approved successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reject an expense
// @route   PUT /api/expenses/:id/reject
// @access  Private
exports.rejectExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const expenseId = req.params.id;
    const { reason } = req.body;

    const expense = await Expense.findOne({
      _id: expenseId,
      company: companyId,
    });

    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }

    if (expense.status !== "pending") {
      return res
        .status(400)
        .json({
          success: false,
          message: `Expense is already ${expense.status}`,
        });
    }

    expense.status = "rejected";
    expense.rejectedBy = req.user._id;
    expense.rejectedAt = new Date();
    expense.rejectionReason = reason || "No reason provided";

    await expense.save();

    res.json({
      success: true,
      data: expense,
      message: "Expense rejected successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Post an approved expense (create journal entries)
// @route   PUT /api/expenses/:id/post
// @access  Private
exports.postExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const expenseId = req.params.id;
    const { bankAccountId } = req.body;

    const expense = await Expense.findOne({
      _id: expenseId,
      company: companyId,
    });

    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }

    if (expense.status !== "approved" && expense.status !== "pending") {
      return res
        .status(400)
        .json({
          success: false,
          message: `Cannot post expense with status: ${expense.status}`,
        });
    }

    // Create Journal Entry
    const bankPaymentMethods = ["bank_transfer", "cheque", "mobile_money", "bank", "cash", "petty_cash", "credit_card", "payable"];
    let bankAccountCode = null;
    let bankAccount = null;

    if (bankAccountId && bankPaymentMethods.includes(expense.payment_method)) {
      try {
        bankAccount = await BankAccount.findOne({
          _id: bankAccountId,
          company: companyId,
          isActive: true,
        });
        if (bankAccount) {
          bankAccountCode = bankAccount.accountCode;
        }
      } catch (err) {
        console.error("Error fetching bank account for posting:", err);
      }
    }

    // Get expense account code for proper journal posting
    let expenseAccountCode = null;
    try {
      const expenseAccount = await ChartOfAccount.findById(expense.expense_account_id);
      if (expenseAccount) {
        expenseAccountCode = expenseAccount.code;
      }
    } catch (err) {
      console.error("Error fetching expense account:", err);
    }

    try {
      await JournalService.createExpenseEntry(companyId, req.user.id, {
        _id: expense._id,
        description: expense.description || expense.type,
        date: expense.expenseDate || new Date(),
        amount: expense.total_amount || (expense.amount + (expense.tax_amount || 0)),
        vatAmount: expense.tax_amount || 0,
        withholdingTax: expense.withholdingTax || 0,
        category: expense.type,
        paymentMethod: expense.payment_method,
        bankAccountCode: bankAccountCode,
        expenseAccountCode: expenseAccountCode,
      });
    } catch (journalError) {
      console.error("Error creating journal entry for expense:", journalError);
      return res
        .status(500)
        .json({ success: false, message: "Failed to create journal entry" });
    }

    // Create Bank Transaction
    if (bankAccount && bankPaymentMethods.includes(expense.payment_method)) {
      try {
        const totalAmount = expense.total_amount || (expense.amount + (expense.tax_amount || 0));
        const netPaid = totalAmount - (expense.withholdingTax || 0);
        // Use addTransaction which properly handles cachedBalance
        await bankAccount.addTransaction({
          type: "withdrawal",
          amount: netPaid,
          description: `Expense paid: ${expense.description || expense.type}`,
          date: new Date(),
          referenceNumber: expense.reference || "",
          paymentMethod: expense.payment_method,
          status: "completed",
          reference: expense._id,
          referenceType: "Expense",
          createdBy: req.user._id,
          notes: `Payment for expense: ${expense.description || expense.type}`,
        });
      } catch (bankError) {
        console.error(
          "Error creating bank transaction for expense:",
          bankError,
        );
        // We might want to rollback journal entry here, but for now just log
      }
    }

    expense.status = "posted";
    await expense.save();

    // Liquidate encumbrance using BudgetService
    if (expense.budget_id && expense.encumbrance_id) {
      try {
        const BudgetService = require('../services/budgetService');
        await BudgetService.liquidateEncumbranceFromExpense(expense, req.user._id, {
          document_type: 'payment',
          document_id: expense._id.toString(),
          document_number: expense.reference_no,
          notes: 'Expense posted and paid'
        });
      } catch (encErr) {
        console.error('Error liquidating encumbrance:', encErr);
      }
    }

    // Check if budget is fully spent and auto-lock if necessary
    if (expense.budget_id) {
      try {
        const BudgetService = require('../services/budgetService');
        const lockResult = await BudgetService.checkAndAutoLockIfSpent(companyId, expense.budget_id);
        if (lockResult && lockResult.locked) {
          console.log('[postExpense] Budget auto-locked:', lockResult.message);
        }
      } catch (lockErr) {
        console.error('Error checking auto-lock:', lockErr);
      }
    }

    res.json({
      success: true,
      data: expense,
      message: "Expense posted successfully",
    });
  } catch (error) {
    next(error);
  }
};
