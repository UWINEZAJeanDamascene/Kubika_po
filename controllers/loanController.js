const Loan = require("../models/Loan");
const { parsePagination, paginationMeta } = require("../utils/pagination");
const JournalService = require("../services/journalService");
const ChartOfAccount = require("../models/ChartOfAccount");
const { BankAccount } = require("../models/BankAccount");
const JournalEntry = require("../models/JournalEntry");
const SequenceService = require("../services/sequenceService");
const PeriodService = require("../services/periodService");
const {
  CHART_OF_ACCOUNTS,
  DEFAULT_ACCOUNTS,
} = require("../constants/chartOfAccounts");

const LOAN_TX_REF_PREFIX = {
  drawdown: "LDR",
  repayment: "LRP",
  interest_charge: "LIC",
};

async function nextLoanTxReference(companyId, type) {
  const prefix = LOAN_TX_REF_PREFIX[type] || "LTX";
  const year = new Date().getFullYear();
  const seq = await SequenceService.nextSequence(companyId, `loan_tx_${type}`, {
    year,
  });
  return `${prefix}-${year}-${seq}`;
}

async function resolveLoanTxReference(companyId, type, explicit) {
  const trimmed = explicit != null ? String(explicit).trim() : "";
  if (trimmed) return trimmed;
  return nextLoanTxReference(companyId, type);
}

// =====================================================
// PAYMENT SCHEDULE CALCULATION (HELPER FUNCTIONS)
// =====================================================

/**
 * Calculate monthly payment using amortization formula
 * PMT = P * [r(1+r)^n] / [(1+r)^n - 1]
 * Where:
 *   P = Principal (loan amount)
 *   r = Monthly interest rate (annual rate / 12)
 *   n = Number of payments (months)
 */
function calculateMonthlyPayment(
  principal,
  annualRate,
  months,
  method = "simple",
) {
  if (months <= 0) return 0;
  if (principal <= 0) return 0;

  const monthlyRate = annualRate / 100 / 12;

  if (monthlyRate === 0) {
    // No interest - simple division
    return principal / months;
  }

  if (method === "simple") {
    // Simple interest: Interest = Principal * Rate * Time
    const totalInterest = principal * (annualRate / 100) * (months / 12);
    return (principal + totalInterest) / months;
  }

  // Compound interest (amortized)
  const factor = Math.pow(1 + monthlyRate, months);
  return (principal * (monthlyRate * factor)) / (factor - 1);
}

/**
 * Generate payment schedule for a loan
 */
function generatePaymentSchedule(loan) {
  const schedule = [];
  const principal = loan.originalAmount;
  const annualRate = loan.interestRate || 0;
  const months = loan.durationMonths || 12;
  const method = loan.interestMethod || "simple";
  const startDate = loan.startDate ? new Date(loan.startDate) : new Date();

  const monthlyPayment = calculateMonthlyPayment(
    principal,
    annualRate,
    months,
    method,
  );
  let remainingBalance = principal;
  let totalInterest = 0;

  for (let month = 1; month <= months; month++) {
    const paymentDate = new Date(startDate);
    paymentDate.setMonth(paymentDate.getMonth() + month);

    // Calculate interest for this period
    let interestPortion;
    if (method === "simple") {
      interestPortion = (principal * (annualRate / 100)) / 12;
    } else {
      interestPortion = remainingBalance * (annualRate / 100 / 12);
    }

    // Principal portion
    let principalPortion = monthlyPayment - interestPortion;

    // Last payment adjustment
    if (month === months) {
      principalPortion = remainingBalance;
    }

    remainingBalance = Math.max(0, remainingBalance - principalPortion);
    totalInterest += interestPortion;

    schedule.push({
      paymentNumber: month,
      paymentDate: paymentDate.toISOString().split("T")[0],
      principalPortion: Math.round(principalPortion * 100) / 100,
      interestPortion: Math.round(interestPortion * 100) / 100,
      totalPayment:
        Math.round((principalPortion + interestPortion) * 100) / 100,
      remainingBalance: Math.round(remainingBalance * 100) / 100,
    });
  }

  return {
    monthlyPayment: Math.round(monthlyPayment * 100) / 100,
    totalPayment: Math.round(monthlyPayment * months * 100) / 100,
    totalInterest: Math.round(totalInterest * 100) / 100,
    schedule,
  };
}

