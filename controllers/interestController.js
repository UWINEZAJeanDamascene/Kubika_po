const mongoose = require("mongoose");
const { parseOptionalPagination, paginationMeta } = require('../utils/pagination');
const BankAccount = require("../models/BankAccount");
const FixedDeposit = require("../models/FixedDeposit");
const InterestAccrual = require("../models/InterestAccrual");
const JournalEntry = require("../models/JournalEntry");
const JournalService = require("../services/journalService");

// Helper: get days in a given month/year
function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// Helper: get last day of month
function getLastDayOfMonth(year, month) {
  return new Date(year, month, 0);
}

// Helper: compute balance for a bank account as of a date
async function getAccountBalance(account, asOfDate) {
  const ledgerAccountId = account.ledgerAccountId || "1100";
  const openingBalance = parseFloat(account.openingBalance?.toString?.() || account.openingBalance || 0);
  const openingBalanceDate = account.openingBalanceDate || new Date(0);

  const dateQuery = { $gte: openingBalanceDate };
  if (asOfDate) dateQuery.$lte = new Date(asOfDate);

  const agg = await JournalEntry.aggregate([
    { $match: { company: account.company, status: "posted", date: dateQuery } },
    { $unwind: "$lines" },
    { $match: { "lines.accountCode": ledgerAccountId } },
    {
      $group: {
        _id: null,
        totalDebits: { $sum: { $toDouble: { $ifNull: ["$lines.debit", 0] } } },
        totalCredits: { $sum: { $toDouble: { $ifNull: ["$lines.credit", 0] } } },
      },
    },
  ]);

  let totalDebits = 0;
  let totalCredits = 0;
  if (agg && agg[0]) {
    totalDebits = agg[0].totalDebits || 0;
    totalCredits = agg[0].totalCredits || 0;
  }
  return totalDebits - totalCredits;
}

// Calculate interest for a single bank account for a period
function calculateInterest(principal, rate, method, daysInPeriod) {
  const r = rate / 100;
  let interest = 0;

  switch (method) {
    case "simple":
      interest = principal * r * (daysInPeriod / 365);
      break;
    case "compound_monthly":
      interest = principal * (Math.pow(1 + r / 12, 1) - 1);
      break;
    case "compound_quarterly":
      interest = principal * (Math.pow(1 + r / 4, 1) - 1);
      break;
    case "daily_average":
      // For daily average, principal is already the average balance
      interest = principal * r * (daysInPeriod / 365);
      break;
    default:
      interest = principal * r * (daysInPeriod / 365);
  }

  return Math.round(interest * 100) / 100;
}

// @desc    Preview interest calculation for a bank account (manual trigger - Option C)
// @route   POST /api/bank-accounts/:id/interest-calculate
// @access  Private
exports.previewInterest = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const { year, month } = req.body;
    const targetYear = year || new Date().getFullYear();
    const targetMonth = month || new Date().getMonth() + 1;

    const account = await BankAccount.findOne({ _id: req.params.id, company: cid });
    if (!account) return res.status(404).json({ success: false, message: "Bank account not found" });

    if (account.interestAccountType === "current") {
      return res.status(400).json({ success: false, message: "Current accounts do not earn interest" });
    }

    const daysInPeriod = getDaysInMonth(targetYear, targetMonth);
    const periodEnd = getLastDayOfMonth(targetYear, targetMonth);
    const balance = await getAccountBalance(account, periodEnd);

    if (balance <= 0) {
      return res.json({ success: true, data: { principal: balance, interest: 0, skipped: true, reason: "Zero or negative balance" } });
    }

    // Check for duplicate
    const existing = await InterestAccrual.findOne({
      company: cid,
      bankAccount: account._id,
      "period.month": targetMonth,
      "period.year": targetYear,
    });
    if (existing && existing.status !== "reversed") {
      return res.status(409).json({ success: false, message: "Interest already calculated for this period", data: existing });
    }

    const interest = calculateInterest(balance, account.interestRate, account.interestCalculationMethod, daysInPeriod);

    res.json({
      success: true,
      data: {
        bankAccountId: account._id,
        bankAccountName: account.name,
        period: { month: targetMonth, year: targetYear },
        principal: balance,
        rate: account.interestRate,
        method: account.interestCalculationMethod,
        daysInPeriod,
        calculatedInterest: interest,
        interestIncomeAccount: account.interestIncomeAccount || "4300",
        interestAccrualAccount: account.interestAccrualAccount || "1350",
        bankStatementReference: account.bankStatementReference,
        preview: true,
      },
    });
  } catch (e) { next(e); }
};

