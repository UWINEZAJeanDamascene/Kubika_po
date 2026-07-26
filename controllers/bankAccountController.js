const {
  BankAccount,
  BankTransaction,
  BankStatementLine,
  BankReconciliationMatch,
} = require("../models/BankAccount");
const mongoose = require("mongoose");
const Invoice = require("../models/Invoice");
const Purchase = require("../models/Purchase");
const Expense = require("../models/Expense");
const JournalEntry = require("../models/JournalEntry");
const JournalService = require("../services/journalService");
const ChartOfAccount = require("../models/ChartOfAccount");
const { DEFAULT_ACCOUNTS, CHART_OF_ACCOUNTS } = require("../constants/chartOfAccounts");

// OPENING BALANCE EQUITY account code for bank account opening balance entry
// 3500 = Opening Balance Equity (allows direct posting for opening balance entries)
const OPENING_BALANCE_EQUITY_CODE = DEFAULT_ACCOUNTS.openingBalanceEquity || "3500";

const BANK_INFLOW_TYPES = new Set(["deposit", "transfer_in", "opening", "debit"]);
const BANK_OUTFLOW_TYPES = new Set(["withdrawal", "transfer_out", "closing", "credit"]);

function isLikelyObjectId(value) {
  return typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
}

function normalizeBankTransactionForApi(tx) {
  const plain = tx?.toObject ? tx.toObject() : { ...tx };
  let type = plain.type;

  if (plain.transactionType === "bank_transfer_in") type = "transfer_in";
  else if (plain.transactionType === "bank_transfer_out") type = "transfer_out";
  else if (type === "debit") type = "deposit";
  else if (type === "credit") type = "withdrawal";
  else if (
    type === "other" &&
    String(plain.description || "").toLowerCase().includes("opening balance")
  ) {
    type = "opening";
  }

  const reference =
    plain.referenceNumber ||
    plain.sourceReference ||
    (plain.reference && !isLikelyObjectId(plain.reference) ? plain.reference : null) ||
    null;

  return {
    ...plain,
    type,
    reference,
    referenceNumber: plain.referenceNumber || reference,
    sourceReference: plain.sourceReference || reference,
    isInflow: BANK_INFLOW_TYPES.has(plain.type) || type === "opening" || type === "deposit" || type === "transfer_in",
  };
}

/**
 * Robust date parsing helper supporting multiple formats
 * DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, DD-MM-YYYY, etc.
 */
function parseCSVDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;

  const str = dateStr.trim();

  // Already ISO format (YYYY-MM-DD)
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const d = new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const ddMmYyyyMatch = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (ddMmYyyyMatch) {
    const day = parseInt(ddMmYyyyMatch[1]);
    const month = parseInt(ddMmYyyyMatch[2]) - 1;
    const year = parseInt(ddMmYyyyMatch[3]);
    const d = new Date(year, month, day);
    return isNaN(d.getTime()) ? null : d;
  }

  // MM/DD/YYYY or MM-DD-YYYY
  const mmDdYyyyMatch = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (mmDdYyyyMatch) {
    // Try as MM/DD/YYYY
    const month = parseInt(mmDdYyyyMatch[1]) - 1;
    const day = parseInt(mmDdYyyyMatch[2]);
    const year = parseInt(mmDdYyyyMatch[3]);
    const d = new Date(year, month, day);
    return isNaN(d.getTime()) ? null : d;
  }

  // DD/MM/YY or DD-MM-YY (2-digit year)
  const ddMmYyMatch = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})$/);
  if (ddMmYyMatch) {
    const day = parseInt(ddMmYyMatch[1]);
    const month = parseInt(ddMmYyMatch[2]) - 1;
    let year = parseInt(ddMmYyMatch[3]);
    year = year < 50 ? 2000 + year : 1900 + year;
    const d = new Date(year, month, day);
    return isNaN(d.getTime()) ? null : d;
  }

  // Fallback to native Date parsing
  const fallback = new Date(str);
  return isNaN(fallback.getTime()) ? null : fallback;
}

/**
 * Ensure Opening Balance Equity account (3500) exists in ChartOfAccount
 * This is needed for companies created before account 3500 was added
 */
