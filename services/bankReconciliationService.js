const { parse } = require("csv-parse/sync");
const { dbClient } = require("../lib/prisma");
const { parseBoundedPage } = require("../utils/querySafety");
const BankReconciliationSession = require("../models/BankReconciliationSession");
const BankStatementTransaction = require("../models/BankStatementTransaction");
const { BankAccount, BankTransaction, BankReconciliationMatch } = require("../models/BankAccount");
const JournalEntry = require("../models/JournalEntry");
const journalAgg = require("./journalAggregationService");

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

const RECON_MAX_PAGE_SIZE = 100;
const RECON_MAX_BATCH_ROWS = Math.max(RECON_MAX_PAGE_SIZE, Number(process.env.RECONCILIATION_MAX_BATCH_ROWS || 5000));

function pageMeta(page, limit, total) {
  return { page, limit, total, pages: total ? Math.ceil(total / limit) : 0 };
}

async function fetchAllPages(loadPage, purpose) {
  const rows = [];
  let page = 1;
  let total = null;
  while (rows.length < RECON_MAX_BATCH_ROWS) {
    const result = await loadPage({ page, limit: RECON_MAX_PAGE_SIZE });
    rows.push(...result.rows);
    total = result.pagination.total;
    if (rows.length >= total || result.rows.length < RECON_MAX_PAGE_SIZE) return rows;
    page += 1;
  }
  throw Object.assign(new Error(`${purpose} exceeds the ${RECON_MAX_BATCH_ROWS}-row batch limit`), {
    code: 'READ_BATCH_EXCEEDED',
    statusCode: 413,
  });
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
  const { page, limit, skip } = parseBoundedPage(filters, { defaultLimit: 50, maxLimit: RECON_MAX_PAGE_SIZE });
  const [rows, total] = await Promise.all([
    BankReconciliationSession.find(query)
      .populate("bankAccountId", "name bankName accountNumber")
      .sort({ periodEnd: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    BankReconciliationSession.countDocuments(query),
  ]);
  return { data: rows, pagination: pageMeta(page, limit, total) };
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

async function listStatementTransactions(companyId, sessionId, filters = {}) {
  const session = await getSession(companyId, sessionId);
  const query = { companyId, reconciliationSessionId: session._id };
  const matchStatus = typeof filters === 'string' ? filters : filters.matchStatus;
  if (matchStatus) query.matchStatus = matchStatus;
  const { page, limit, skip } = parseBoundedPage(typeof filters === 'string' ? {} : filters, { defaultLimit: 100, maxLimit: RECON_MAX_PAGE_SIZE });
  const [rows, total] = await Promise.all([
    BankStatementTransaction.find(query).sort({ date: 1, _id: 1 }).skip(skip).limit(limit),
    BankStatementTransaction.countDocuments(query),
  ]);
  return { data: rows, rows, pagination: pageMeta(page, limit, total) };
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

async function listBookTransactions(companyId, sessionId, filters = {}) {
  const session = await getSession(companyId, sessionId);
  const matchStatus = typeof filters === 'string' ? filters : filters.matchStatus;
  const query = {
    $and: [
      { $or: [{ companyId }, { company: companyId }] },
      { $or: [{ bankAccountId: session.bankAccountId }, { account: session.bankAccountId }] },
    ],
    date: { $gte: session.periodStart, $lte: session.periodEnd },
  };
  if (matchStatus === "matched") query.reconciliationStatus = "reconciled";
  if (matchStatus === "unmatched") query.reconciliationStatus = { $ne: "reconciled" };
  const { page, limit, skip } = parseBoundedPage(typeof filters === 'string' ? {} : filters, { defaultLimit: 100, maxLimit: RECON_MAX_PAGE_SIZE });
  const [rows, total] = await Promise.all([
    BankTransaction.find(query).sort({ date: 1, _id: 1 }).skip(skip).limit(limit),
    BankTransaction.countDocuments(query),
  ]);
  return { data: rows, rows, pagination: pageMeta(page, limit, total) };
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
    matchedAmount: statementAmount,
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
  const [books, statements] = await Promise.all([
    fetchAllPages(
      (page) => listBookTransactions(companyId, sessionId, { ...page, matchStatus: "unmatched" }),
      'book reconciliation auto-match',
    ),
    fetchAllPages(
      (page) => listStatementTransactions(companyId, sessionId, { ...page, matchStatus: "unmatched" }),
      'statement reconciliation auto-match',
    ),
  ]);
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
  const company = String(companyId);
  const bankAccountId = String(session.bankAccountId);
  const date = { gte: session.periodStart, lte: session.periodEnd };
  const [bookGroups, statementGroups] = await Promise.all([
    dbClient().bankTransaction.groupBy({
      by: ['reconciliationStatus', 'type'],
      where: { companyId: company, bankAccountId, date },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    dbClient().bankStatementTransaction.groupBy({
      by: ['matchStatus'],
      where: { companyId: company, bankAccountId, reconciliationSessionId: String(sessionId) },
      _sum: { debit: true, credit: true },
      _count: { _all: true },
    }),
  ]);

  let outstandingDeposits = 0;
  let outstandingChecks = 0;
  let bookTransactionCount = 0;
  for (const group of bookGroups) {
    bookTransactionCount += Number(group._count?._all || 0);
    if (group.reconciliationStatus === 'reconciled') continue;
    const amount = toNumber(group._sum?.amount);
    if (['debit', 'deposit', 'transfer_in'].includes(String(group.type).toLowerCase())) outstandingDeposits += amount;
    if (['credit', 'withdrawal', 'transfer_out'].includes(String(group.type).toLowerCase())) outstandingChecks += amount;
  }

  let unrecordedBankCredits = 0;
  let unrecordedBankCharges = 0;
  let statementTransactionCount = 0;
  for (const group of statementGroups) {
    statementTransactionCount += Number(group._count?._all || 0);
    if (group.matchStatus === 'matched') continue;
    unrecordedBankCredits += toNumber(group._sum?.credit);
    unrecordedBankCharges += toNumber(group._sum?.debit);
  }

  outstandingDeposits = round(outstandingDeposits);
  outstandingChecks = round(outstandingChecks);
  unrecordedBankCredits = round(unrecordedBankCredits);
  unrecordedBankCharges = round(unrecordedBankCharges);
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
    bookTransactionCount,
    statementTransactionCount,
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