// @desc    Post interest accrual journal entry (Step 1 of two-step)
// @route   POST /api/bank-accounts/:id/interest-post
// @access  Private (admin)
exports.postInterest = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const uid = req.user.id;
    const { year, month, singleStep } = req.body;
    const targetYear = year || new Date().getFullYear();
    const targetMonth = month || new Date().getMonth() + 1;

    const account = await BankAccount.findOne({ _id: req.params.id, company: cid });
    if (!account) return res.status(404).json({ success: false, message: "Bank account not found" });

    if (account.interestAccountType === "current") {
      return res.status(400).json({ success: false, message: "Current accounts do not earn interest" });
    }

    // Check duplicate
    const existing = await InterestAccrual.findOne({
      company: cid,
      bankAccount: account._id,
      "period.month": targetMonth,
      "period.year": targetYear,
    });
    if (existing && existing.status !== "reversed") {
      return res.status(409).json({ success: false, message: "Interest already posted for this period" });
    }

    const daysInPeriod = getDaysInMonth(targetYear, targetMonth);
    const periodEnd = getLastDayOfMonth(targetYear, targetMonth);
    const balance = await getAccountBalance(account, periodEnd);

    if (balance <= 0) {
      return res.json({ success: true, skipped: true, reason: "Zero or negative balance" });
    }

    const interest = calculateInterest(balance, account.interestRate, account.interestCalculationMethod, daysInPeriod);
    const incomeAcct = account.interestIncomeAccount || "4300";
    const accrualAcct = account.interestAccrualAccount || "1350";
    const bankAcct = account.ledgerAccountId || "1100";

    let journalEntry;
    let receiptEntry;

    if (singleStep) {
      // Single-step: Dr Bank, Cr Income directly
      journalEntry = await JournalService.createEntry(cid, uid, {
        date: periodEnd,
        description: `Interest income - ${account.name} (${targetMonth}/${targetYear})`,
        reference: `INT-SINGLE-${account._id.toString().slice(-6)}-${targetYear}${String(targetMonth).padStart(2, "0")}`,
        source: "interest_income_auto",
        lines: [
          { accountCode: bankAcct, debit: interest, credit: 0, description: "Interest received" },
          { accountCode: incomeAcct, debit: 0, credit: interest, description: "Interest income" },
        ],
      });
    } else {
      // Two-step: Step 1 - Accrual (Dr Receivable, Cr Income)
      journalEntry = await JournalService.createEntry(cid, uid, {
        date: periodEnd,
        description: `Interest accrual - ${account.name} (${targetMonth}/${targetYear})`,
        reference: `INT-ACCR-${account._id.toString().slice(-6)}-${targetYear}${String(targetMonth).padStart(2, "0")}`,
        source: "interest_income_auto",
        lines: [
          { accountCode: accrualAcct, debit: interest, credit: 0, description: "Interest receivable" },
          { accountCode: incomeAcct, debit: 0, credit: interest, description: "Interest income" },
        ],
      });
    }

    const accrual = await InterestAccrual.create({
      company: cid,
      bankAccount: account._id,
      period: { month: targetMonth, year: targetYear },
      principal: balance,
      rate: account.interestRate,
      daysInPeriod,
      calculatedInterest: interest,
      method: account.interestCalculationMethod,
      status: singleStep ? "posted" : "pending",
      journalEntryId: singleStep ? journalEntry._id : null,
      accrualJournalEntryId: singleStep ? null : journalEntry._id,
      source: "auto",
      sourceTag: "interest_income_auto",
      createdBy: uid,
    });

    account.lastInterestPostedDate = periodEnd;
    await account.save();

    res.json({ success: true, data: { accrual, journalEntry, singleStep } });
  } catch (e) { next(e); }
};

