const mongoose = require("mongoose");
const { parse } = require("csv-parse/sync");
const BankReconciliationSession = require("../models/BankReconciliationSession");
const BankStatementTransaction = require("../models/BankStatementTransaction");
const { BankAccount, BankTransaction, BankReconciliationMatch } = require("../models/BankAccount");
const JournalEntry = require("../models/JournalEntry");
const journalAgg = require("./journalAggregationService");

function objectId(value) {
  return value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(value);
}

function toNumber(value) {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value.replace(/,/g, "")) || 0;
  if (value.toString) return Number(value.toString()) || 0;
  return Number(value) || 0;
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function getCompanyId(reqOrId) {
  return reqOrId?.company?._id || reqOrId?.companyId || reqOrId;
}

async function getScopedBankAccount(companyId, bankAccountId) {
  const account = await BankAccount.findOne({ _id: bankAccountId, company: companyId });
  if (!account) {
    const error = new Error("Bank account not found for this tenant.");
    error.statusCode = 404;
    throw error;
  }
  return account;
}

async function glBalance(companyId, bankAccount, asOfDate) {
  const openingBalance = toNumber(bankAccount.openingBalance);
  const openingDate = bankAccount.openingBalanceDate || new Date(0);
  const rows = await journalAgg.sumJournalLines(companyId, {
    dateFrom: openingDate,
    dateTo: new Date(asOfDate),
    status: "posted",
    accountCodes: [String(bankAccount.ledgerAccountId || "1100")],
    groupByAccountCode: false,
  });
  return round(openingBalance + toNumber(rows[0]?.debit) - toNumber(rows[0]?.credit));
}

async function assertEditableSession(companyId, sessionId) {
  const session = await BankReconciliationSession.findOne({ _id: sessionId, companyId });
  if (!session) {
    const error = new Error("Reconciliation session not found.");
    error.statusCode = 404;
    throw error;
  }
  if (session.status === "locked") {
    const error = new Error("Locked reconciliation sessions cannot be modified.");
    error.statusCode = 423;
    throw error;
  }
  return session;
}

function normaliseHeader(row, names) {
  for (const name of names) {
    const key = Object.keys(row).find((candidate) => candidate.trim().toLowerCase() === name);
    if (key) return row[key];
  }
  return undefined;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date;
  const match = String(value).match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!match) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return new Date(`${year}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}T00:00:00`);
}

async function createSession(companyId, userId, data) {
  const bankAccount = await getScopedBankAccount(companyId, data.bankAccountId);
  const periodStart = new Date(data.periodStart);
  const periodEnd = new Date(data.periodEnd);
  const openingBookBalance = await glBalance(companyId, bankAccount, new Date(periodStart.getTime() - 1));
  const closingBookBalance = await glBalance(companyId, bankAccount, periodEnd);
  const session = await BankReconciliationSession.create({
    companyId,
    bankAccountId: bankAccount._id,
    periodStart,
    periodEnd,
    openingBookBalance,
    closingBookBalance,
    openingStatementBalance: toNumber(data.openingStatementBalance),
    closingStatementBalance: toNumber(data.closingStatementBalance),
    notes: data.notes || null,
  });
  await refreshSummary(companyId, session._id);
  return session;
}

async function listSessions(companyId, filters = {}) {
  const query = { companyId };
  if (filters.bankAccountId) query.bankAccountId = filters.bankAccountId;
  if (filters.status) query.status = filters.status;
  return BankReconciliationSession.find(query).populate("bankAccountId", "name bankName accountNumber").sort({ periodEnd: -1 });
}

async function getSession(companyId, sessionId) {
  const session = await BankReconciliationSession.findOne({ _id: sessionId, companyId }).populate("bankAccountId", "name bankName accountNumber");
  if (!session) {
    const error = new Error("Reconciliation session not found.");
    error.statusCode = 404;
    throw error;
  }
  return session;
}

async function listStatementTransactions(companyId, sessionId, matchStatus) {
  const session = await getSession(companyId, sessionId);
  const query = { companyId, reconciliationSessionId: session._id };
  if (matchStatus) query.matchStatus = matchStatus;
  return BankStatementTransaction.find(query).sort({ date: 1, _id: 1 });
}

async function addStatementTransaction(companyId, sessionId, data, importSource = "manual") {
  const session = await assertEditableSession(companyId, sessionId);
  const tx = await BankStatementTransaction.create({
    companyId,
    bankAccountId: session.bankAccountId,
    reconciliationSessionId: session._id,
    date: new Date(data.date),
    description: data.description,
    reference: data.reference || null,
    debit: toNumber(data.debit),
    credit: toNumber(data.credit),
    balance: toNumber(data.balance),
    importSource,
    isAdjustment: Boolean(data.isAdjustment),
  });
  await refreshSummary(companyId, session._id);
  return tx;
}