// @desc    Get all loans for a company
// @route   GET /api/loans
// @access  Private
exports.getLoans = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { status, loanType } = req.query;

    const query = { company: companyId };
    if (status) query.status = status;
    if (loanType) query.loanType = loanType;

    const { page, limit, skip } = parsePagination(req.query);
    const [total, agg, loans] = await Promise.all([
      Loan.countDocuments(query),
      Loan.aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            totalOriginal: { $sum: { $ifNull: ["$originalAmount", 0] } },
            totalPaid: { $sum: { $ifNull: ["$amountPaid", 0] } },
            totalOutstanding: { $sum: { $ifNull: ["$outstandingBalance", 0] } },
          },
        },
      ]),
      Loan.find(query)
        .populate("createdBy", "name email")
        .sort({ startDate: -1 })
        .skip(skip)
        .limit(limit),
    ]);

    const s = agg[0] || {};

    res.json({
      success: true,
      count: loans.length,
      data: loans,
      pagination: paginationMeta(page, limit, total),
      summary: {
        totalOriginal: s.totalOriginal || 0,
        totalPaid: s.totalPaid || 0,
        totalOutstanding: s.totalOutstanding || 0,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single loan
// @route   GET /api/loans/:id
// @access  Private
exports.getLoan = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const loan = await Loan.findOne({ _id: req.params.id, company: companyId })
      .populate("createdBy", "name email")
      .populate("payments.recordedBy", "name email");

    if (!loan) {
      return res
        .status(404)
        .json({ success: false, message: "Loan not found" });
    }

    // Resolve account names for display
    const loanData = loan.toObject();

    if (loan.liabilityAccountId) {
      const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(
        String(loan.liabilityAccountId),
      );
      let liabAccount;

      if (isValidObjectId) {
        try {
          liabAccount = await ChartOfAccount.findOne({
            _id: loan.liabilityAccountId,
            company: companyId,
          });
        } catch (e) {
          liabAccount = null;
        }
      }

      if (!liabAccount) {
        liabAccount = await ChartOfAccount.findOne({
          code: String(loan.liabilityAccountId),
          company: companyId,
        });
      }

      if (liabAccount) {
        loanData.liabilityAccountId = {
          _id: liabAccount._id,
          code: liabAccount.code,
          name: liabAccount.name,
        };
      }
    }

    if (loan.interestExpenseAccountId) {
      const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(
        String(loan.interestExpenseAccountId),
      );
      let intAccount;

      if (isValidObjectId) {
        try {
          intAccount = await ChartOfAccount.findOne({
            _id: loan.interestExpenseAccountId,
            company: companyId,
          });
        } catch (e) {
          intAccount = null;
        }
      }

      if (!intAccount) {
        intAccount = await ChartOfAccount.findOne({
          code: String(loan.interestExpenseAccountId),
          company: companyId,
        });
      }

      if (intAccount) {
        loanData.interestExpenseAccountId = {
          _id: intAccount._id,
          code: intAccount.code,
          name: intAccount.name,
        };
      }
    }

    res.json({ success: true, data: loanData });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new loan
// @route   POST /api/loans
// @access  Private
exports.createLoan = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { name, loanType, originalAmount, startDate, liabilityAccountId } =
      req.body;

    // Input validation
    if (!name || !name.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Liability name is required" });
    }

    if (!loanType) {
      return res
        .status(400)
        .json({ success: false, message: "Loan type is required" });
    }

    if (!originalAmount || originalAmount <= 0) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Original amount must be greater than 0",
        });
    }

    if (!startDate) {
      return res
        .status(400)
        .json({ success: false, message: "Start date is required" });
    }

    if (!liabilityAccountId) {
      return res
        .status(400)
        .json({ success: false, message: "Liability account is required" });
    }

    // Validate liability account exists
    let liabilityAccount;
    // Check if liabilityAccountId is a valid MongoDB ObjectId format (24 hex chars)
    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(
      String(liabilityAccountId),
    );

    // Try to find by ObjectId first (only if valid format)
    if (isValidObjectId) {
      liabilityAccount = await ChartOfAccount.findOne({
        _id: liabilityAccountId,
        company: companyId,
      });
    }

    // If not found, try by account code
    if (!liabilityAccount) {
      liabilityAccount = await ChartOfAccount.findOne({
        code: String(liabilityAccountId),
        company: companyId,
      });
    }

    // If still not found, check if it's a default account code from CHART_OF_ACCOUNTS
    if (!liabilityAccount && CHART_OF_ACCOUNTS[liabilityAccountId]) {
      const defaultAccount = CHART_OF_ACCOUNTS[liabilityAccountId];
      // Create a virtual account object for default accounts
      liabilityAccount = {
        _id: liabilityAccountId,
        code: liabilityAccountId,
        name: defaultAccount.name,
        type: defaultAccount.type,
        isDefault: true,
      };
    }

    if (!liabilityAccount) {
      return res
        .status(400)
        .json({
          success: false,
          message:
            "Liability account not found. Please select a valid account.",
        });
    }

    // Validate interest expense account if provided
    if (
      req.body.interestExpenseAccountId &&
      req.body.interestExpenseAccountId !== ""
    ) {
      let interestAccount;
      const interestIsValidObjectId = /^[0-9a-fA-F]{24}$/.test(
        String(req.body.interestExpenseAccountId),
      );

      if (interestIsValidObjectId) {
        interestAccount = await ChartOfAccount.findOne({
          _id: req.body.interestExpenseAccountId,
          company: companyId,
        });
      }
      if (!interestAccount) {
        interestAccount = await ChartOfAccount.findOne({
          code: String(req.body.interestExpenseAccountId),
          company: companyId,
        });
      }

      // If still not found, check if it's a default account code from CHART_OF_ACCOUNTS
      if (
        !interestAccount &&
        CHART_OF_ACCOUNTS[req.body.interestExpenseAccountId]
      ) {
        const defaultAccount =
          CHART_OF_ACCOUNTS[req.body.interestExpenseAccountId];
        interestAccount = {
          _id: req.body.interestExpenseAccountId,
          code: req.body.interestExpenseAccountId,
          name: defaultAccount.name,
          type: defaultAccount.type,
          isDefault: true,
        };
      }

      if (!interestAccount) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Interest expense account not found. Please select a valid account.",
          });
      }
    }

    const loan = await Loan.create({
      ...req.body,
      company: companyId,
      createdBy: req.user._id,
      outstandingBalance: req.body.outstandingBalance || originalAmount,
    });

    // Calculate and set monthly payment if duration and interest rate are provided
    if (loan.originalAmount && loan.durationMonths && loan.durationMonths > 0) {
      const schedule = generatePaymentSchedule(loan);
      loan.monthlyPayment = schedule.monthlyPayment;
      await loan.save();
    }

    // Create journal entry for the liability (DR Bank / CR Liability)
    // This recognizes the loan amount as both an asset (bank) and liability
    try {
      // Get liability account
      let liabilityAccount;
      const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(String(liabilityAccountId));
      
      if (isValidObjectId) {
        liabilityAccount = await ChartOfAccount.findOne({
          _id: liabilityAccountId,
          company: companyId,
        });
      }
      if (!liabilityAccount) {
        liabilityAccount = await ChartOfAccount.findOne({
          code: String(liabilityAccountId),
          company: companyId,
        });
      }
      if (!liabilityAccount && CHART_OF_ACCOUNTS[liabilityAccountId]) {
        const defaultAccount = CHART_OF_ACCOUNTS[liabilityAccountId];
        liabilityAccount = {
          _id: liabilityAccountId,
          code: liabilityAccountId,
          name: defaultAccount.name,
          type: defaultAccount.type,
          isDefault: true,
        };
      }

      if (liabilityAccount) {
        const entryDate = startDate ? new Date(startDate) : new Date();
        
        // Get bank account if provided (for initial drawdown)
        let bankAccount = null;
        if (req.body.bankAccountId) {
          bankAccount = await BankAccount.findOne({
            _id: req.body.bankAccountId,
            company: companyId,
          });
        }

        const bankLedgerCode = bankAccount?.ledgerAccountId || DEFAULT_ACCOUNTS.cashAtBank;

        // Create journal entry: DR Bank / CR Liability
        const je = await JournalService.createEntry(companyId, req.user._id, {
          date: entryDate,
          description: `Liability Created - ${loan.name} (${loan.loanNumber})`,
          sourceType: "liability_drawdown",
          sourceId: loan._id,
          sourceReference: loan.loanNumber,
          lines: [
            JournalService.createDebitLine(bankLedgerCode, originalAmount, `Liability funding - ${loan.name}`),
            JournalService.createCreditLine(liabilityAccount.code, originalAmount, `Liability recognized - ${loan.name}`),
          ],
          isAutoGenerated: true,
        });

        // Create BankTransaction if bank account provided
        if (bankAccount) {
          try {
            await bankAccount.addTransaction({
              type: "deposit",
              amount: originalAmount,
              description: `Loan funding: ${loan.name}`,
              date: entryDate,
              referenceNumber: loan.loanNumber,
              referenceType: "Loan",
              reference: loan._id,
              createdBy: req.user._id,
              journalEntryId: je._id,
            });
            bankAccount.cacheValid = false;
            await bankAccount.save();
          } catch (btErr) {
            console.error("BankTransaction creation failed for loan:", btErr.message);
          }
        }

        // Add initial drawdown transaction to loan
        loan.transactions.push({
          transactionDate: entryDate,
          type: "drawdown",
          amount: originalAmount,
          principalPortion: originalAmount,
          interestPortion: 0,
          bankAccountId: bankAccount?._id,
          journalEntryId: je._id,
          reference: await nextLoanTxReference(companyId, "drawdown"),
          notes: "Initial loan funding",
        });
        await loan.save();
      }
    } catch (journalErr) {
      console.error("Journal entry creation failed for loan:", journalErr.message);
      // Non-fatal - loan is created, journal entry creation failed
    }

    res.status(201).json({ success: true, data: loan });
  } catch (error) {
    // Handle duplicate loan number error
    if (error.code === 11000) {
      return res
        .status(400)
        .json({
          success: false,
          message: "A loan with this number already exists",
        });
    }
    next(error);
  }
};