// @desc    Confirm interest receipt (Step 2 of two-step)
// @route   POST /api/bank-accounts/interest/:accrualId/confirm
// @access  Private (admin)
exports.confirmInterestReceipt = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const uid = req.user.id;

    const accrual = await InterestAccrual.findOne({ _id: req.params.accrualId, company: cid });
    if (!accrual) return res.status(404).json({ success: false, message: "Accrual not found" });
    if (accrual.status !== "pending") return res.status(409).json({ success: false, message: `Cannot confirm in status: ${accrual.status}` });

    const account = await BankAccount.findOne({ _id: accrual.bankAccount, company: cid });
    const bankAcct = account?.ledgerAccountId || "1100";
    const accrualAcct = account?.interestAccrualAccount || "1350";
    const interest = parseFloat(accrual.calculatedInterest?.toString?.() || accrual.calculatedInterest || 0);

    const receiptEntry = await JournalService.createEntry(cid, uid, {
      date: new Date(),
      description: `Interest receipt - ${account?.name || "Bank Account"} (${accrual.period.month}/${accrual.period.year})`,
      reference: `INT-RCPT-${accrual._id.toString().slice(-6)}`,
      source: "interest_income_auto",
      lines: [
        { accountCode: bankAcct, debit: interest, credit: 0, description: "Cash at bank - interest" },
        { accountCode: accrualAcct, debit: 0, credit: interest, description: "Clear interest receivable" },
      ],
    });

    accrual.status = "confirmed";
    accrual.receiptJournalEntryId = receiptEntry._id;
    accrual.confirmedAt = new Date();
    accrual.confirmedBy = uid;
    await accrual.save();

    res.json({ success: true, data: { accrual, receiptEntry } });
  } catch (e) { next(e); }
};

// @desc    Reverse an interest posting
// @route   POST /api/bank-accounts/interest/:accrualId/reverse
// @access  Private (admin)
exports.reverseInterest = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const uid = req.user.id;

    const accrual = await InterestAccrual.findOne({ _id: req.params.accrualId, company: cid });
    if (!accrual) return res.status(404).json({ success: false, message: "Accrual not found" });
    if (accrual.status === "reversed") return res.status(409).json({ success: false, message: "Already reversed" });

    // Reverse journal entries via JournalService if available, otherwise mark as reversed
    accrual.status = "reversed";
    await accrual.save();

    res.json({ success: true, message: "Interest posting reversed", data: accrual });
  } catch (e) { next(e); }
};

// @desc    Get interest accruals for a company
// @route   GET /api/bank-accounts/interest-accruals
// @access  Private
exports.getInterestAccruals = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const { bankAccount, year, month, status } = req.query;
    const filter = { company: cid };
    if (bankAccount) filter.bankAccount = bankAccount;
    if (status) filter.status = status;
    if (year) filter["period.year"] = parseInt(year);
    if (month) filter["period.month"] = parseInt(month);

    const accruals = await InterestAccrual.find(filter)
      .populate("bankAccount", "name ledgerAccountId")
      .sort({ "period.year": -1, "period.month": -1 });

    res.json({ success: true, count: accruals.length, data: accruals });
  } catch (e) { next(e); }
};

// @desc    Get interest-bearing bank accounts summary
// @route   GET /api/bank-accounts/interest-summary
// @access  Private
exports.getInterestSummary = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const accounts = await BankAccount.find({ company: cid, interestAccountType: { $ne: "current" } });

    const summary = [];
    for (const account of accounts) {
      const balance = await getAccountBalance(account);
      summary.push({
        _id: account._id,
        name: account.name,
        accountType: account.interestAccountType,
        rate: account.interestRate,
        method: account.interestCalculationMethod,
        balance,
        lastInterestPostedDate: account.lastInterestPostedDate,
      });
    }

    res.json({ success: true, count: summary.length, data: summary });
  } catch (e) { next(e); }
};

// ===================== FIXED DEPOSIT CONTROLLERS =====================

// @desc    Create fixed deposit
// @route   POST /api/fixed-deposits
// @access  Private (admin)
exports.createFixedDeposit = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const fd = await FixedDeposit.create({ ...req.body, company: cid, createdBy: req.user.id });
    res.status(201).json({ success: true, data: fd });
  } catch (e) { next(e); }
};