async function importStatement(companyId, sessionId, fileBuffer, source = "csv") {
  const session = await assertEditableSession(companyId, sessionId);
  const rows = parse(fileBuffer.toString("utf8"), { columns: true, skip_empty_lines: true, trim: true });
  const errors = [];
  const docs = [];
  rows.forEach((row, index) => {
    const date = parseDate(normaliseHeader(row, ["date", "transaction date", "value date", "posting date"]));
    const description = normaliseHeader(row, ["description", "narration", "details", "transaction details"]);
    const debit = toNumber(normaliseHeader(row, ["debit", "withdrawal", "money out", "paid out", "dr"]));
    const credit = toNumber(normaliseHeader(row, ["credit", "deposit", "money in", "paid in", "cr"]));
    const balance = toNumber(normaliseHeader(row, ["balance", "running balance", "closing balance"]));
    if (!date || !description) {
      errors.push({ row: index + 2, message: "Missing or invalid date/description." });
      return;
    }
    if (debit > 0 && credit > 0) {
      errors.push({ row: index + 2, message: "Row has both debit and credit amounts." });
      return;
    }
    docs.push({
      companyId,
      bankAccountId: session.bankAccountId,
      reconciliationSessionId: session._id,
      date,
      description,
      reference: normaliseHeader(row, ["reference", "ref", "transaction reference", "cheque no"]) || null,
      debit,
      credit,
      balance,
      importSource: source,
    });
  });
  const imported = docs.length ? await BankStatementTransaction.insertMany(docs) : [];
  await refreshSummary(companyId, session._id);
  return { imported: imported.length, errors };
}

async function deleteStatementTransaction(companyId, sessionId, transactionId) {
  await assertEditableSession(companyId, sessionId);
  const tx = await BankStatementTransaction.findOne({ _id: transactionId, companyId, reconciliationSessionId: sessionId });
  if (!tx) {
    const error = new Error("Statement transaction not found.");
    error.statusCode = 404;
    throw error;
  }
  if (tx.matchStatus === "matched") {
    const error = new Error("Matched statement transactions cannot be deleted.");
    error.statusCode = 409;
    throw error;
  }
  await tx.deleteOne();
  await refreshSummary(companyId, sessionId);
}

async function listBookTransactions(companyId, sessionId, matchStatus) {
  const session = await getSession(companyId, sessionId);
  const query = {
    $and: [
      { $or: [{ companyId }, { company: companyId }] },
      { $or: [{ bankAccountId: session.bankAccountId }, { account: session.bankAccountId }] },
    ],
    date: { $gte: session.periodStart, $lte: session.periodEnd },
  };
  if (matchStatus === "matched") query.reconciliationStatus = "reconciled";
  if (matchStatus === "unmatched") query.reconciliationStatus = { $ne: "reconciled" };
  return BankTransaction.find(query).sort({ date: 1, _id: 1 });
}

async function createMatch(companyId, userId, sessionId, data, matchType = "manual") {
  const session = await assertEditableSession(companyId, sessionId);
  const [bookTx, statementTx] = await Promise.all([
    BankTransaction.findOne({
      _id: data.bookTransactionId,
      $and: [
        { $or: [{ companyId }, { company: companyId }] },
        { $or: [{ bankAccountId: session.bankAccountId }, { account: session.bankAccountId }] },
      ],
      reconciliationStatus: { $ne: "reconciled" },
    }),
    BankStatementTransaction.findOne({
      _id: data.statementTransactionId,
      companyId,
      reconciliationSessionId: session._id,
      matchStatus: "unmatched",
    }),
  ]);
  if (!bookTx || !statementTx) {
    const error = new Error("Both transactions must belong to this session and be unmatched.");
    error.statusCode = 409;
    throw error;
  }
  const bookAmount = toNumber(bookTx.amount);
  const statementAmount = toNumber(statementTx.credit || statementTx.debit);
  if (round(bookAmount) !== round(statementAmount)) {
    const error = new Error("Matched transactions must have the same amount.");
    error.statusCode = 409;
    throw error;
  }
  const match = await BankReconciliationMatch.create({
    companyId,
    company: companyId,
    sessionId: session._id,
    bookTransactionId: bookTx._id,
    statementTransactionId: statementTx._id,
    journalEntryLineId: bookTx.journalEntryLineId,
    journalEntry: bookTx.journalEntryId,
    bankAccount: session.bankAccountId,
    matchedBy: userId,
    matchType,
    amount: statementAmount,
    matchedAmount: mongoose.Types.Decimal128.fromString(String(statementAmount)),
  });
  bookTx.reconciliationStatus = "reconciled";
  bookTx.reconciledSessionId = session._id;
  statementTx.matchStatus = "matched";
  statementTx.matchedBookTransactionId = bookTx._id;
  await Promise.all([bookTx.save(), statementTx.save()]);
  await refreshSummary(companyId, session._id);
  return match;
}

async function autoMatch(companyId, userId, sessionId, toleranceDays = 2) {
  const books = await listBookTransactions(companyId, sessionId, "unmatched");
  const statements = await listStatementTransactions(companyId, sessionId, "unmatched");
  const matches = [];
  for (const book of books) {
    const candidates = statements.filter((statement) => {
      if (statement.matchStatus !== "unmatched") return false;
      if (round(toNumber(statement.credit || statement.debit)) !== round(toNumber(book.amount))) return false;
      return Math.abs(new Date(statement.date) - new Date(book.date)) / 86400000 <= toleranceDays;
    });
    if (candidates.length !== 1) continue;
    matches.push(await createMatch(companyId, userId, sessionId, {
      bookTransactionId: book._id,
      statementTransactionId: candidates[0]._id,
    }, "auto"));
    candidates[0].matchStatus = "matched";
  }
  return { matched: matches.length };
}