// @desc    Update loan
// @route   PUT /api/loans/:id
// @access  Private
exports.updateLoan = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      name,
      originalAmount,
      liabilityAccountId,
      interestExpenseAccountId,
      status,
    } = req.body;

    let loan = await Loan.findOne({ _id: req.params.id, company: companyId });

    if (!loan) {
      return res
        .status(404)
        .json({ success: false, message: "Loan not found" });
    }

    // Prevent updating certain fields if loan has transactions
    if (loan.transactions && loan.transactions.length > 0) {
      // Allow status, notes, and IFRS 7 disclosure fields (these don't affect financial calculations)
      const allowedFields = [
        "status",
        "notes",
        // IFRS 7.33 Classification
        "isSecured",
        "securityDescription",
        "classification",
        // IFRS 7.34 Currency
        "currencyCode",
        "exchangeRate",
        // IAS 1.74 Covenant tracking
        "hasCovenants",
        "covenantDetails",
        "covenantBreach",
        "covenantBreachDate"
      ];
      const updatedFields = Object.keys(req.body);
      const hasDisallowedFields = updatedFields.some(
        (field) => !allowedFields.includes(field),
      );

      if (hasDisallowedFields) {
        return res.status(400).json({
          success: false,
          message:
            "Cannot update loan details once transactions exist. Only status, notes, and IFRS 7 disclosure fields can be updated.",
        });
      }
    }

    // Validate liability account if being updated
    if (
      liabilityAccountId &&
      liabilityAccountId !== loan.liabilityAccountId?.toString()
    ) {
      let liabilityAccount;
      try {
        liabilityAccount = await ChartOfAccount.findOne({
          _id: liabilityAccountId,
          company: companyId,
        });
      } catch (e) {
        liabilityAccount = await ChartOfAccount.findOne({
          code: String(liabilityAccountId),
          company: companyId,
        });
      }

      if (!liabilityAccount) {
        return res
          .status(400)
          .json({ success: false, message: "Liability account not found" });
      }
    }

    // Validate interest expense account if being updated
    if (
      interestExpenseAccountId &&
      interestExpenseAccountId !== loan.interestExpenseAccountId?.toString()
    ) {
      let interestAccount;
      try {
        interestAccount = await ChartOfAccount.findOne({
          _id: interestExpenseAccountId,
          company: companyId,
        });
      } catch (e) {
        interestAccount = await ChartOfAccount.findOne({
          code: String(interestExpenseAccountId),
          company: companyId,
        });
      }

      if (!interestAccount) {
        return res
          .status(400)
          .json({
            success: false,
            message: "Interest expense account not found",
          });
      }
    }

    // If setting status to cancelled, check if loan has payments
    if (status === "cancelled" && loan.amountPaid > 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot cancel a loan with existing payments",
      });
    }

    loan = await Loan.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });

    res.json({ success: true, data: loan });
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel a loan/liability
// @route   POST /api/loans/:id/cancel
// @access  Private
exports.cancelLoan = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reason } = req.body;

    const loan = await Loan.findOne({ _id: req.params.id, company: companyId });

    if (!loan) {
      return res
        .status(404)
        .json({ success: false, message: "Loan not found" });
    }

    if (loan.status === "fully_repaid" || loan.status === "paid-off") {
      return res.status(400).json({
        success: false,
        message: "Cannot cancel a fully repaid loan",
      });
    }

    loan.status = "cancelled";
    if (reason) {
      loan.notes = (loan.notes || "") + `\nCancellation reason: ${reason}`;
    }

    await loan.save();

    res.json({
      success: true,
      data: loan,
      message: "Loan cancelled successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete loan
// @route   DELETE /api/loans/:id
// @access  Private
exports.deleteLoan = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const loan = await Loan.findOne({ _id: req.params.id, company: companyId });

    if (!loan) {
      return res
        .status(404)
        .json({ success: false, message: "Loan not found" });
    }

    // Check if there are any journal entries linked to this loan
    const linkedEntries = await JournalEntry.find({
      $or: [{ sourceId: loan._id.toString() }, { reference: loan.loanNumber }],
    });

    if (linkedEntries && linkedEntries.length > 0) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot delete loan with linked journal entries. Please reverse or delete the journal entries first.",
        linkedEntriesCount: linkedEntries.length,
      });
    }

    // Check if loan has transactions
    if (loan.transactions && loan.transactions.length > 0) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot delete loan with existing transactions. Consider marking it as cancelled instead.",
      });
    }

    // Check if loan has been partially paid
    if (loan.amountPaid > 0) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot delete loan with payments. Consider marking it as cancelled instead.",
      });
    }

    await Loan.findByIdAndDelete(req.params.id);

    res.json({ success: true, message: "Loan deleted successfully" });
  } catch (error) {
    next(error);
  }
};