// @desc    Get all fixed deposits
// @route   GET /api/fixed-deposits
// @access  Private
exports.getFixedDeposits = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const { status } = req.query;
    const filter = { company: cid };
    if (status) filter.status = status;

    // Opt-in pagination — see parseOptionalPagination.
    const { paginated, page, limit, skip } = parseOptionalPagination(req.query, { defaultLimit: 50 });
    let query = FixedDeposit.find(filter)
      .populate("bankAccount", "name")
      .sort({ maturityDate: 1 });
    if (paginated) query = query.skip(skip).limit(limit);

    const fds = await query;
    const total = paginated ? await FixedDeposit.countDocuments(filter) : fds.length;

    res.json({
      success: true,
      count: fds.length,
      data: fds,
      pagination: paginationMeta(page, limit || fds.length || 1, total),
    });
  } catch (e) { next(e); }
};

// @desc    Get single fixed deposit
// @route   GET /api/fixed-deposits/:id
// @access  Private
exports.getFixedDeposit = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const fd = await FixedDeposit.findOne({ _id: req.params.id, company: cid }).populate("bankAccount", "name");
    if (!fd) return res.status(404).json({ success: false, message: "Fixed deposit not found" });
    res.json({ success: true, data: fd });
  } catch (e) { next(e); }
};

// @desc    Update fixed deposit
// @route   PUT /api/fixed-deposits/:id
// @access  Private (admin)
exports.updateFixedDeposit = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const fd = await FixedDeposit.findOneAndUpdate(
      { _id: req.params.id, company: cid },
      req.body,
      { new: true, runValidators: true }
    );
    if (!fd) return res.status(404).json({ success: false, message: "Fixed deposit not found" });
    res.json({ success: true, data: fd });
  } catch (e) { next(e); }
};

// @desc    Delete fixed deposit
// @route   DELETE /api/fixed-deposits/:id
// @access  Private (admin)
exports.deleteFixedDeposit = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const fd = await FixedDeposit.findOneAndDelete({ _id: req.params.id, company: cid });
    if (!fd) return res.status(404).json({ success: false, message: "Fixed deposit not found" });
    res.json({ success: true, message: "Fixed deposit deleted" });
  } catch (e) { next(e); }
};

// @desc    Post FD placement journal (on creation)
// @route   POST /api/fixed-deposits/:id/place
// @access  Private (admin)
exports.placeFixedDeposit = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const uid = req.user.id;
    const fd = await FixedDeposit.findOne({ _id: req.params.id, company: cid });
    if (!fd) return res.status(404).json({ success: false, message: "Fixed deposit not found" });

    const principal = parseFloat(fd.principalAmount?.toString?.() || fd.principalAmount || 0);
    const assetAcct = fd.linkedAssetAccount || "1105";
    const bankAcct = fd.bankAccount ? (await BankAccount.findById(fd.bankAccount))?.ledgerAccountId || "1100" : "1100";

    const entry = await JournalService.createEntry(cid, uid, {
      date: fd.startDate,
      description: `Fixed deposit placement - ${fd.depositReference}`,
      reference: `FD-PLACE-${fd._id.toString().slice(-6)}`,
      source: "fixed_deposit_auto",
      lines: [
        { accountCode: assetAcct, debit: principal, credit: 0, description: "Fixed deposit asset" },
        { accountCode: bankAcct, debit: 0, credit: principal, description: "Cash at bank" },
      ],
    });

    res.json({ success: true, data: { fixedDeposit: fd, journalEntry: entry } });
  } catch (e) { next(e); }
};

