const ChartOfAccount = require('../models/ChartOfAccount');
const { dbClient } = require('../lib/prisma');
const ChartOfAccountsService = require('./chartOfAccountsService');

/**
 * General Ledger Service
 * 
 * Shows every individual journal entry line that posted to a specific account 
 * in a period, with a running balance. This is the drill-down behind every 
 * number in every other report.
 * 
 * Uses embedded lines in JournalEntry (no separate collection needed)
 */
class GeneralLedgerService {

  /**
   * Get the ledger for a specific account
   * @param {string} companyId - Company ID
   * @param {string} accountId - Account ID
   * @param {object} options - { dateFrom, dateTo }
   */
  static async getAccountLedger(companyId, accountId, { dateFrom, dateTo }) {
    if (!companyId) throw new Error('COMPANY_ID_REQUIRED');

    // Verify account belongs to this company
    const account = await ChartOfAccount.findOne({
      _id: accountId,
      company: companyId
    }).lean();

    if (!account) throw new Error('ACCOUNT_NOT_FOUND');

    // Get opening balance — all activity before dateFrom
    const openingBalanceData = await ChartOfAccountsService.getOpeningBalance(
      companyId,
      accountId,
      dateFrom
    );
    const openingBalance = openingBalanceData.balance;

    // Get all posted journal lines for this account in the period
    // Using embedded lines approach with $unwind
    const rows = await dbClient().journalEntryLine.findMany({
      where: {
        companyId: String(companyId),
        accountCode: account.code,
        journalEntry: {
          status: 'posted',
          date: { gte: new Date(dateFrom), lte: new Date(dateTo) },
        },
      },
      select: {
        id: true,
        debit: true,
        credit: true,
        description: true,
        journalEntry: {
          select: { id: true, date: true, entryNumber: true, description: true, sourceType: true, sourceId: true },
        },
      },
      orderBy: [{ journalEntry: { date: 'asc' } }, { journalEntryId: 'asc' }],
    });
    const lines = rows.map((row) => ({
      entry_date: row.journalEntry.date,
      reference_no: row.journalEntry.entryNumber,
      narration: row.journalEntry.description,
      source_type: row.journalEntry.sourceType,
      source_id: row.journalEntry.sourceId,
      dr_amount: row.debit,
      cr_amount: row.credit,
      description: row.description,
      journal_entry_id: row.journalEntry.id,
      line_id: row.id,
    }));

    // Compute running balance after each line
    let runningBalance = openingBalance;
    const ledgerLines = lines.map(line => {
      const dr = line.dr_amount ? Number(line.dr_amount) : 0;
      const cr = line.cr_amount ? Number(line.cr_amount) : 0;

      // Running balance moves in the direction of normal balance
      if (account.normal_balance === 'debit') {
        runningBalance = runningBalance + dr - cr;
      } else {
        runningBalance = runningBalance + cr - dr;
      }

      return {
        date: line.entry_date,
        reference_no: line.reference_no,
        narration: line.narration,
        source_type: line.source_type,
        source_id: line.source_id,
        description: line.description,
        dr_amount: Math.round(dr * 100) / 100,
        cr_amount: Math.round(cr * 100) / 100,
        balance: Math.round(runningBalance * 100) / 100,
        journal_entry_id: line.journal_entry_id
      };
    });

    const closingBalance = runningBalance;

    // Calculate totals
    const totalDr = lines.reduce((s, l) => s + (Number(l.dr_amount) || 0), 0);
    const totalCr = lines.reduce((s, l) => s + (Number(l.cr_amount) || 0), 0);

    return {
      company_id: companyId,
      account_id: accountId,
      account_code: account.code,
      account_name: account.name,
      account_type: account.type,
      normal_balance: account.normal_balance,
      date_from: dateFrom,
      date_to: dateTo,
      opening_balance: Math.round(openingBalance * 100) / 100,
      lines: ledgerLines,
      closing_balance: Math.round(closingBalance * 100) / 100,
      total_dr: Math.round(totalDr * 100) / 100,
      total_cr: Math.round(totalCr * 100) / 100,
      generated_at: new Date()
    };
  }