// @desc    Record loan payment
// @route   POST /api/loans/:id/payment
// @access  Private
exports.recordPayment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { amount, paymentMethod, reference, notes } = req.body;

    const loan = await Loan.findOne({ _id: req.params.id, company: companyId });

    if (!loan) {
      return res
        .status(404)
        .json({ success: false, message: "Loan not found" });
    }

    // Add payment
    loan.payments.push({
      amount,
      paymentMethod,
      reference,
      notes,
      recordedBy: req.user._id,
      paymentDate: new Date(),
    });

    // Update amount paid
    loan.amountPaid += amount;

    // Check if fully paid
    if (loan.amountPaid >= loan.originalAmount) {
      loan.status = "paid-off";
    }

    await loan.save();

    // Create journal entry for loan payment
    try {
      await JournalService.createLoanPaymentEntry(companyId, req.user.id, {
        loanNumber: loan.loanNumber,
        date: new Date(),
        principalAmount: amount,
        interestAmount: req.body.interestAmount || 0,
        paymentMethod: paymentMethod,
      });
    } catch (journalError) {
      console.error(
        "Error creating journal entry for loan payment:",
        journalError,
      );
      // Don't fail the payment if journal entry fails
    }

    res.json({ success: true, data: loan });
  } catch (error) {
    next(error);
  }
};