// @desc    Post FD monthly accrual
// @route   POST /api/fixed-deposits/:id/accrue
// @access  Private (admin)
exports.accrueFixedDeposit = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const uid = req.user.id;
    const { year, month } = req.body;
    const targetYear = year || new Date().getFullYear();
    const targetMonth = month || new Date().getMonth() + 1;

    const fd = await FixedDeposit.findOne({ _id: req.params.id, company: cid });
    if (!fd) return res.status(404).json({ success: false, message: "Fixed deposit not found" });
    if (fd.status !== "active") return res.status(409).json({ success: false, message: `Cannot accrue in status: ${fd.status}` });

    const daysInPeriod = getDaysInMonth(targetYear, targetMonth);
    const principal = parseFloat(fd.principalAmount?.toString?.() || fd.principalAmount || 0);
    const interest = calculateInterest(principal, fd.interestRate, "simple", daysInPeriod);
    const periodEnd = getLastDayOfMonth(targetYear, targetMonth);

    const incomeAcct = fd.linkedIncomeAccount || "4300";
    const accrualAcct = fd.linkedAccrualAccount || "1350";

    // Check duplicate
    const existing = await InterestAccrual.findOne({
      company: cid,
      fixedDeposit: fd._id,
      "period.month": targetMonth,
      "period.year": targetYear,
    });
    if (existing && existing.status !== "reversed") {
      return res.status(409).json({ success: false, message: "Accrual already posted for this period" });
    }

    const entry = await JournalService.createEntry(cid, uid, {
      date: periodEnd,
      description: `FD interest accrual - ${fd.depositReference} (${targetMonth}/${targetYear})`,
      reference: `FD-ACCR-${fd._id.toString().slice(-6)}-${targetYear}${String(targetMonth).padStart(2, "0")}`,
      source: "fixed_deposit_auto",
      lines: [
        { accountCode: accrualAcct, debit: interest, credit: 0, description: "Interest receivable" },
        { accountCode: incomeAcct, debit: 0, credit: interest, description: "Interest income" },
      ],
    });

    const accrual = await InterestAccrual.create({
      company: cid,
      fixedDeposit: fd._id,
      period: { month: targetMonth, year: targetYear },
      principal,
      rate: fd.interestRate,
      daysInPeriod,
      calculatedInterest: interest,
      method: "simple",
      status: "pending",
      accrualJournalEntryId: entry._id,
      source: "auto",
      sourceTag: "fixed_deposit_auto",
      createdBy: uid,
    });

    fd.totalInterestAccrued = mongoose.Types.Decimal128.fromString(
      String((parseFloat(fd.totalInterestAccrued?.toString?.() || fd.totalInterestAccrued || 0) + interest))
    );
    await fd.save();

    res.json({ success: true, data: { accrual, journalEntry: entry } });
  } catch (e) { next(e); }
};

// @desc    Mature fixed deposit and post receipt journal
// @route   POST /api/fixed-deposits/:id/mature
// @access  Private (admin)
exports.matureFixedDeposit = async (req, res, next) => {
  try {
    const cid = req.user.company._id;
    const uid = req.user.id;
    const fd = await FixedDeposit.findOne({ _id: req.params.id, company: cid });
    if (!fd) return res.status(404).json({ success: false, message: "Fixed deposit not found" });

    const principal = parseFloat(fd.principalAmount?.toString?.() || fd.principalAmount || 0);
    const totalInterest = parseFloat(fd.totalInterestAccrued?.toString?.() || fd.totalInterestAccrued || 0);
    const totalReceipt = principal + totalInterest;

    const assetAcct = fd.linkedAssetAccount || "1105";
    const bankAcct = fd.bankAccount ? (await BankAccount.findById(fd.bankAccount))?.ledgerAccountId || "1100" : "1100";
    const accrualAcct = fd.linkedAccrualAccount || "1350";

    const entry = await JournalService.createEntry(cid, uid, {
      date: fd.maturityDate,
      description: `Fixed deposit maturity - ${fd.depositReference}`,
      reference: `FD-MATURE-${fd._id.toString().slice(-6)}`,
      source: "fixed_deposit_auto",
      lines: [
        { accountCode: bankAcct, debit: totalReceipt, credit: 0, description: "Cash at bank - principal + interest" },
        { accountCode: assetAcct, debit: 0, credit: principal, description: "Fixed deposit principal returned" },
        { accountCode: accrualAcct, debit: 0, credit: totalInterest, description: "Interest receivable cleared" },
      ],
    });

    fd.status = "matured";
    fd.totalInterestReceived = mongoose.Types.Decimal128.fromString(String(totalInterest));
    await fd.save();

    res.json({ success: true, data: { fixedDeposit: fd, journalEntry: entry } });
  } catch (e) { next(e); }
};