async function ensureOpeningBalanceEquityAccount(companyId, userId) {
  try {
    const accountDef = CHART_OF_ACCOUNTS[OPENING_BALANCE_EQUITY_CODE];
    if (!accountDef) {
      console.warn(`[ensureOpeningBalanceEquityAccount] Account ${OPENING_BALANCE_EQUITY_CODE} not found in CHART_OF_ACCOUNTS`);
      return;
    }

    await ChartOfAccount.findOneAndUpdate(
      { company: companyId, code: OPENING_BALANCE_EQUITY_CODE },
      {
        company: companyId,
        code: OPENING_BALANCE_EQUITY_CODE,
        name: accountDef.name,
        type: accountDef.type,
        subtype: accountDef.subtype,
        normal_balance: accountDef.normalBalance,
        allow_direct_posting: accountDef.allowDirectPosting,
        isActive: true,
        createdBy: userId,
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error(`[ensureOpeningBalanceEquityAccount] Failed:`, err.message);
    // Non-fatal - continue with journal creation
  }
}

// @desc    Get all bank accounts for a company
// @route   GET /api/bank-accounts
// @access  Private
exports.getBankAccounts = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { accountType, isActive, page = 1, limit = 50 } = req.query;

    const query = { company: companyId };

    if (accountType) {
      query.accountType = accountType;
    }

    // Default to only active accounts - can be overridden by passing isActive=false
    if (isActive === undefined) {
      query.isActive = true;
    } else {
      query.isActive = isActive === "true";
    }

    let accounts = await BankAccount.find(query)
      .populate("createdBy", "name email")
      .sort({ isDefault: -1, name: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    // Compute per-account balance from BankTransaction records.
    accounts = await Promise.all(
      accounts.map(async (account) => {
        const accObj = account.toObject();
        const openingBalance = parseFloat(
          account.openingBalance?.toString() || "0",
        );

        const computedBalance = await BankAccount.computeBalanceFromTransactions(
          account._id,
          openingBalance,
        );

        return {
          ...accObj,
          cachedBalance: computedBalance,
          currentBalance: computedBalance,
          computedFromTransactions: true,
          lastTransactionDate: null,
          reconciledThrough: null,
        };
      }),
    );

    const total = await BankAccount.countDocuments(query);

    // Get totals by type using computed balances
    const totals = {
      total: accounts.reduce((sum, acc) => sum + (acc.cachedBalance || 0), 0),
      byType: {},
    };

    accounts.forEach((acc) => {
      const type = acc.accountType || "unknown";
      if (!totals.byType[type]) totals.byType[type] = 0;
      totals.byType[type] += acc.cachedBalance || 0;
    });

    res.json({
      success: true,
      count: accounts.length,
      total,
      pages: Math.ceil(total / limit),
      totals,
      data: accounts,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single bank account
// @route   GET /api/bank-accounts/:id
// @access  Private
exports.getBankAccount = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
    }).populate("createdBy", "name email");

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    // Compute per-account balance from BankTransaction records
    // (account-specific — not shared across accounts with the same ledgerAccountId)
    const openingBalance = parseFloat(
      account.openingBalance?.toString() || "0",
    );

    const computedBalance = await BankAccount.computeBalanceFromTransactions(
      account._id,
      openingBalance,
    );

    const accountData = account.toObject();
    accountData.cachedBalance = computedBalance;
    accountData.currentBalance = computedBalance;
    accountData.computedFromTransactions = true;

    res.json({
      success: true,
      data: accountData,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new bank account
// @route   POST /api/bank-accounts
// @access  Private
exports.createBankAccount = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    // Check if account number already exists for this company
    if (req.body.accountNumber) {
      const existing = await BankAccount.findOne({
        company: companyId,
        accountNumber: req.body.accountNumber,
        isActive: true,
      });

      if (existing) {
        return res.status(400).json({
          success: false,
          message: "An account with this number already exists",
        });
      }
    }

    const account = new BankAccount({
      ...req.body,
      company: companyId,
      createdBy: req.user._id,
    });

    await account.save();

    // Create opening balance journal entry if opening balance > 0
    const openingBal = parseFloat(account.openingBalance?.toString() || "0");
    if (openingBal > 0) {
      try {
        // Ensure Opening Balance Equity account exists (for companies created before account 3500)
        await ensureOpeningBalanceEquityAccount(companyId, req.user._id);

        const ledgerAccountId = account.ledgerAccountId || "1100";
        const je = await JournalService.createEntry(companyId, req.user._id, {
          date: account.openingBalanceDate || new Date(),
          description: `Opening balance: ${account.name}`,
          sourceType: "bank_account_opening",
          sourceId: account._id,
          sourceReference: `OPENING-${account.accountNumber || account._id}`,
          lines: [
            JournalService.createDebitLine(ledgerAccountId, openingBal, `Opening balance: ${account.name}`),
            JournalService.createCreditLine(OPENING_BALANCE_EQUITY_CODE, openingBal, `Opening balance: ${account.name}`),
          ],
          isAutoGenerated: true,
          bankAccountId: account._id,
        });
        // Bank transaction is created automatically from the journal entry.
      } catch (journalError) {
        console.error("Failed to create opening balance journal entry:", journalError.message);
        // Non-fatal - account is created but GL won't reflect opening balance
      }
    }

    res.status(201).json({
      success: true,
      data: account,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update bank account
// @route   PUT /api/bank-accounts/:id
// @access  Private
exports.updateBankAccount = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    let account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    // Don't allow changing company or createdBy
    const { company, createdBy, currentBalance, ...updateData } = req.body;

    // If trying to update opening balance, require special permission or create adjustment
    if (
      updateData.openingBalance !== undefined &&
      updateData.openingBalance !== account.openingBalance
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot directly modify opening balance. Use adjustment transaction instead.",
      });
    }

    Object.assign(account, updateData);
    await account.save();

    res.json({
      success: true,
      data: account,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete (deactivate) bank account
// @route   DELETE /api/bank-accounts/:id
// @access  Private
exports.deleteBankAccount = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    // Check if account has transactions
    const transactionCount = await BankTransaction.countDocuments({
      account: account._id,
    });

    if (transactionCount > 0 && !req.body.force) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot delete account with transactions. Use deactivate instead.",
        hasTransactions: true,
      });
    }

    // Soft delete - deactivate
    account.isActive = false;
    await account.save();

    res.json({
      success: true,
      message: "Bank account deactivated",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get transactions for a bank account
// @route   GET /api/bank-accounts/:id/transactions
// @access  Private
exports.getAccountTransactions = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate, type, page = 1, limit = 50 } = req.query;

    // Verify account belongs to company
    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    const query = {
      $and: [
        { $or: [{ companyId }, { company: companyId }] },
        { $or: [{ bankAccountId: req.params.id }, { account: req.params.id }] },
      ],
    };

    if (type) {
      query.$and.push({ $or: [{ transactionType: type }, { type }] });
    }
    if (req.query.reconciliationStatus) {
      query.reconciliationStatus = req.query.reconciliationStatus;
    }

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    let transactions = await BankTransaction.find(query)
      .populate("createdBy", "name email")
      .sort({ date: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await BankTransaction.countDocuments(query);

    // Calculate totals per type
    const totals = await BankTransaction.aggregate([
      {
        $match: {
          $and: [
            { $or: [{ companyId: new mongoose.Types.ObjectId(companyId) }, { company: new mongoose.Types.ObjectId(companyId) }] },
            { $or: [{ bankAccountId: new mongoose.Types.ObjectId(req.params.id) }, { account: new mongoose.Types.ObjectId(req.params.id) }] },
          ],
        },
      },
      {
        $group: {
          _id: "$transactionType",
          total: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]);

    res.json({
      success: true,
      count: transactions.length,
      total,
      pages: Math.ceil(total / limit),
      totals,
      data: transactions.map(normalizeBankTransactionForApi),
      source: "bank_transactions",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get bank account balance from bank transactions and General Ledger
// @route   GET /api/bank-accounts/:id/balance
// @access  Private
exports.getBankAccountBalance = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const account = await BankAccount.findOne({ _id: req.params.id, company: companyId });
    if (!account) return res.status(404).json({ success: false, message: "Bank account not found" });

    const latest = await BankTransaction.findOne({
      $and: [
        { $or: [{ companyId }, { company: companyId }] },
        { $or: [{ bankAccountId: req.params.id }, { account: req.params.id }] },
      ],
    }).sort({ date: -1, createdAt: -1, _id: -1 }).lean();
    const bankTransactionBalance = Number(latest?.balance ?? latest?.balanceAfter ?? account.openingBalance ?? 0);
    const ledgerAccountId = String(account.ledgerAccountId || "1100");
    const rows = await JournalEntry.aggregate([
      { $match: { company: new mongoose.Types.ObjectId(companyId), status: "posted", "lines.accountCode": ledgerAccountId } },
      { $unwind: "$lines" },
      { $match: { "lines.accountCode": ledgerAccountId } },
      { $group: { _id: null, debit: { $sum: { $toDouble: "$lines.debit" } }, credit: { $sum: { $toDouble: "$lines.credit" } } } },
    ]);
    const glBalance = Number(account.openingBalance?.toString?.() || account.openingBalance || 0) + (rows[0]?.debit || 0) - (rows[0]?.credit || 0);
    const difference = Math.round((bankTransactionBalance - glBalance) * 100) / 100;
    res.json({
      success: true,
      data: {
        bankAccountId: account._id,
        bankTransactionBalance,
        generalLedgerBalance: glBalance,
        difference,
        isInAgreement: Math.abs(difference) < 0.01,
        asOf: new Date(),
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Add transaction to bank account
// @route   POST /api/bank-accounts/:id/transactions
// @access  Private
exports.addTransaction = async (req, res, next) => {
  const companyId = req.user.company._id;

  const account = await BankAccount.findOne({
    _id: req.params.id,
    company: companyId,
    isActive: true,
  });

  if (!account) {
    return res.status(404).json({
      success: false,
      message: "Bank account not found or inactive",
    });
  }

  const {
    type,
    amount,
    description,
    referenceNumber,
    notes,
    paymentMethod,
    date,
  } = req.body;

  if (!type || !amount || amount <= 0) {
    return res.status(400).json({
      success: false,
      message: "type and a positive amount are required",
    });
  }

  // Post double-entry journal for deposit and withdrawal
  const ledgerAccountId = account.ledgerAccountId || "1100";
  const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");
  const counterAccount =
    req.body.counterAccountCode || DEFAULT_ACCOUNTS.cashInHand;
  const txDate = date ? new Date(date) : new Date();
  const narration = description || `Bank ${type}: ${account.name}`;

  let journalLines;
  if (type === "deposit" || type === "transfer_in" || type === "opening") {
    journalLines = [
      JournalService.createDebitLine(ledgerAccountId, amount, narration),
      JournalService.createCreditLine(counterAccount, amount, narration),
    ];
  } else if (
    type === "withdrawal" ||
    type === "transfer_out" ||
    type === "closing"
  ) {
    journalLines = [
      JournalService.createDebitLine(counterAccount, amount, narration),
      JournalService.createCreditLine(ledgerAccountId, amount, narration),
    ];
  }

  if (!journalLines) {
    return res.status(400).json({
      success: false,
      message: `Unsupported transaction type: ${type}`,
    });
  }

  try {
    // Create journal entry first (will fail early if period closed or invalid account)
    const je = await JournalService.createEntry(companyId, req.user._id, {
      date: txDate,
      description: narration,
      sourceType:
        type === "deposit"
          ? "bank_deposit"
          : type === "withdrawal"
            ? "bank_withdrawal"
            : "bank_transfer",
      sourceId: null, // Will update after creating transaction
      sourceReference: referenceNumber || null,
      lines: journalLines,
      isAutoGenerated: true,
    });

    // Create the bank transaction with journal entry linked
    const transaction = await account.addTransaction({
      ...req.body,
      createdBy: req.user._id,
      status: "completed",
      journalEntryId: je._id,
    });

    // Update journal entry with correct sourceId
    je.sourceId = transaction._id;
    await je.save();

    // Refresh cached balance from journal
    account.cacheValid = false;
    await account.save();

    res.status(201).json({
      success: true,
      data: transaction,
    });
  } catch (error) {
    console.error(
      "Bank transaction creation failed:",
      error.message,
    );

    // Determine error type for better error handling
    const errorMessage = error.message || "Unknown error";
    let statusCode = 500;
    let userMessage = "Failed to create transaction";

    if (errorMessage.includes("PERIOD_CLOSED")) {
      statusCode = 400;
      userMessage = "Cannot create transaction: accounting period is closed for this date";
    } else if (errorMessage.includes("ACCOUNT_NO_POSTING")) {
      statusCode = 400;
      userMessage = `Invalid account configuration: ${errorMessage}`;
    } else if (errorMessage.includes("Missing userId")) {
      statusCode = 401;
      userMessage = "Authentication error: please log in again";
    } else if (errorMessage.includes("journal entry is not balanced")) {
      statusCode = 500;
      userMessage = "Internal error: journal entry is not balanced";
    }

    res.status(statusCode).json({
      success: false,
      message: userMessage,
      error: errorMessage,
    });
  }
};

// @desc    Transfer between accounts
// @route   POST /api/bank-accounts/transfer
// @access  Private
exports.transfer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      fromAccount,
      toAccount,
      amount,
      description,
      referenceNumber,
      notes,
    } = req.body;

    if (!fromAccount || !toAccount || !amount) {
      return res.status(400).json({
        success: false,
        message: "Please provide fromAccount, toAccount, and amount",
      });
    }

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0",
      });
    }

    // Verify both accounts exist and belong to company
    const from = await BankAccount.findOne({
      _id: fromAccount,
      company: companyId,
      isActive: true,
    });

    const to = await BankAccount.findOne({
      _id: toAccount,
      company: companyId,
      isActive: true,
    });

    if (!from) {
      return res
        .status(404)
        .json({ success: false, message: "Source account not found" });
    }

    if (!to) {
      return res
        .status(404)
        .json({ success: false, message: "Destination account not found" });
    }

    // Get accurate per-account balance from BankTransaction records
    const fromBalance = await BankAccount.computeBalanceFromTransactions(
      from._id,
      from.openingBalance,
    );

    if (fromBalance < amount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient funds in source account",
        currentBalance: fromBalance,
        requestedAmount: amount,
      });
    }

    // Create double-entry journal entry for the transfer
    // DR: destination account ledger, CR: source account ledger
    const fromLedger = from.ledgerAccountId || "1100";
    const toLedger = to.ledgerAccountId || "1100";
    const narration = description || `Bank transfer: ${from.name} → ${to.name}`;
    let je = null;
    try {
      je = await JournalService.createEntry(companyId, req.user._id, {
        date: new Date(),
        description: narration,
        sourceType: "bank_transfer",
        sourceId: null,
        sourceReference: referenceNumber || `TRF-${Date.now()}`,
        lines: [
          JournalService.createDebitLine(toLedger, amount, narration),
          JournalService.createCreditLine(fromLedger, amount, narration),
        ],
        isAutoGenerated: true,
        transferFromAccountId: from._id,
        transferToAccountId: to._id,
      });
    } catch (journalError) {
      return res.status(500).json({
        success: false,
        message:
          "Transfer failed: could not post journal entry. No funds were moved.",
        error: journalError.message,
      });
    }

    const BT = mongoose.model("BankTransaction");
    const transferTransactions = await BT.find({
      $and: [
        { $or: [{ companyId }, { company: companyId }] },
        { journalEntryId: je._id },
      ],
    });
    const withdrawal = transferTransactions.find((tx) => String(tx.bankAccountId || tx.account) === String(from._id));
    const deposit = transferTransactions.find((tx) => String(tx.bankAccountId || tx.account) === String(to._id));

    if (!withdrawal || !deposit) {
      return res.status(500).json({
        success: false,
        message: "Transfer journal posted but matching bank transactions were not created for both accounts.",
        journalEntryId: je._id,
      });
    }

    from.cacheValid = false;
    await from.save();
    to.cacheValid = false;
    await to.save();

    res.status(201).json({
      success: true,
      data: {
        withdrawal,
        deposit,
      },
      message: `Successfully transferred ${amount} from ${from.name} to ${to.name}`,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Transfer money from bank account to another bank/Momo account
// @route   POST /api/bank-accounts/transfer-to-account
// @access  Private
exports.transferToCash = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      fromAccount,
      toAccount,
      amount,
      description,
      referenceNumber,
      notes,
    } = req.body;

    if (!fromAccount || !toAccount || !amount) {
      return res.status(400).json({
        success: false,
        message: "Please provide fromAccount, toAccount, and amount",
      });
    }

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0",
      });
    }

    // Verify source and destination bank accounts exist and belong to company
    const [from, to] = await Promise.all([
      BankAccount.findOne({
        _id: fromAccount,
        company: companyId,
        isActive: true,
      }),
      BankAccount.findOne({
        _id: toAccount,
        company: companyId,
        isActive: true,
      }),
    ]);

    if (!from) {
      return res
        .status(404)
        .json({ success: false, message: "Source bank account not found" });
    }

    if (!to) {
      return res
        .status(404)
        .json({ success: false, message: "Destination bank account not found" });
    }

    if (from._id.toString() === to._id.toString()) {
      return res.status(400).json({
        success: false,
        message: "Source and destination accounts cannot be the same",
      });
    }

    // Get accurate per-account balance from BankTransaction records
    const fromBalance = await BankAccount.computeBalanceFromTransactions(
      from._id,
      from.openingBalance,
    );

    if (fromBalance < amount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient funds in source account",
        currentBalance: fromBalance,
        requestedAmount: amount,
      });
    }

    // Create withdrawal from source account
    const withdrawal = await from.addTransaction({
      type: "transfer_out",
      amount,
      description: description || `Transfer to ${to.name}`,
      referenceNumber,
      notes: notes || `Bank transfer to ${to.accountType}`,
      reference: to._id,
      referenceType: "BankAccount",
      createdBy: req.user._id,
      status: "completed",
    });

    // Create deposit to destination account
    const deposit = await to.addTransaction({
      type: "transfer_in",
      amount,
      description: description || `Transfer from ${from.name}`,
      referenceNumber,
      notes: notes || `Bank transfer from ${from.accountType}`,
      reference: from._id,
      referenceType: "BankAccount",
      createdBy: req.user._id,
      status: "completed",
    });

    // Create double-entry journal entry for the transfer
    // DR: Destination Bank Account ledger, CR: Source Bank Account ledger
    const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");
    const fromLedger = from.ledgerAccountId || DEFAULT_ACCOUNTS.cashAtBank;
    const toLedger = to.ledgerAccountId || DEFAULT_ACCOUNTS.cashAtBank;
    const narration = description || `Bank transfer: ${from.name} → ${to.name}`;

    try {
      const je = await JournalService.createEntry(companyId, req.user._id, {
        date: new Date(),
        description: narration,
        sourceType: "bank_transfer",
        sourceId: withdrawal._id,
        sourceReference: referenceNumber || `BK2CASH-${Date.now()}`,
        lines: [
          JournalService.createDebitLine(
            toLedger,
            amount,
            `Received from: ${from.name}`
          ),
          JournalService.createCreditLine(
            fromLedger,
            amount,
            `Transferred to: ${to.name}`
          ),
        ],
        isAutoGenerated: true,
        skipBankTransactions: true,
        transferFromAccountId: from._id,
        transferToAccountId: to._id,
      });

      // Link journal entry to both transfer transactions
      withdrawal.journalEntryId = je._id;
      await withdrawal.save({ validateBeforeSave: false });
      deposit.journalEntryId = je._id;
      await deposit.save({ validateBeforeSave: false });

    } catch (journalError) {
      // Attempt to reverse both transactions
      try {
        await from.addTransaction({
          type: "adjustment",
          amount,
          description: "Reversal: Journal entry failed for bank transfer",
          notes: journalError.message,
          createdBy: req.user._id,
          status: "completed",
        });
        await to.addTransaction({
          type: "adjustment",
          amount: -amount,
          description: "Reversal: Journal entry failed for bank transfer",
          notes: journalError.message,
          createdBy: req.user._id,
          status: "completed",
        });
      } catch (reversalError) {
        console.error("Failed to reverse bank transaction:", reversalError);
      }

      return res.status(500).json({
        success: false,
        message:
          "Transfer failed: could not post journal entry. No funds were moved.",
        error: journalError.message,
      });
    }

    res.json({
      success: true,
      data: {
        withdrawal,
        deposit,
        journalEntry: {
          debitAccount: toLedger,
          creditAccount: fromLedger,
          amount,
        },
      },
      message: `Successfully transferred ${amount} from ${from.name} to ${to.name}`,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get total cash position
// @route   GET /api/bank-accounts/summary/position
// @access  Private
exports.getCashPosition = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const position = await BankAccount.getTotalCashPosition(companyId);

    res.json({
      success: true,
      data: position,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reconcile account
// @route   POST /api/bank-accounts/:id/reconcile
// @access  Private
exports.reconcile = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { statementBalance, statementDate, notes } = req.body;

    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    // Compute accurate per-account balance from BankTransaction records
    const systemBalance = await BankAccount.computeBalanceFromTransactions(
      account._id,
      account.openingBalance,
    );
    const difference = statementBalance - systemBalance;

    // Update reconciliation info
    account.lastReconciledAt = statementDate || new Date();
    account.lastReconciledBalance = statementBalance;
    await account.save();

    // If there's a difference, create an adjustment transaction + journal entry
    let adjustment = null;
    if (Math.abs(difference) > 0.001) {
      adjustment = await account.addTransaction({
        type: "adjustment",
        amount: Math.abs(difference),
        balanceAfter: statementBalance,
        description: `Reconciliation adjustment: ${difference > 0 ? "surplus" : "shortage"} of ${Math.abs(difference).toFixed(2)}`,
        notes:
          notes ||
          `Reconciled to statement balance ${statementBalance}. Difference: ${difference.toFixed(2)}`,
        createdBy: req.user._id,
        status: "completed",
      });

      // Post journal entry for the reconciliation adjustment
      // Surplus (difference > 0): DR Bank / CR Reconciliation Discrepancy
      // Shortage (difference < 0): DR Reconciliation Discrepancy / CR Bank
      const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");
      const ledgerAccount = account.ledgerAccountId || "1100";
      const discrepancyAccount = DEFAULT_ACCOUNTS.bankCharges || "6200";
      const narration = `Bank reconciliation adjustment: ${account.name}`;
      try {
        const je = await JournalService.createEntry(companyId, req.user._id, {
          date: statementDate ? new Date(statementDate) : new Date(),
          description: narration,
          sourceType: "bank_transfer",
          sourceId: account._id,
          sourceReference: `RECON-${Date.now()}`,
          lines:
            difference > 0
              ? [
                  JournalService.createDebitLine(
                    ledgerAccount,
                    Math.abs(difference),
                    narration,
                  ),
                  JournalService.createCreditLine(
                    discrepancyAccount,
                    Math.abs(difference),
                    narration,
                  ),
                ]
              : [
                  JournalService.createDebitLine(
                    discrepancyAccount,
                    Math.abs(difference),
                    narration,
                  ),
                  JournalService.createCreditLine(
                    ledgerAccount,
                    Math.abs(difference),
                    narration,
                  ),
                ],
          isAutoGenerated: true,
        });
        if (adjustment) {
          await mongoose
            .model("BankTransaction")
            .findByIdAndUpdate(adjustment._id, { journalEntryId: je._id });
        }
        account.cacheValid = false;
        await account.save();
      } catch (journalError) {
        console.error(
          "Journal entry for reconciliation adjustment failed:",
          journalError.message,
        );
      }
    }

    res.json({
      success: true,
      data: {
        account,
        statementBalance,
        systemBalance,
        difference,
        adjustment,
      },
      message:
        difference === 0
          ? "Account reconciled successfully - no adjustments needed"
          : `Account reconciled with ${Math.abs(difference)} adjustment`,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all transactions across all accounts
// @route   GET /api/bank-accounts/transactions
// @access  Private
exports.getAllTransactions = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      startDate,
      endDate,
      accountId,
      type,
      page = 1,
      limit = 50,
    } = req.query;

    // Only get transactions from active accounts belonging to this company
    const activeAccounts = await BankAccount.find({
      company: companyId,
      isActive: true,
    }).select("_id");
    const activeAccountIds = activeAccounts.map((a) => a._id);

    // If specific account requested, verify it's active and belongs to company
    let accountFilter;
    if (accountId) {
      const validId = activeAccountIds.find(
        (id) => id.toString() === accountId,
      );
      if (!validId) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found or not active" });
      }
      accountFilter = validId;
    } else {
      accountFilter = { $in: activeAccountIds };
    }

    const query = { account: accountFilter };

    if (type) {
      query.type = type;
    }

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const transactions = await BankTransaction.find(query)
      .populate("account", "name accountType _id")
      .populate("createdBy", "name email")
      .sort({ date: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await BankTransaction.countDocuments(query);

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

// @desc    Adjust account balance
// @route   POST /api/bank-accounts/:id/adjust
// @access  Private
exports.adjustBalance = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { newBalance, reason } = req.body;

    if (newBalance === undefined || newBalance === null) {
      return res.status(400).json({
        success: false,
        message: "Please provide newBalance",
      });
    }

    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
      isActive: true,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    // Get accurate per-account balance from BankTransaction records
    const previousBalance = await BankAccount.computeBalanceFromTransactions(
      account._id,
      account.openingBalance,
    );
    const difference = newBalance - previousBalance;

    if (Math.abs(difference) < 0.001) {
      return res.status(400).json({
        success: false,
        message: "New balance is the same as current balance",
      });
    }

    const transaction = await account.addTransaction({
      type: "adjustment",
      amount: Math.abs(difference),
      balanceAfter: newBalance,
      description: `Balance adjustment: ${difference > 0 ? "+" : ""}${difference.toFixed(2)}`,
      notes: reason || `Manual adjustment to ${newBalance}`,
      createdBy: req.user._id,
      status: "completed",
    });

    // Post double-entry journal for the adjustment
    const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");
    const ledgerAccount = account.ledgerAccountId || "1100";
    const discrepancyAcc = DEFAULT_ACCOUNTS.bankCharges || "6200";
    const narration = reason || `Manual balance adjustment: ${account.name}`;
    try {
      const je = await JournalService.createEntry(companyId, req.user._id, {
        date: new Date(),
        description: narration,
        sourceType: "bank_transfer",
        sourceId: account._id,
        sourceReference: `ADJ-${Date.now()}`,
        lines:
          difference > 0
            ? [
                JournalService.createDebitLine(
                  ledgerAccount,
                  Math.abs(difference),
                  narration,
                ),
                JournalService.createCreditLine(
                  discrepancyAcc,
                  Math.abs(difference),
                  narration,
                ),
              ]
            : [
                JournalService.createDebitLine(
                  discrepancyAcc,
                  Math.abs(difference),
                  narration,
                ),
                JournalService.createCreditLine(
                  ledgerAccount,
                  Math.abs(difference),
                  narration,
                ),
              ],
        isAutoGenerated: true,
      });
      await mongoose
        .model("BankTransaction")
        .findByIdAndUpdate(transaction._id, { journalEntryId: je._id });
      account.cacheValid = false;
      await account.save();
    } catch (journalError) {
      console.error(
        "Journal entry for balance adjustment failed:",
        journalError.message,
      );
    }

    res.status(201).json({
      success: true,
      data: {
        transaction,
        previousBalance,
        newBalance,
        difference,
      },
      message: `Account balance adjusted by ${difference > 0 ? "+" : ""}${difference.toFixed(2)}`,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get account statistics
// @route   GET /api/bank-accounts/:id/stats
// @access  Private
exports.getAccountStats = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { period = "month" } = req.query; // day, week, month, year

    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    // Calculate date range
    const now = new Date();
    let startDate;
    let groupBy;

    switch (period) {
      case "day":
        startDate = new Date(now.setDate(now.getDate() - 30));
        groupBy = { $dateToString: { format: "%Y-%m-%d", date: "$date" } };
        break;
      case "week":
        startDate = new Date(now.setDate(now.getDate() - 90));
        groupBy = { $dateToString: { format: "%Y-%W", date: "$date" } };
        break;
      case "month":
        startDate = new Date(now.setMonth(now.getMonth() - 12));
        groupBy = { $dateToString: { format: "%Y-%m", date: "$date" } };
        break;
      case "year":
        startDate = new Date(now.setFullYear(now.getFullYear() - 5));
        groupBy = { $dateToString: { format: "%Y", date: "$date" } };
        break;
      default:
        startDate = new Date(now.setMonth(now.getMonth() - 12));
        groupBy = { $dateToString: { format: "%Y-%m", date: "$date" } };
    }

    // Get transaction totals by type
    const stats = await BankTransaction.aggregate([
      {
        $match: {
          account: account._id,
          date: { $gte: startDate },
        },
      },
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
      deposits: 0,
      withdrawals: 0,
      transfersIn: 0,
      transfersOut: 0,
      adjustments: 0,
      totalTransactions: 0,
    };

    stats.forEach((item) => {
      switch (item._id) {
        case "deposit":
          result.deposits = item.total;
          break;
        case "withdrawal":
          result.withdrawals = item.total;
          break;
        case "transfer_in":
          result.transfersIn = item.total;
          break;
        case "transfer_out":
          result.transfersOut = item.total;
          break;
        case "adjustment":
        case "opening":
        case "closing":
          result.adjustments += item.total;
          break;
      }
      result.totalTransactions += item.count;
    });

    // Get daily/weekly/monthly trend
    const trend = await BankTransaction.aggregate([
      {
        $match: {
          account: account._id,
          date: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: groupBy,
          deposits: {
            $sum: {
              $cond: [
                { $in: ["$type", ["deposit", "transfer_in", "opening"]] },
                "$amount",
                0,
              ],
            },
          },
          withdrawals: {
            $sum: {
              $cond: [
                { $in: ["$type", ["withdrawal", "transfer_out", "closing"]] },
                "$amount",
                0,
              ],
            },
          },
          net: {
            $sum: {
              $cond: [
                { $in: ["$type", ["deposit", "transfer_in", "opening"]] },
                "$amount",
                { $multiply: ["$amount", -1] },
              ],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      success: true,
      data: {
        currentBalance: parseFloat(account.cachedBalance?.toString() || "0"),
        openingBalance: parseFloat(account.openingBalance?.toString() || "0"),
        ...result,
        netChange:
          result.deposits +
          result.transfersIn -
          result.withdrawals -
          result.transfersOut,
        trend,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get bank statement
// @route   GET /api/bank-accounts/:id/statement
// @access  Private
exports.getBankStatement = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate, format = "json" } = req.query;

    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    const query = {
      $and: [
        { $or: [{ companyId }, { company: companyId }] },
        { $or: [{ bankAccountId: req.params.id }, { account: req.params.id }] },
      ],
    };

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const transactions = await BankTransaction.find(query)
      .populate("createdBy", "name")
      .sort({ date: 1 });

    const statement = transactions.map((t) => {
      const moneyIn = ["debit", "deposit", "transfer_in", "opening"].includes(t.type) ? t.amount : 0;
      const moneyOut = ["credit", "withdrawal", "transfer_out", "closing"].includes(t.type) ? t.amount : 0;
      return {
        ...t.toObject(),
        moneyIn,
        moneyOut,
        runningBalance: t.balance ?? t.balanceAfter,
      };
    });
    const closingBalance = statement.length
      ? statement[statement.length - 1].runningBalance
      : Number(account.openingBalance?.toString?.() || account.openingBalance || 0);

    res.json({
      success: true,
      data: {
        account: {
          name: account.name,
          accountType: account.accountType,
          accountNumber: account.accountNumber,
          bankName: account.bankName,
        },
        period: {
          start: startDate,
          end: endDate,
        },
        openingBalance: account.openingBalance,
        closingBalance,
        transactions: statement,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Import transactions from CSV
// @route   POST /api/bank-accounts/:id/import-csv
// @access  Private
exports.importCSV = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      transactions: csvTransactions,
      autoMatch = false,
      bankFormat,
      dateFrom,
      dateTo,
      skipReordering = false,
    } = req.body;

    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
      isActive: true,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    if (
      !csvTransactions ||
      !Array.isArray(csvTransactions) ||
      csvTransactions.length === 0
    ) {
      return res
        .status(400)
        .json({ success: false, message: "No transactions provided" });
    }

    // Per spec: Check for sequential import - warn if earliest line has date earlier than latest existing statement
    const latestExistingStatement = await BankStatementLine.findOne({
      bankAccount: account._id,
    }).sort({ transactionDate: -1 });

    let sequentialWarning = null;
    if (latestExistingStatement && !skipReordering) {
      // Find earliest date in new import
      const earliestImportDate = csvTransactions
        .map((tx) => (tx.date ? parseCSVDate(tx.date) : null))
        .filter((d) => d)
        .sort((a, b) => a - b)[0];

      if (
        earliestImportDate &&
        earliestImportDate < latestExistingStatement.transactionDate
      ) {
        sequentialWarning = `Warning: Earliest imported date (${earliestImportDate.toISOString().split("T")[0]}) is earlier than latest existing statement (${latestExistingStatement.transactionDate.toISOString().split("T")[0]}). Computed running balance may be incorrect. Set skipReordering=true to ignore.`;
      }
    }

    // Filter by date range if provided
    let filteredTransactions = csvTransactions;
    if (dateFrom || dateTo) {
      filteredTransactions = csvTransactions.filter((tx) => {
        if (!tx.date) return true;
        const txDate = parseCSVDate(tx.date);
        if (!txDate) return true;

        let include = true;
        if (dateFrom) {
          const fromDate = new Date(dateFrom);
          include = include && txDate >= fromDate;
        }
        if (dateTo) {
          const toDate = new Date(dateTo);
          toDate.setHours(23, 59, 59, 999);
          include = include && txDate <= toDate;
        }
        return include;
      });
    }

    // Per spec: Sort by transaction_date ASC, then by row order
    filteredTransactions = filteredTransactions
      .map((tx, index) => ({ ...tx, _importOrder: index }))
      .sort((a, b) => {
        const dateA = a.date ? parseCSVDate(a.date) : new Date(0);
        const dateB = b.date ? parseCSVDate(b.date) : new Date(0);
        if (dateA.getTime() === dateB.getTime()) {
          return a._importOrder - b._importOrder;
        }
        return dateA - dateB;
      });

    const importedStatementLines = [];

    // Per spec: Compute running balance from opening_balance if balance not in CSV
    // First, get the anchor: bank_accounts.opening_balance
    const openingBalance = parseFloat(
      account.openingBalance?.toString() || "0",
    );

    // Get existing statement lines to compute starting balance
    const existingStatements = await BankStatementLine.find({
      bankAccount: account._id,
    })
      .sort({ transactionDate: 1, _id: 1 })
      .lean();

    // Compute the balance at the end of existing statements
    let runningBalance = openingBalance;
    for (const stmt of existingStatements) {
      const debit = parseFloat(stmt.debitAmount?.toString() || "0");
      const credit = parseFloat(stmt.creditAmount?.toString() || "0");
      runningBalance = runningBalance + credit - debit;
    }

    // Now process new statements, computing balance if not provided
    for (const tx of filteredTransactions) {
      // Parse debit/credit amounts
      const debitAmount =
        tx.debitAmount !== undefined
          ? parseFloat(String(tx.debitAmount).replace(/[^0-9.-]/g, "")) || 0
          : tx.debit
            ? parseFloat(String(tx.debit).replace(/[^0-9.-]/g, "")) || 0
            : 0;

      const creditAmount =
        tx.creditAmount !== undefined
          ? parseFloat(String(tx.creditAmount).replace(/[^0-9.-]/g, "")) || 0
          : tx.credit
            ? parseFloat(String(tx.credit).replace(/[^0-9.-]/g, "")) || 0
            : 0;

      // If balance is provided in CSV, use it; otherwise compute
      let balance = null;
      if (tx.balance !== undefined) {
        balance =
          parseFloat(String(tx.balance).replace(/[^0-9.-]/g, "")) || null;
      }

      // Compute running balance: running_balance = running_balance + credit - debit
      runningBalance = runningBalance + creditAmount - debitAmount;

      // Parse date using robust parser
      let transactionDate = new Date();
      if (tx.date) {
        const parsed = parseCSVDate(tx.date);
        if (parsed) {
          transactionDate = parsed;
        }
      }

      // Determine transaction type
      let transactionType = "deposit";
      if (debitAmount > 0 && creditAmount === 0) {
        transactionType = "withdrawal";
      } else if (creditAmount > 0 && debitAmount === 0) {
        transactionType = "deposit";
      }

      // Create bank statement line (not BankTransaction)
      const statementLine = new BankStatementLine({
        company: companyId,
        bankAccount: account._id,
        transactionDate,
        description:
          tx.description || tx.narration || tx.details || "Imported from CSV",
        debitAmount: mongoose.Types.Decimal128.fromString(String(debitAmount)),
        creditAmount: mongoose.Types.Decimal128.fromString(
          String(creditAmount),
        ),
        balance:
          balance !== null
            ? mongoose.Types.Decimal128.fromString(String(balance))
            : mongoose.Types.Decimal128.fromString(String(runningBalance)),
        reference: tx.reference || tx.ref || tx.transactionId || "",
        isReconciled: false,
        importedAt: new Date(),
      });

      await statementLine.save();
      importedStatementLines.push(statementLine);
    }

    // Update account cache - invalidate since new statement lines imported
    account.cacheValid = false;
    await account.save();

    res.status(201).json({
      success: true,
      data: {
        imported: importedStatementLines.length,
        computedEndingBalance: runningBalance,
        statementLines: importedStatementLines,
        sequentialWarning,
      },
      message: sequentialWarning
        ? `Imported ${importedStatementLines.length} statement lines. ${sequentialWarning}`
        : `Successfully imported ${importedStatementLines.length} statement lines`,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Auto-match transactions with invoices, purchases, expenses
// @route   POST /api/bank-accounts/:id/auto-match
// @access  Private
exports.autoMatchTransactions = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const accountId = req.params.id;

    const account = await BankAccount.findOne({
      _id: accountId,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    const results = await autoMatchTransactions(companyId, accountId);

    res.json({
      success: true,
      data: results,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get reconciliation report
// @route   GET /api/bank-accounts/:id/reconciliation-report
// @access  Private
exports.getReconciliationReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate } = req.query;

    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    // Get all transactions in date range
    const query = { account: account._id };
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const transactions = await BankTransaction.find(query).sort({ date: 1 });

    // Get all paid invoices
    const invoices = await Invoice.find({
      company: companyId,
      status: "paid",
      paymentMethod: "bank_transfer",
    }).populate("client", "name");

    // Get all paid purchases
    const purchases = await Purchase.find({
      company: companyId,
      status: "received",
      paymentMethod: "bank_transfer",
    }).populate("supplier", "name");

    // Get all paid expenses
    const expenses = await Expense.find({
      company: companyId,
      paid: true,
      paymentMethod: "bank_transfer",
    });

    // Categorize transactions
    const matched = [];
    const unmatched = [];

    for (const tx of transactions) {
      const matchResult = findMatch(tx, invoices, purchases, expenses);

      if (matchResult) {
        matched.push({
          transaction: tx,
          matchedTo: matchResult,
        });
      } else {
        unmatched.push(tx);
      }
    }

    // Calculate totals
    const matchedAmount = matched.reduce(
      (sum, m) => sum + m.transaction.amount,
      0,
    );
    const unmatchedAmount = unmatched.reduce(
      (sum, m) => sum + m.transaction.amount,
      0,
    );

    res.json({
      success: true,
      data: {
        account: {
          name: account.name,
          accountType: account.accountType,
          currentBalance: account.currentBalance,
        },
        period: { startDate, endDate },
        summary: {
          totalTransactions: transactions.length,
          matched: matched.length,
          unmatched: unmatched.length,
          matchedAmount,
          unmatchedAmount,
        },
        matched,
        unmatched,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Helper function to auto-match transactions
async function autoMatchTransactions(
  companyId,
  accountId,
  transactions = null,
) {
  const txList =
    transactions ||
    (await BankTransaction.find({
      company: companyId,
      account: accountId,
      status: "completed",
    }));

  // Get all pending payments from invoices, purchases, expenses
  const invoices = await Invoice.find({
    company: companyId,
    status: { $in: ["confirmed", "partial"] },
    paymentMethod: "bank_transfer",
  }).populate("client", "name");

  const purchases = await Purchase.find({
    company: companyId,
    status: { $in: ["pending", "partial"] },
    paymentMethod: "bank_transfer",
  }).populate("supplier", "name");

  const expenses = await Expense.find({
    company: companyId,
    paid: false,
    paymentMethod: "bank_transfer",
  });

  let matched = 0;
  let unmatched = 0;

  for (const tx of txList) {
    const matchResult = findMatch(tx, invoices, purchases, expenses);

    if (matchResult) {
      // Update the transaction with match info
      tx.reference = matchResult.id;
      tx.referenceType = matchResult.type;
      tx.notes =
        (tx.notes || "") +
        ` | Matched to ${matchResult.type} #${matchResult.number}`;
      await tx.save();

      // Mark the invoice/purchase/expense as paid
      if (matchResult.type === "Invoice") {
        await Invoice.findByIdAndUpdate(matchResult.id, {
          status: "paid",
          paidDate: tx.date,
        });
      } else if (matchResult.type === "Purchase") {
        await Purchase.findByIdAndUpdate(matchResult.id, {
          status: "received",
        });
      } else if (matchResult.type === "Expense") {
        await Expense.findByIdAndUpdate(matchResult.id, {
          paid: true,
          paidDate: tx.date,
        });
      }

      matched++;
    } else {
      unmatched++;
    }
  }

  return { matched, unmatched };
}

// Helper function to find match for a transaction
function findMatch(tx, invoices, purchases, expenses) {
  const txAmount = tx.amount;
  const txRef = (tx.referenceNumber || "").toLowerCase();
  const txDesc = (tx.description || "").toLowerCase();

  // Try to match with invoices (payments received)
  for (const invoice of invoices) {
    const invoiceTotal = invoice.total || 0;
    const invoiceNumber = (invoice.invoiceNumber || "").toLowerCase();
    const clientName = (invoice.client?.name || "").toLowerCase();

    // Check amount match (within 1% tolerance)
    const amountDiff = Math.abs(txAmount - invoiceTotal) / invoiceTotal;

    if (amountDiff < 0.01 || txAmount === invoiceTotal) {
      // Check reference/number match
      if (
        txRef.includes(invoiceNumber) ||
        txDesc.includes(invoiceNumber) ||
        txDesc.includes(clientName)
      ) {
        return {
          type: "Invoice",
          id: invoice._id,
          number: invoice.invoiceNumber,
          amount: invoiceTotal,
        };
      }
    }
  }

  // Try to match with purchases (payments made)
  for (const purchase of purchases) {
    const purchaseTotal = purchase.total || 0;
    const purchaseNumber = (purchase.orderNumber || "").toLowerCase();
    const supplierName = (purchase.supplier?.name || "").toLowerCase();

    const amountDiff = Math.abs(txAmount - purchaseTotal) / purchaseTotal;

    if (amountDiff < 0.01 || txAmount === purchaseTotal) {
      if (
        txRef.includes(purchaseNumber) ||
        txDesc.includes(purchaseNumber) ||
        txDesc.includes(supplierName)
      ) {
        return {
          type: "Purchase",
          id: purchase._id,
          number: purchase.orderNumber,
          amount: purchaseTotal,
        };
      }
    }
  }

  // Try to match with expenses
  for (const expense of expenses) {
    const expenseAmount = expense.amount || 0;
    const expenseDesc = (expense.description || "").toLowerCase();

    const amountDiff = Math.abs(txAmount - expenseAmount) / expenseAmount;

    if (amountDiff < 0.01 || txAmount === expenseAmount) {
      if (txRef.includes(expenseDesc) || txDesc.includes(expenseDesc)) {
        return {
          type: "Expense",
          id: expense._id,
          number: expense.expenseNumber || expense.description,
          amount: expenseAmount,
        };
      }
    }
  }

  return null;
}

// @desc    Get computed bank balance from journal entries (Section 3.3)
// @route   GET /api/bank-accounts/:id/balance
// @access  Private
exports.getComputedBalance = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { asOfDate, forceRecompute } = req.query;

    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    // Per spec 3.3: Use dirty flag caching pattern
    // If cache is valid and forceRecompute is not true, return cached balance
    if (!forceRecompute && account.cacheValid) {
      return res.json({
        success: true,
        data: {
          accountId: account._id,
          accountName: account.name,
          ledgerAccountId: account.ledgerAccountId || "1100",
          balance: parseFloat(account.cachedBalance?.toString() || "0"),
          openingBalance: parseFloat(account.openingBalance?.toString() || "0"),
          openingBalanceDate: account.openingBalanceDate,
          cached: true,
          computedAt: account.cacheLastComputed,
          cacheValid: true,
        },
      });
    }

    // Compute per-account balance from BankTransaction records
    const balance = await BankAccount.computeBalanceFromTransactions(
      account._id,
      account.openingBalance,
    );
    const result = { balance, cached: false, computedAt: new Date() };

    res.json({
      success: true,
      data: {
        accountId: account._id,
        accountName: account.name,
        ledgerAccountId: account.ledgerAccountId || "1100",
        openingBalance: result.details.openingBalance,
        openingBalanceDate: account.openingBalanceDate,
        totalDebits: result.details.totalDebits,
        totalCredits: result.details.totalCredits,
        balance: Math.round(result.balance * 100) / 100,
        asOfDate: asOfDate ? new Date(asOfDate) : new Date(),
        journalEntryCount: result.details.journalEntryCount,
        cached: result.cached,
        computedAt: result.computedAt,
        cacheValid: true, // After computation, cache is valid
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get journal entry lines for bank account (for reconciliation)
// @route   GET /api/bank-accounts/:id/transactions
// @access  Private
exports.getJournalTransactions = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate, reconciled } = req.query;

    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    const ledgerAccountId =
      account.ledgerAccountId || account.accountCode || "1100";

    // Build date query
    const dateQuery = {};
    if (startDate) dateQuery.$gte = new Date(startDate);
    if (endDate) dateQuery.$lte = new Date(endDate);

    // Build query for journal entries
    const query = {
      company: companyId,
      status: "posted",
      lines: { $elemMatch: { accountCode: ledgerAccountId } },
    };

    if (startDate || endDate) {
      query.date = dateQuery;
    }

    const entries = await JournalEntry.find(query)
      .populate("createdBy", "name")
      .sort({ date: -1 })
      .lean();

    // Extract and flatten lines for this account
    const transactions = [];
    for (const entry of entries) {
      for (const line of entry.lines) {
        if (line.accountCode === ledgerAccountId) {
          const amount =
            parseFloat(line.debit?.toString() || "0") ||
            -parseFloat(line.credit?.toString() || "0");
          transactions.push({
            journalEntryId: entry._id,
            entryNumber: entry.entryNumber,
            date: entry.date,
            description: line.description || entry.description,
            debit: parseFloat(line.debit?.toString() || "0"),
            credit: parseFloat(line.credit?.toString() || "0"),
            amount: amount,
            reference: line.reference,
            reconciled: line.reconciled || false,
            matchedStatementLineId: line.matchedStatementLineId || null,
          });
        }
      }
    }

    // Filter by reconciled status if specified
    let filteredTransactions = transactions;
    if (reconciled !== undefined) {
      filteredTransactions = transactions.filter(
        (t) => t.reconciled === (reconciled === "true"),
      );
    }

    // Calculate totals
    const totals = {
      totalDebits: filteredTransactions.reduce((sum, t) => sum + t.debit, 0),
      totalCredits: filteredTransactions.reduce((sum, t) => sum + t.credit, 0),
      reconciledCount: filteredTransactions.filter((t) => t.reconciled).length,
      unreconciledCount: filteredTransactions.filter((t) => !t.reconciled)
        .length,
    };

    res.json({
      success: true,
      data: filteredTransactions,
      totals,
      account: {
        name: account.name,
        ledgerAccountId,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Add bank statement line manually
// @route   POST /api/bank-accounts/:id/statement
// @access  Private
exports.addStatementLine = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      transactionDate,
      description,
      debitAmount,
      creditAmount,
      balance,
      reference,
    } = req.body;

    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
      isActive: true,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    if (!transactionDate || !description) {
      return res.status(400).json({
        success: false,
        message: "transactionDate and description are required",
      });
    }

    const statementLine = new BankStatementLine({
      company: companyId,
      bankAccount: account._id,
      transactionDate,
      description,
      debitAmount: mongoose.Types.Decimal128.fromString(
        String(debitAmount || 0),
      ),
      creditAmount: mongoose.Types.Decimal128.fromString(
        String(creditAmount || 0),
      ),
      balance: mongoose.Types.Decimal128.fromString(String(balance || 0)),
      reference,
      isReconciled: false,
      importedAt: new Date(),
    });

    await statementLine.save();

    res.status(201).json({
      success: true,
      data: statementLine,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get bank statement lines
// @route   GET /api/bank-accounts/:id/statement
// @access  Private
exports.getStatementLines = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate, reconciled } = req.query;

    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    const query = { bankAccount: account._id };

    if (startDate || endDate) {
      query.transactionDate = {};
      if (startDate) query.transactionDate.$gte = new Date(startDate);
      if (endDate) query.transactionDate.$lte = new Date(endDate);
    }

    if (reconciled !== undefined) {
      query.isReconciled = reconciled === "true";
    }

    const lines = await BankStatementLine.find(query)
      .sort({ transactionDate: -1 })
      .lean();

    // Calculate totals
    const totals = {
      totalDebits: lines.reduce(
        (sum, l) => sum + parseFloat(l.debitAmount?.toString() || "0"),
        0,
      ),
      totalCredits: lines.reduce(
        (sum, l) => sum + parseFloat(l.creditAmount?.toString() || "0"),
        0,
      ),
      reconciledCount: lines.filter((l) => l.isReconciled).length,
      unreconciledCount: lines.filter((l) => !l.isReconciled).length,
    };

    res.json({
      success: true,
      data: lines,
      totals,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get reconciliation - unmatched items on both sides (Section 3.4)
// @route   GET /api/bank-accounts/:id/reconciliation
// @access  Private
exports.getReconciliation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate } = req.query;

    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    const ledgerAccountId =
      account.ledgerAccountId || account.accountCode || "1100";

    // Date filter
    const dateQuery = {};
    if (startDate) dateQuery.$gte = new Date(startDate);
    if (endDate) dateQuery.$lte = new Date(endDate);

    // Get ALL journal entries in period (for computing book balance)
    const allJournalEntries = await JournalEntry.find({
      company: companyId,
      status: "posted",
      date: dateQuery,
      lines: { $elemMatch: { accountCode: ledgerAccountId } },
    }).lean();

    // Get all matches for this bank account (to determine reconciled status)
    const allMatches = await BankReconciliationMatch.find({
      company: companyId,
      bankAccount: account._id,
    }).lean();

    // Create set of reconciled line IDs
    const reconciledLineIds = new Set(
      allMatches.map((m) => m.journalEntryLineId.toString()),
    );

    // Calculate book balance from all journal entries
    let bookDebits = 0;
    let bookCredits = 0;
    const journalLines = [];

    for (const entry of allJournalEntries) {
      for (const line of entry.lines) {
        if (line.accountCode === ledgerAccountId) {
          const lineIdStr = line._id ? line._id.toString() : null;
          const isReconciled = lineIdStr
            ? reconciledLineIds.has(lineIdStr)
            : line.reconciled;

          const debit = parseFloat(line.debit?.toString() || "0");
          const credit = parseFloat(line.credit?.toString() || "0");
          bookDebits += debit;
          bookCredits += credit;

          // Only include unreconciled in the list
          if (!isReconciled) {
            const amount = debit || -credit;
            journalLines.push({
              type: "journal",
              id: entry._id,
              lineId: line._id,
              date: entry.date,
              description: line.description || entry.description,
              amount: Math.abs(amount),
              isDebit: amount > 0,
              reconciled: false,
            });
          }
        }
      }
    }

    // Book balance = opening_balance + DR - CR
    const openingBalance = parseFloat(
      account.openingBalance?.toString() || "0",
    );
    const bookBalance = openingBalance + bookDebits - bookCredits;

    // Get ALL bank statement lines in period (for computing bank balance)
    const statementQuery = { bankAccount: account._id };
    if (startDate || endDate) {
      statementQuery.transactionDate = {};
      if (startDate) statementQuery.transactionDate.$gte = new Date(startDate);
      if (endDate) statementQuery.transactionDate.$lte = new Date(endDate);
    }

    const allStatementLines =
      await BankStatementLine.find(statementQuery).lean();

    // Get statement line IDs that have matches
    const matchedStatementIds = new Set(
      allMatches.map((m) => m.bankStatementLine.toString()),
    );

    // Calculate bank balance from statement lines (per spec 3.3: bank's reported balance)
    let bankBalance = 0;
    const bankLines = [];

    for (const line of allStatementLines) {
      const lineIdStr = line._id.toString();
      const matchesForLine = allMatches.filter(
        (m) => m.bankStatementLine.toString() === lineIdStr,
      );
      const hasMatches = matchesForLine.length > 0;

      // Per spec: isReconciled = TRUE only when SUM(matched amounts) = statement line amount
      const statementAmount = Math.abs(
        parseFloat(
          line.creditAmount?.toString() || line.debitAmount?.toString() || "0",
        ),
      );

      // Calculate total matched amount for this line
      let totalMatchedAmount = 0;
      for (const m of matchesForLine) {
        const je = allJournalEntries.find(
          (e) => e._id.toString() === m.journalEntry?.toString(),
        );
        if (je) {
          const jLine = je.lines.find(
            (l) =>
              l._id && l._id.toString() === m.journalEntryLineId.toString(),
          );
          if (jLine) {
            const debit = parseFloat(jLine.debit?.toString() || "0");
            const credit = parseFloat(jLine.credit?.toString() || "0");
            totalMatchedAmount += Math.abs(debit || credit);
          }
        }
      }

      // Per spec: reconciled only when exact amount match
      const isReconciled =
        hasMatches && Math.abs(totalMatchedAmount - statementAmount) < 0.01;

      const debit = parseFloat(line.debitAmount?.toString() || "0");
      const credit = parseFloat(line.creditAmount?.toString() || "0");
      const amount = credit - debit; // Credit increases bank balance

      bankLines.push({
        type: "bank",
        id: line._id,
        date: line.transactionDate,
        description: line.description,
        amount: Math.abs(amount),
        isDebit: amount < 0, // Debit decreases bank balance
        reconciled: isReconciled,
        balance: line.balance, // Bank's reported running balance
        matchCount: matchesForLine.length,
        matchedAmount: totalMatchedAmount,
        difference: statementAmount - totalMatchedAmount,
      });
    }

    // Get the ending balance from the last statement line
    let lastStatementBalance = 0;
    if (allStatementLines.length > 0) {
      const lastLine = allStatementLines[allStatementLines.length - 1];
      bankBalance = parseFloat(lastLine.balance?.toString() || "0");
      lastStatementBalance = bankBalance;
    }

    // Per spec: Compute adjusted balances using unreconciled items
    // Unreconciled journal items: DR = deposits in transit, CR = outstanding payments
    const unreconciledJournalDR = journalLines
      .filter((l) => l.isDebit === true)
      .reduce((sum, l) => sum + l.amount, 0);

    const unreconciledJournalCR = journalLines
      .filter((l) => l.isDebit === false)
      .reduce((sum, l) => sum + l.amount, 0);

    // Unreconciled statement lines: credits = bank credits not in books, debits = bank charges not in books
    const unreconciledStatementCredits = bankLines
      .filter((l) => !l.reconciled && l.amount > 0)
      .reduce((sum, l) => sum + l.amount, 0);

    const unreconciledStatementDebits = bankLines
      .filter((l) => !l.reconciled && l.isDebit)
      .reduce((sum, l) => sum + l.amount, 0);

    // Adjusted bank balance = lastStatementBalance + deposits in transit - outstanding payments
    const adjustedBankBalance =
      lastStatementBalance + unreconciledJournalDR - unreconciledJournalCR;

    // Adjusted book balance = bookBalance + bank credits not in books - bank charges not in books
    const adjustedBookBalance =
      bookBalance + unreconciledStatementCredits - unreconciledStatementDebits;

    // Per spec: difference = adjustedBankBalance - adjustedBookBalance (target: 0.00)
    const difference = adjustedBankBalance - adjustedBookBalance;

    res.json({
      success: true,
      data: {
        journalLines, // Unreconciled book items
        bankLines, // All bank items (reconciled and unreconciled)
        summary: {
          // Raw balances
          bookBalance, // System's computed balance (opening + ΣDR - ΣCR)
          bankBalance, // Bank's reported balance (last statement line balance)
          // Adjusted balances (per spec bank reconciliation format)
          lastStatementBalance,
          adjustedBankBalance,
          adjustedBookBalance,
          // Components
          depositsInTransit: unreconciledJournalDR,
          outstandingPayments: unreconciledJournalCR,
          bankCreditsNotInBooks: unreconciledStatementCredits,
          bankChargesNotInBooks: unreconciledStatementDebits,
          // The key health check number
          difference, // Per spec: must reach zero on fully reconciled period
          // Counts
          journalCount: journalLines.length,
          bankCount: bankLines.length,
          reconciledBankCount: bankLines.filter((l) => l.reconciled).length,
          unreconciledBankCount: bankLines.filter((l) => !l.reconciled).length,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Match a journal line to a bank statement line (Section 3.4 - Many-to-One)
// @route   POST /api/bank-accounts/:id/reconciliation/match
// @access  Private
exports.matchReconciliation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { journalEntryId, journalLineId, statementLineId } = req.body;

    if (!journalEntryId || !statementLineId) {
      return res.status(400).json({
        success: false,
        message: "journalEntryId and statementLineId are required",
      });
    }

    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    // Verify journal entry belongs to this bank account
    const ledgerAccountId =
      account.ledgerAccountId || account.accountCode || "1100";
    const journalEntry = await JournalEntry.findOne({
      _id: journalEntryId,
      company: companyId,
      status: "posted",
    });

    if (!journalEntry) {
      return res
        .status(404)
        .json({ success: false, message: "Journal entry not found" });
    }

    // Find the specific line (by ID if provided, or by account code)
    let targetLine = null;
    let targetLineIndex = -1;
    let targetLineId = null;

    if (journalLineId) {
      // Find by line ID
      for (let i = 0; i < journalEntry.lines.length; i++) {
        const lineId = journalEntry.lines[i]._id;
        if (lineId && lineId.toString() === journalLineId) {
          targetLine = journalEntry.lines[i];
          targetLineIndex = i;
          targetLineId = lineId;
          break;
        }
      }
    } else {
      // Fallback: find first line for this bank account
      for (let i = 0; i < journalEntry.lines.length; i++) {
        if (journalEntry.lines[i].accountCode === ledgerAccountId) {
          targetLine = journalEntry.lines[i];
          targetLineIndex = i;
          targetLineId = journalEntry.lines[i]._id;
          break;
        }
      }
    }

    if (!targetLine || targetLineIndex === -1 || !targetLineId) {
      return res.status(400).json({
        success: false,
        message: "Journal entry line not found for this bank account",
      });
    }

    // Verify statement line exists
    const statementLine = await BankStatementLine.findOne({
      _id: statementLineId,
      bankAccount: account._id,
    });

    if (!statementLine) {
      return res
        .status(404)
        .json({ success: false, message: "Bank statement line not found" });
    }

    // Check if match already exists (prevent duplicates)
    const existingMatch = await BankReconciliationMatch.findOne({
      bankStatementLine: statementLineId,
      journalEntryLineId: targetLineId,
    });

    if (existingMatch) {
      return res
        .status(400)
        .json({ success: false, message: "This match already exists" });
    }

    // Get the amount from the statement line
    const statementAmount = Math.abs(
      parseFloat(
        statementLine.creditAmount?.toString() ||
          statementLine.debitAmount?.toString() ||
          "0",
      ),
    );
    const isDebit = !!statementLine.debitAmount;

    // Calculate total matched amount for this statement line
    const existingMatches = await BankReconciliationMatch.find({
      bankStatementLine: statementLineId,
    }).lean();

    let totalMatchedAmount = 0;
    for (const m of existingMatches) {
      // We need to get the journal line amount
      const je = await JournalEntry.findById(m.journalEntry).lean();
      if (je) {
        const line = je.lines.find(
          (l) => l._id && l._id.toString() === m.journalEntryLineId.toString(),
        );
        if (line) {
          const debit = parseFloat(line.debit?.toString() || "0");
          const credit = parseFloat(line.credit?.toString() || "0");
          totalMatchedAmount += Math.abs(debit || credit);
        }
      }
    }

    // Add the new match amount
    const newMatchAmount = Math.abs(
      parseFloat(
        targetLine.debit?.toString() || targetLine.credit?.toString() || "0",
      ),
    );
    totalMatchedAmount += newMatchAmount;

    // Create match in junction table
    const match = new BankReconciliationMatch({
      bankStatementLine: statementLineId,
      journalEntryLineId: targetLineId,
      journalEntry: journalEntryId,
      bankAccount: account._id,
      company: companyId,
      matchedBy: req.user._id,
      matchedAmount: mongoose.Types.Decimal128.fromString(
        newMatchAmount.toString(),
      ),
    });

    await match.save();

    // Update journal entry line: set reconciled = TRUE (per spec: appears in at least one match)
    journalEntry.lines[targetLineIndex].reconciled = true;
    journalEntry.lines[targetLineIndex].matchedStatementLineId =
      statementLineId;
    await journalEntry.save();

    // Per spec: isReconciled = TRUE only when SUM(matched amounts) = statement line amount (exact match)
    const isFullyReconciled =
      Math.abs(totalMatchedAmount - statementAmount) < 0.01; // Allow tiny floating point difference
    statementLine.isReconciled = isFullyReconciled;
    statementLine.matchedAmount =
      totalMatchedAmount > 0
        ? mongoose.Types.Decimal128.fromString(totalMatchedAmount.toString())
        : null;
    await statementLine.save();

    res.json({
      success: true,
      message: isFullyReconciled
        ? "Successfully matched and fully reconciled bank statement line"
        : "Match created. Statement line partially reconciled (amounts do not match exactly)",
      data: {
        matchId: match._id,
        journalEntryId: journalEntry._id,
        journalLineId: targetLineId,
        statementLineId: statementLine._id,
        isReconciled: statementLine.isReconciled,
        matchedAmount: totalMatchedAmount,
        statementAmount: statementAmount,
        difference: statementAmount - totalMatchedAmount,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Unmatch a reconciliation (remove a match)
// @route   DELETE /api/bank-accounts/:id/reconciliation/match
// @access  Private
exports.unmatchReconciliation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { matchId } = req.params;

    if (!matchId) {
      return res
        .status(400)
        .json({ success: false, message: "matchId is required" });
    }

    // Find the match
    const match = await BankReconciliationMatch.findOne({
      _id: matchId,
      company: companyId,
    });

    if (!match) {
      return res
        .status(404)
        .json({ success: false, message: "Match not found" });
    }

    // Get the statement line and journal entry for updating
    const statementLine = await BankStatementLine.findById(
      match.bankStatementLine,
    );
    const journalEntry = await JournalEntry.findById(match.journalEntry);

    if (!statementLine || !journalEntry) {
      return res
        .status(404)
        .json({ success: false, message: "Related records not found" });
    }

    // Delete the match
    await BankReconciliationMatch.findByIdAndDelete(matchId);

    // Update journal entry line: check if other matches exist for this line
    const otherMatchesForLine = await BankReconciliationMatch.findOne({
      journalEntryLineId: match.journalEntryLineId,
    });

    if (!otherMatchesForLine) {
      // No other matches - mark as unreconciled (per spec: reconciled when appears in at least one match)
      const lineIndex = journalEntry.lines.findIndex(
        (l) =>
          l._id && l._id.toString() === match.journalEntryLineId.toString(),
      );
      if (lineIndex !== -1) {
        journalEntry.lines[lineIndex].reconciled = false;
        journalEntry.lines[lineIndex].matchedStatementLineId = null;
        await journalEntry.save();
      }
    }

    // Update statement line: Per spec, isReconciled = TRUE only when SUM(matched amounts) = statement line amount
    const remainingMatches = await BankReconciliationMatch.find({
      bankStatementLine: statementLine._id,
    }).lean();

    const statementAmount = Math.abs(
      parseFloat(
        statementLine.creditAmount?.toString() ||
          statementLine.debitAmount?.toString() ||
          "0",
      ),
    );

    let totalMatchedAmount = 0;
    for (const m of remainingMatches) {
      const je = await JournalEntry.findById(m.journalEntry).lean();
      if (je) {
        const line = je.lines.find(
          (l) => l._id && l._id.toString() === m.journalEntryLineId.toString(),
        );
        if (line) {
          const debit = parseFloat(line.debit?.toString() || "0");
          const credit = parseFloat(line.credit?.toString() || "0");
          totalMatchedAmount += Math.abs(debit || credit);
        }
      }
    }

    // Per spec: isReconciled = TRUE only when exact match
    const isFullyReconciled =
      Math.abs(totalMatchedAmount - statementAmount) < 0.01;
    statementLine.isReconciled = isFullyReconciled;
    statementLine.matchedAmount =
      totalMatchedAmount > 0
        ? mongoose.Types.Decimal128.fromString(totalMatchedAmount.toString())
        : null;
    await statementLine.save();

    res.json({
      success: true,
      message: "Match removed successfully",
      data: {
        remainingMatchesForStatementLine: remainingMatches,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Fix missing opening balance journal entries for existing accounts
// @route   POST /api/bank-accounts/fix-opening-balances
// @access  Private (admin only)
exports.fixOpeningBalances = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    // Get all active bank accounts for this company
    const accounts = await BankAccount.find({
      company: companyId,
      isActive: true,
    });

    const results = {
      processed: [],
      skipped: [],
      errors: [],
    };

    for (const account of accounts) {
      const openingBal = parseFloat(account.openingBalance?.toString() || "0");

      // Skip if no opening balance
      if (openingBal <= 0) {
        results.skipped.push({
          accountId: account._id,
          name: account.name,
          reason: "No opening balance",
        });
        continue;
      }

      // Check if opening balance journal entry already exists
      const existingEntry = await JournalEntry.findOne({
        company: companyId,
        sourceType: { $in: ["opening_balance", "bank_account_opening"] },
        sourceId: account._id,
      });

      if (existingEntry) {
        results.skipped.push({
          accountId: account._id,
          name: account.name,
          openingBalance: openingBal,
          reason: "Journal entry already exists",
          journalEntryId: existingEntry._id,
        });
        continue;
      }

      // Check if any "opening" type bank transaction exists
      const existingOpeningTx = await BankTransaction.findOne({
        account: account._id,
        type: "opening",
      });

      try {
        const ledgerAccountId = account.ledgerAccountId || "1100";
        const narration = `Opening balance (retroactive): ${account.name}`;

        // Create the journal entry
        const je = await JournalService.createEntry(companyId, req.user._id, {
          date: account.openingBalanceDate || new Date(),
          description: narration,
          sourceType: "bank_account_opening",
          sourceId: account._id,
          sourceReference: `OPENING-FIX-${account.accountNumber || account._id}`,
          lines: [
            JournalService.createDebitLine(ledgerAccountId, openingBal, narration),
            JournalService.createCreditLine(RETAINED_EARNINGS_CODE, openingBal, narration),
          ],
          isAutoGenerated: true,
        });

        // Create bank transaction record if it doesn't exist
        if (!existingOpeningTx) {
          await account.addTransaction({
            type: "opening",
            amount: openingBal,
            description: `Opening balance (retroactive fix)`,
            referenceNumber: `OPENING-FIX-${account.accountNumber || account._id}`,
            createdBy: req.user._id,
            status: "completed",
            journalEntryId: je._id,
          });
        }

        // Invalidate cache to force recompute from journal
        account.cacheValid = false;
        await account.save();

        results.processed.push({
          accountId: account._id,
          name: account.name,
          openingBalance: openingBal,
          journalEntryId: je._id,
        });
      } catch (error) {
        results.errors.push({
          accountId: account._id,
          name: account.name,
          openingBalance: openingBal,
          error: error.message,
        });
      }
    }

    res.json({
      success: true,
      message: `Fixed ${results.processed.length} accounts, skipped ${results.skipped.length}, errors ${results.errors.length}`,
      data: results,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create opening balance journal entry (Section 3.5)
// @route   POST /api/bank-accounts/:id/opening-balance
// @access  Private
exports.createOpeningBalance = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { openingBalance, openingBalanceDate } = req.body;

    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Bank account not found" });
    }

    // Check if opening balance already posted
    const existingOpeningEntry = await JournalEntry.findOne({
      company: companyId,
      sourceType: "opening_balance",
      sourceId: account._id,
    });

    if (existingOpeningEntry) {
      return res.status(400).json({
        success: false,
        message: "Opening balance entry already exists for this account",
      });
    }

    const openingBalNum = parseFloat(openingBalance);
    if (isNaN(openingBalNum) || openingBalNum === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Valid opening balance is required" });
    }

    const ledgerAccountId =
      account.ledgerAccountId || account.accountCode || "1100";
    const entryDate = openingBalanceDate
      ? new Date(openingBalanceDate)
      : new Date();

    // Create opening balance journal entry (per spec 3.5):
    // DR bank_account.ledger_account_id  opening_balance
    // CR 3200 Retained Earnings          opening_balance
    const narration = `Opening Balance - ${account.name}`;

    const journalEntry = await JournalService.createEntry(
      companyId,
      req.user._id,
      {
        date: entryDate,
        description: narration,
        sourceType: "opening_balance",
        sourceId: account._id,
        sourceReference: `OB-${account.name}`,
        lines: [
          JournalService.createDebitLine(
            ledgerAccountId,
            openingBalNum,
            narration,
          ),
          JournalService.createCreditLine(
            RETAINED_EARNINGS_CODE,
            openingBalNum,
            narration,
          ),
        ],
        isAutoGenerated: false,
      },
    );

    // Update account with opening balance and initialize cache
    // Per spec 3.3: Store opening balance, cache it as valid
    account.openingBalance = mongoose.Types.Decimal128.fromString(
      String(openingBalNum),
    );
    account.openingBalanceDate = entryDate;
    account.cachedBalance = mongoose.Types.Decimal128.fromString(
      String(openingBalNum),
    );
    account.cacheValid = true; // Opening balance is the anchor - cache is valid
    account.cacheLastComputed = new Date();
    await account.save();

    res.status(201).json({
      success: true,
      data: {
        journalEntry,
        openingBalance: openingBalNum,
        openingBalanceDate: entryDate,
        cachedBalance: openingBalNum,
        cacheValid: true,
      },
    });
  } catch (error) {
    next(error);
  }
};