// @desc    Get loans summary for Balance Sheet
// @route   GET /api/loans/summary
// @access  Private
exports.getLoansSummary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    // Get active loans
    const loans = await Loan.find({ company: companyId, status: "active" });

    // Separate by type
    const shortTermLoans = loans.filter(
      (loan) => loan.loanType === "short-term",
    );
    const longTermLoans = loans.filter((loan) => loan.loanType === "long-term");

    const shortTermTotal = shortTermLoans.reduce(
      (sum, loan) => sum + (loan.remainingBalance || 0),
      0,
    );
    const longTermTotal = longTermLoans.reduce(
      (sum, loan) => sum + (loan.remainingBalance || 0),
      0,
    );

    res.json({
      success: true,
      data: {
        shortTerm: {
          count: shortTermLoans.length,
          totalOutstanding: shortTermTotal,
        },
        longTerm: {
          count: longTermLoans.length,
          totalOutstanding: longTermTotal,
        },
        total: {
          count: loans.length,
          totalOutstanding: shortTermTotal + longTermTotal,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Record a drawdown (money received) for a liability
// @route   POST /api/loans/:id/drawdown
// @access  Private
exports.recordDrawdown = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { amount, bankAccountId, transactionDate, notes, reference } = req.body;

    // Input validation
    if (!amount || amount <= 0) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Drawdown amount must be greater than 0",
        });
    }

    if (!bankAccountId) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Bank account is required for drawdown",
        });
    }

    const loan = await Loan.findOne({ _id: req.params.id, company: companyId });

    if (!loan) {
      return res
        .status(404)
        .json({ success: false, message: "Liability not found" });
    }

    if (loan.status !== "active") {
      return res
        .status(400)
        .json({ success: false, message: "Liability is not active" });
    }

    // Validate bank account
    const bankAccount = await BankAccount.findOne({
      _id: bankAccountId,
      company: companyId,
    });
    if (!bankAccount) {
      return res
        .status(400)
        .json({ success: false, message: "Bank account not found" });
    }

    // Validate liability account exists - accept both ObjectId and account code
    if (!loan.liabilityAccountId) {
      return res
        .status(400)
        .json({
          success: false,
          message:
            "Liability account not configured for this loan. Please edit the loan to add a liability account.",
        });
    }
    let liabilityAccount;
    try {
      liabilityAccount = await ChartOfAccount.findOne({
        _id: loan.liabilityAccountId,
        company: companyId,
      });
    } catch (e) {
      // If not a valid ObjectId, try finding by account code
      liabilityAccount = await ChartOfAccount.findOne({
        code: String(loan.liabilityAccountId),
        company: companyId,
      });
    }
    if (!liabilityAccount) {
      return res
        .status(400)
        .json({
          success: false,
          message:
            "Liability account not found. The configured account may have been deleted. Please edit the loan to select a valid account.",
        });
    }

    // Create journal entry for drawdown
    // DR Bank / CR Liability Account
    const entryDate = transactionDate ? new Date(transactionDate) : new Date();

    // Validate date
    if (isNaN(entryDate.getTime())) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid transaction date" });
    }

    const entryNumber = await SequenceService.nextSequence(companyId, "JE");
    const period = await PeriodService.getOpenPeriodId(companyId, entryDate);

    // bankAccount.ledgerAccountId is a plain string code (e.g. '1100'), NOT an object.
    // Using ?.code would always return undefined — use the string directly.
    const bankLedgerCode = bankAccount.ledgerAccountId || "1100";

    const journalEntry = await JournalEntry.create({
      company: companyId,
      date: entryDate,
      description: `Liability Drawdown - ${loan.name} - ${loan.loanNumber}`,
      sourceType: "liability_drawdown",
      sourceId: `${loan._id}_drawdown_${entryDate.getTime()}`,
      sourceReference: loan.loanNumber,
      reference: loan.loanNumber,
      status: "posted",
      lines: [
        {
          accountCode: bankLedgerCode,
          accountName: bankAccount.name,
          description: "Drawdown proceeds received",
          debit: amount,
          credit: 0,
        },
        {
          accountCode: liabilityAccount.code,
          accountName: liabilityAccount.name,
          description: "Liability recognized",
          debit: 0,
          credit: amount,
        },
      ],
      createdBy: req.user._id,
      postedBy: req.user._id,
      period: period,
      isAutoGenerated: true,
      _skipAutoBankSync: true,
      bankAccountId: bankAccount._id,
    });

    // Create BankTransaction so the bank account balance increases immediately
    try {
      await bankAccount.addTransaction({
        type: "deposit",
        amount: amount,
        description: `Loan drawdown: ${loan.name} (${loan.loanNumber})`,
        date: entryDate,
        referenceNumber: loan.loanNumber,
        referenceType: "Payment",
        reference: loan._id,
        createdBy: req.user._id,
        notes: notes || `Liability drawdown — ${loan.loanNumber}`,
        journalEntryId: journalEntry._id,
      });
    } catch (btErr) {
      console.error(
        "BankTransaction creation failed for loan drawdown:",
        btErr.message,
      );
      // Non-fatal — journal entry already posted
    }

    // Add transaction record
    loan.transactions.push({
      transactionDate: entryDate,
      type: "drawdown",
      amount: amount,
      principalPortion: amount,
      interestPortion: 0,
      bankAccountId: bankAccount._id,
      journalEntryId: journalEntry._id,
      reference: await resolveLoanTxReference(companyId, "drawdown", reference),
      notes: notes,
    });

    // Update outstanding balance
    loan.outstandingBalance = (loan.outstandingBalance || 0) + amount;
    await loan.save();

    res.json({ success: true, data: loan, journalEntry });
  } catch (error) {
    next(error);
  }
};