  /**
   * Get ledger summary for all accounts — used by accountants for period review
   * @param {string} companyId - Company ID
   * @param {object} options - { dateFrom, dateTo }
   */
  static async getAllAccountsSummary(companyId, { dateFrom, dateTo }) {
    const accounts = await ChartOfAccount.find({
      company: companyId,
      isActive: true
    }).sort({ code: 1 }).lean();

    const summaries = [];
    for (const account of accounts) {
      const bal = await ChartOfAccountsService.getAccountBalance(
        companyId, account._id, dateFrom, dateTo
      );
      if (bal.total_dr > 0 || bal.total_cr > 0) {
        const openingBal = await ChartOfAccountsService.getOpeningBalance(
          companyId, account._id, dateFrom
        );
        summaries.push({
          account_code: account.code,
          account_name: account.name,
          account_type: account.type,
          opening_balance: openingBal.balance,
          total_dr: bal.total_dr,
          total_cr: bal.total_cr,
          closing_balance: bal.balance
        });
      }
    }
    return summaries;
  }

  /**
   * Get ledger entries by journal entry ID
   * Useful for drill-down from other reports
   * @param {string} companyId - Company ID
   * @param {string} journalEntryId - Journal Entry ID
   */
  static async getEntriesByJournalEntry(companyId, journalEntryId) {
    const entry = await dbClient().journalEntry.findFirst({
      where: { id: String(journalEntryId), companyId: String(companyId) },
      include: { lines: { orderBy: { lineOrder: 'asc' } } },
    });

    if (!entry) throw new Error('JOURNAL_ENTRY_NOT_FOUND');

    return {
      entry_id: entry.id,
      entry_number: entry.entryNumber,
      date: entry.date,
      description: entry.description,
      status: entry.status,
      source_type: entry.sourceType,
      lines: entry.lines.map(line => ({
        account_code: line.accountCode,
        account_name: line.accountName,
        description: line.description,
        debit: line.debit,
        credit: line.credit,
        reference: line.reference
      }))
    };
  }

  /**
   * Search ledger entries by description or reference
   * @param {string} companyId - Company ID
   * @param {string} accountId - Account ID (optional)
   * @param {string} searchTerm - Search term
   * @param {object} options - { dateFrom, dateTo, limit }
   */
  static async searchLedger(companyId, accountId, searchTerm, { dateFrom, dateTo, limit = 50 }) {
    // First get the account code if accountId provided
    let accountCode = null;
    if (accountId) {
      const account = await ChartOfAccount.findById(accountId).lean();
      if (!account) throw new Error('ACCOUNT_NOT_FOUND');
      accountCode = account.code;
    }

    const text = searchTerm ? String(searchTerm) : null;
    const rows = await dbClient().journalEntryLine.findMany({
      where: {
        companyId: String(companyId),
        ...(accountCode ? { accountCode } : {}),
        ...(text ? {
          OR: [
            { description: { contains: text, mode: 'insensitive' } },
            { reference: { contains: text, mode: 'insensitive' } },
            { journalEntry: { description: { contains: text, mode: 'insensitive' } } },
            { journalEntry: { entryNumber: { contains: text, mode: 'insensitive' } } },
          ],
        } : {}),
        journalEntry: {
          status: 'posted',
          ...(dateFrom && dateTo ? { date: { gte: new Date(dateFrom), lte: new Date(dateTo) } } : {}),
        },
      },
      select: {
        debit: true,
        credit: true,
        accountCode: true,
        accountName: true,
        description: true,
        journalEntry: { select: { id: true, date: true, entryNumber: true, description: true, sourceType: true } },
      },
      orderBy: [{ journalEntry: { date: 'desc' } }, { journalEntryId: 'desc' }],
      take: Math.min(Number(limit) || 50, 200),
    });
    return rows.map((row) => ({
      entry_date: row.journalEntry.date,
      reference_no: row.journalEntry.entryNumber,
      narration: row.journalEntry.description,
      source_type: row.journalEntry.sourceType,
      account_code: row.accountCode,
      account_name: row.accountName,
      dr_amount: row.debit,
      cr_amount: row.credit,
      description: row.description,
      journal_entry_id: row.journalEntry.id,
    }));
  }
}

module.exports = GeneralLedgerService;