async function deleteMatch(companyId, matchId) {
  const match = await BankReconciliationMatch.findOne({ _id: matchId, companyId });
  if (!match) {
    const error = new Error("Match not found.");
    error.statusCode = 404;
    throw error;
  }
  const session = await assertEditableSession(companyId, match.sessionId);
  await Promise.all([
    BankTransaction.updateOne({ _id: match.bookTransactionId, $or: [{ companyId }, { company: companyId }] }, { $set: { reconciliationStatus: "unreconciled" }, $unset: { reconciledSessionId: "" } }),
    BankStatementTransaction.updateOne({ _id: match.statementTransactionId, companyId }, { $set: { matchStatus: "unmatched" }, $unset: { matchedBookTransactionId: "" } }),
    match.deleteOne(),
  ]);
  await refreshSummary(companyId, session._id);
}

async function calculateSummary(companyId, sessionId) {
  const session = await getSession(companyId, sessionId);
  const [bookTransactions, statementTransactions] = await Promise.all([
    listBookTransactions(companyId, sessionId),
    listStatementTransactions(companyId, sessionId),
  ]);
  const unmatchedBook = bookTransactions.filter((tx) => tx.reconciliationStatus !== "reconciled");
  const unmatchedStatements = statementTransactions.filter((tx) => tx.matchStatus !== "matched");
  const outstandingDeposits = round(unmatchedBook.filter((tx) => tx.type === "debit" || tx.type === "deposit" || tx.type === "transfer_in").reduce((sum, tx) => sum + toNumber(tx.amount), 0));
  const outstandingChecks = round(unmatchedBook.filter((tx) => tx.type === "credit" || tx.type === "withdrawal" || tx.type === "transfer_out").reduce((sum, tx) => sum + toNumber(tx.amount), 0));
  const unrecordedBankCredits = round(unmatchedStatements.reduce((sum, tx) => sum + toNumber(tx.credit), 0));
  const unrecordedBankCharges = round(unmatchedStatements.reduce((sum, tx) => sum + toNumber(tx.debit), 0));
  const adjustedBookBalance = round(toNumber(session.closingBookBalance) + unrecordedBankCredits - unrecordedBankCharges);
  const adjustedBankBalance = round(toNumber(session.closingStatementBalance) + outstandingDeposits - outstandingChecks);
  const difference = round(adjustedBookBalance - adjustedBankBalance);
  return {
    closingBookBalance: toNumber(session.closingBookBalance),
    unrecordedBankCredits,
    unrecordedBankCharges,
    adjustedBookBalance,
    closingStatementBalance: toNumber(session.closingStatementBalance),
    outstandingDeposits,
    outstandingChecks,
    adjustedBankBalance,
    isBalanced: Math.abs(difference) < 0.01,
    difference,
    unrecordedBankItems: round(unrecordedBankCredits - unrecordedBankCharges),
    bookTransactions,
    statementTransactions,
  };
}

async function refreshSummary(companyId, sessionId) {
  const summary = await calculateSummary(companyId, sessionId);
  await BankReconciliationSession.updateOne(
    { _id: sessionId, companyId },
    {
      $set: {
        adjustedBookBalance: summary.adjustedBookBalance,
        adjustedBankBalance: summary.adjustedBankBalance,
        isBalanced: summary.isBalanced,
        outstandingDeposits: summary.outstandingDeposits,
        outstandingChecks: summary.outstandingChecks,
        unrecordedBankItems: summary.unrecordedBankItems,
      },
    },
  );
  return summary;
}

async function complete(companyId, userId, sessionId) {
  const session = await assertEditableSession(companyId, sessionId);
  const summary = await refreshSummary(companyId, session._id);
  if (!summary.isBalanced) {
    const error = new Error("Reconciliation cannot be completed until the adjusted balances agree.");
    error.statusCode = 409;
    throw error;
  }
  session.status = "completed";
  session.completedAt = new Date();
  session.completedBy = userId;
  await session.save();
  return session;
}

async function lock(companyId, sessionId) {
  const session = await getSession(companyId, sessionId);
  if (session.status !== "completed") {
    const error = new Error("Only completed reconciliation sessions can be locked.");
    error.statusCode = 409;
    throw error;
  }
  session.status = "locked";
  session.lockedAt = new Date();
  await session.save();
  return session;
}

module.exports = {
  getCompanyId,
  createSession,
  listSessions,
  getSession,
  importStatement,
  addStatementTransaction,
  listStatementTransactions,
  deleteStatementTransaction,
  listBookTransactions,
  createMatch,
  autoMatch,
  deleteMatch,
  calculateSummary,
  refreshSummary,
  complete,
  lock,
};