// @desc    Record a repayment for a liability
// @route   POST /api/loans/:id/repayment
// @access  Private
exports.recordRepayment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      principalPortion,
      interestPortion,
      bankAccountId,
      transactionDate,
      notes,
      reference,
    } = req.body;

    // Input validation
    if (!principalPortion || principalPortion <= 0) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Principal portion must be greater than 0",
        });
    }

    if (!bankAccountId) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Bank account is required for repayment",
        });
    }

    const loan = await Loan.findOne({ _id: req.params.id, company: companyId });

    if (!loan) {
      return res
        .status(404)
        .json({ success: false, message: "Liability not found" });
    }

    if (loan.status !== "active") {
      return res
        .status(400)
        .json({ success: false, message: "Liability is not active" });
    }

    const totalPayment = principalPortion + (interestPortion || 0);

    if (principalPortion > loan.outstandingBalance) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Repayment exceeds outstanding balance",
        });
    }

    // Validate bank account
    const bankAccount = await BankAccount.findOne({
      _id: bankAccountId,
      company: companyId,
    });
    if (!bankAccount) {
      return res
        .status(400)
        .json({ success: false, message: "Bank account not found" });
    }

    // Validate liability account exists - accept both ObjectId and account code
    if (!loan.liabilityAccountId) {
      return res
        .status(400)
        .json({
          success: false,
          message:
            "Liability account not configured for this loan. Please edit the loan to add a liability account.",
        });
    }
    let liabilityAccount;
    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(
      String(loan.liabilityAccountId),
    );

    // Try to find by ObjectId first (only if valid format)
    if (isValidObjectId) {
      liabilityAccount = await ChartOfAccount.findOne({
        _id: loan.liabilityAccountId,
        company: companyId,
      });
    }

    // If not found, try by account code
    if (!liabilityAccount) {
      liabilityAccount = await ChartOfAccount.findOne({
        code: String(loan.liabilityAccountId),
        company: companyId,
      });
    }

    // If still not found, check if it's a default account code from CHART_OF_ACCOUNTS
    if (!liabilityAccount && CHART_OF_ACCOUNTS[loan.liabilityAccountId]) {
      const defaultAccount = CHART_OF_ACCOUNTS[loan.liabilityAccountId];
      liabilityAccount = {
        _id: loan.liabilityAccountId,
        code: loan.liabilityAccountId,
        name: defaultAccount.name,
        type: defaultAccount.type,
        isDefault: true,
      };
    }

    if (!liabilityAccount) {
      return res
        .status(400)
        .json({
          success: false,
          message:
            "Liability account not found. The configured account may have been deleted. Please edit the loan to select a valid account.",
        });
    }

    // Create journal entry for repayment
    const entryDate = transactionDate ? new Date(transactionDate) : new Date();
    const entryNumber = await SequenceService.nextSequence(companyId, "JE");
    const period = await PeriodService.getOpenPeriodId(companyId, entryDate);

    const journalLines = [
      {
        accountCode: liabilityAccount.code,
        accountName: liabilityAccount.name,
        description: "Principal repayment",
        debit: principalPortion,
        credit: 0,
      },
    ];

    // Add interest expense if present
    if (interestPortion > 0) {
      if (!loan.interestExpenseAccountId) {
        return res
          .status(400)
          .json({
            success: false,
            message: "Interest expense account not configured",
          });
      }
      const interestAccount = await ChartOfAccount.findOne({
        _id: loan.interestExpenseAccountId,
        company: companyId,
      });
      if (interestAccount) {
        journalLines.push({
          accountCode: interestAccount.code,
          accountName: interestAccount.name,
          description: "Interest expense",
          debit: interestPortion,
          credit: 0,
        });
      }
    }

    // bankAccount.ledgerAccountId is a plain string code, NOT an object — use directly.
    const repayBankLedgerCode = bankAccount.ledgerAccountId || "1100";

    // Add bank account line
    journalLines.push({
      accountCode: repayBankLedgerCode,
      accountName: bankAccount.name,
      description: "Payment to lender",
      debit: 0,
      credit: totalPayment,
    });

    const journalEntry = await JournalEntry.create({
      company: companyId,
      date: entryDate,
      description: `Liability Repayment - ${loan.name} - ${loan.loanNumber}`,
      sourceType: "liability_repayment",
      sourceId: `${loan._id}_repayment_${entryDate.getTime()}`,
      sourceReference: loan.loanNumber,
      reference: loan.loanNumber,
      status: "posted",
      lines: journalLines,
      createdBy: req.user._id,
      postedBy: req.user._id,
      period: period,
      isAutoGenerated: false,
      _skipAutoBankSync: true,
      bankAccountId: bankAccount._id,
    });

    // Create BankTransaction so the bank account balance decreases immediately
    try {
      await bankAccount.addTransaction({
        type: "withdrawal",
        amount: totalPayment,
        description: `Loan repayment: ${loan.name} (${loan.loanNumber})`,
        date: entryDate,
        referenceNumber: loan.loanNumber,
        referenceType: "Payment",
        reference: loan._id,
        createdBy: req.user._id,
        notes: notes || `Liability repayment — ${loan.loanNumber}`,
        journalEntryId: journalEntry._id,
      });
    } catch (btErr) {
      console.error(
        "BankTransaction creation failed for loan repayment:",
        btErr.message,
      );
      // Non-fatal — journal entry already posted
    }

    // Add transaction record
    loan.transactions.push({
      transactionDate: entryDate,
      type: "repayment",
      amount: totalPayment,
      principalPortion: principalPortion,
      interestPortion: interestPortion || 0,
      bankAccountId: bankAccount._id,
      journalEntryId: journalEntry._id,
      reference: await resolveLoanTxReference(companyId, "repayment", reference),
      notes: notes,
    });

    // Update outstanding balance and amount paid
    loan.outstandingBalance = (loan.outstandingBalance || 0) - principalPortion;
    loan.amountPaid = (loan.amountPaid || 0) + principalPortion;

    // Check if fully repaid
    if (loan.outstandingBalance <= 0.01) {
      loan.status = "fully_repaid";
      loan.outstandingBalance = 0;
    }

    await loan.save();

    res.json({ success: true, data: loan, journalEntry });
  } catch (error) {
    next(error);
  }
};

// @desc    Record an interest charge (accrual)
// @route   POST /api/loans/:id/interest
// @access  Private
exports.recordInterest = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { amount, chargeDate, notes, reference } = req.body;

    // Input validation
    if (!amount || amount <= 0) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Interest amount must be greater than 0",
        });
    }

    const loan = await Loan.findOne({ _id: req.params.id, company: companyId });

    if (!loan) {
      return res
        .status(404)
        .json({ success: false, message: "Liability not found" });
    }

    if (loan.status !== "active") {
      return res
        .status(400)
        .json({ success: false, message: "Liability is not active" });
    }

    // Validate liability account exists
    if (!loan.liabilityAccountId) {
      return res
        .status(400)
        .json({
          success: false,
          message:
            "Liability account not configured for this loan. Please edit the loan to add a liability account.",
        });
    }
    let liabilityAccount;
    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(
      String(loan.liabilityAccountId),
    );

    // Try to find by ObjectId first (only if valid format)
    if (isValidObjectId) {
      liabilityAccount = await ChartOfAccount.findOne({
        _id: loan.liabilityAccountId,
        company: companyId,
      });
    }

    // If not found, try by account code
    if (!liabilityAccount) {
      liabilityAccount = await ChartOfAccount.findOne({
        code: String(loan.liabilityAccountId),
        company: companyId,
      });
    }

    // If still not found, check if it's a default account code from CHART_OF_ACCOUNTS
    if (!liabilityAccount && CHART_OF_ACCOUNTS[loan.liabilityAccountId]) {
      const defaultAccount = CHART_OF_ACCOUNTS[loan.liabilityAccountId];
      liabilityAccount = {
        _id: loan.liabilityAccountId,
        code: loan.liabilityAccountId,
        name: defaultAccount.name,
        type: defaultAccount.type,
        isDefault: true,
      };
    }

    if (!liabilityAccount) {
      return res
        .status(400)
        .json({
          success: false,
          message:
            "Liability account not found. The configured account may have been deleted. Please edit the loan to select a valid account.",
        });
    }

    // Validate interest expense account if configured
    let interestAccount = null;
    if (loan.interestExpenseAccountId && loan.interestExpenseAccountId !== "") {
      const interestIsValidObjectId = /^[0-9a-fA-F]{24}$/.test(
        String(loan.interestExpenseAccountId),
      );

      if (interestIsValidObjectId) {
        interestAccount = await ChartOfAccount.findOne({
          _id: loan.interestExpenseAccountId,
          company: companyId,
        });
      }
      if (!interestAccount) {
        interestAccount = await ChartOfAccount.findOne({
          code: String(loan.interestExpenseAccountId),
          company: companyId,
        });
      }

      // If still not found, check if it's a default account code from CHART_OF_ACCOUNTS
      if (
        !interestAccount &&
        CHART_OF_ACCOUNTS[loan.interestExpenseAccountId]
      ) {
        const defaultAccount = CHART_OF_ACCOUNTS[loan.interestExpenseAccountId];
        interestAccount = {
          _id: loan.interestExpenseAccountId,
          code: loan.interestExpenseAccountId,
          name: defaultAccount.name,
          type: defaultAccount.type,
          isDefault: true,
        };
      }
    }

    const entryDate = chargeDate ? new Date(chargeDate) : new Date();

    // Create journal entry only if interest expense account is configured.
    //
    // IAS 23 / IAS 39 correct entries for interest accrual:
    //   DR  Interest Expense (6000)          — recognise expense in P&L
    //   CR  Accrued Interest Payable (2800)  — current liability on balance sheet
    //
    // The credit goes to 2800 Accrued Interest, NOT to the loan principal account.
    // Accruing interest does NOT increase the outstanding principal balance.
    // When the accrued interest is subsequently paid, record:
    //   DR  Accrued Interest Payable (2800) / CR Bank
    // (this is handled in recordRepayment by passing interestPortion separately)
    let journalEntry = null;
    if (interestAccount) {
      const entryNumber = await SequenceService.nextSequence(companyId, "JE");
      const period = await PeriodService.getOpenPeriodId(companyId, entryDate);

      // Accrued Interest Payable — use 2800 from chart of accounts
      const accruedInterestCode = DEFAULT_ACCOUNTS.accruedInterest || "2800";

      journalEntry = await JournalEntry.create({
        company: companyId,
        date: entryDate,
        description: `Interest Accrual - ${loan.name} - ${loan.loanNumber}`,
        sourceType: "liability_interest",
        sourceId: `${loan._id}_interest_${entryDate.getTime()}`,
        sourceReference: loan.loanNumber,
        reference: loan.loanNumber,
        status: "posted",
        lines: [
          {
            accountCode: interestAccount.code,
            accountName: interestAccount.name,
            description: "Interest expense accrued",
            debit: amount,
            credit: 0,
          },
          {
            accountCode: accruedInterestCode,
            accountName:
              CHART_OF_ACCOUNTS[accruedInterestCode]?.name ||
              "Accrued Interest",
            description: "Interest accrued — payable to lender",
            debit: 0,
            credit: amount,
          },
        ],
        createdBy: req.user._id,
        postedBy: req.user._id,
        period: period,
        isAutoGenerated: true,
      });
    }

    // Add transaction record
    loan.transactions.push({
      transactionDate: entryDate,
      type: "interest_charge",
      amount: amount,
      principalPortion: 0,
      interestPortion: amount,
      journalEntryId: journalEntry ? journalEntry._id : null,
      reference: await resolveLoanTxReference(
        companyId,
        "interest_charge",
        reference,
      ),
      notes: notes,
    });

    // NOTE: Interest accrual does NOT change outstanding principal balance.
    // outstandingBalance tracks principal only.
    // The accrued interest is now a separate current liability (2800 Accrued Interest Payable).
    await loan.save();

    res.json({ success: true, data: loan, journalEntry });
  } catch (error) {
    next(error);
  }
};

// @desc    Get liability transactions
// @route   GET /api/loans/:id/transactions
// @access  Private
exports.getTransactions = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const loan = await Loan.findOne({ _id: req.params.id, company: companyId })
      .populate("transactions.bankAccountId", "accountName accountNumber name")
      .populate("transactions.journalEntryId", "entryNumber date description");

    if (!loan) {
      return res
        .status(404)
        .json({ success: false, message: "Liability not found" });
    }

    const txs = (loan.transactions || []).map((tx) => {
      const plain = typeof tx.toObject === "function" ? tx.toObject() : { ...tx };
      const je = plain.journalEntryId;
      const jeNumber =
        je && typeof je === "object" ? je.entryNumber : null;
      return {
        ...plain,
        reference: plain.reference || jeNumber || null,
        journalEntryNumber: jeNumber || null,
      };
    });

    res.json({ success: true, data: txs });
  } catch (error) {
    next(error);
  }
};

// =====================================================
// PAYMENT SCHEDULE CALCULATION
// =====================================================

/**
 * Calculate monthly payment using amortization formula
 * PMT = P * [r(1+r)^n] / [(1+r)^n - 1]
 * Where:
 *   P = Principal (loan amount)
 *   r = Monthly interest rate (annual rate / 12)
 *   n = Number of payments (months)
 */
function calculateMonthlyPayment(
  principal,
  annualRate,
  months,
  method = "simple",
) {
  if (months <= 0) return 0;
  if (principal <= 0) return 0;

  const monthlyRate = annualRate / 100 / 12;

  if (monthlyRate === 0) {
    // No interest - simple division
    return principal / months;
  }

  if (method === "simple") {
    // Simple interest: Interest = Principal * Rate * Time
    const totalInterest = principal * (annualRate / 100) * (months / 12);
    return (principal + totalInterest) / months;
  }

  // Compound interest (amortized)
  const factor = Math.pow(1 + monthlyRate, months);
  return (principal * (monthlyRate * factor)) / (factor - 1);
}

/**
 * Generate payment schedule
 */
function generatePaymentSchedule(loan) {
  const schedule = [];
  const principal = loan.originalAmount;
  const annualRate = loan.interestRate || 0;
  const months = loan.durationMonths || 12;
  const method = loan.interestMethod || "simple";
  const startDate = new Date(loan.startDate);

  const monthlyPayment = calculateMonthlyPayment(
    principal,
    annualRate,
    months,
    method,
  );
  let remainingBalance = principal;
  let totalInterest = 0;

  for (let month = 1; month <= months; month++) {
    const paymentDate = new Date(startDate);
    paymentDate.setMonth(paymentDate.getMonth() + month);

    // Calculate interest for this period
    let interestPortion;
    if (method === "simple") {
      interestPortion = (principal * (annualRate / 100)) / 12;
    } else {
      interestPortion = remainingBalance * (annualRate / 100 / 12);
    }

    // Principal portion
    let principalPortion = monthlyPayment - interestPortion;

    // Last payment adjustment
    if (month === months) {
      principalPortion = remainingBalance;
    }

    remainingBalance = Math.max(0, remainingBalance - principalPortion);
    totalInterest += interestPortion;

    schedule.push({
      paymentNumber: month,
      paymentDate: paymentDate.toISOString().split("T")[0],
      principalPortion: Math.round(principalPortion * 100) / 100,
      interestPortion: Math.round(interestPortion * 100) / 100,
      totalPayment:
        Math.round((principalPortion + interestPortion) * 100) / 100,
      remainingBalance: Math.round(remainingBalance * 100) / 100,
    });
  }

  return {
    monthlyPayment: Math.round(monthlyPayment * 100) / 100,
    totalPayment: Math.round(monthlyPayment * months * 100) / 100,
    totalInterest: Math.round(totalInterest * 100) / 100,
    schedule,
  };
}

// @desc    Calculate payment schedule for a loan
// @route   POST /api/loans/calculate
// @access  Private
exports.calculatePaymentSchedule = async (req, res, next) => {
  try {
    const {
      originalAmount,
      interestRate,
      durationMonths,
      interestMethod,
      startDate,
      loanType,
    } = req.body;

    // Validation
    if (!originalAmount || originalAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Original amount must be greater than 0",
      });
    }

    if (durationMonths && durationMonths <= 0) {
      return res.status(400).json({
        success: false,
        message: "Duration must be greater than 0 months",
      });
    }

    if (interestRate && (interestRate < 0 || interestRate > 100)) {
      return res.status(400).json({
        success: false,
        message: "Interest rate must be between 0 and 100",
      });
    }

    // Build loan object for calculation
    const loanData = {
      originalAmount: originalAmount,
      interestRate: interestRate || 0,
      durationMonths: durationMonths || 12,
      interestMethod: interestMethod || "simple",
      startDate: startDate || new Date().toISOString(),
    };

    // Generate schedule
    const schedule = generatePaymentSchedule(loanData);

    res.json({
      success: true,
      data: {
        loanType: loanType || "loan",
        inputs: loanData,
        schedule: schedule,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get payment schedule for existing loan
// @route   GET /api/loans/:id/schedule
// @access  Private
exports.getPaymentSchedule = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const loan = await Loan.findOne({ _id: req.params.id, company: companyId });

    if (!loan) {
      return res
        .status(404)
        .json({ success: false, message: "Loan not found" });
    }

    // Generate schedule based on loan data
    const schedule = generatePaymentSchedule(loan);

    // Add current status info
    const response = {
      loanNumber: loan.loanNumber,
      name: loan.name,
      status: loan.status,
      originalAmount: loan.originalAmount,
      outstandingBalance: loan.outstandingBalance,
      amountPaid: loan.amountPaid,
      inputs: {
        originalAmount: loan.originalAmount,
        interestRate: loan.interestRate,
        durationMonths: loan.durationMonths,
        interestMethod: loan.interestMethod,
        startDate: loan.startDate,
      },
      schedule: schedule,
    };

    res.json({ success: true, data: response });
  } catch (error) {
    next(error);
  }
};
