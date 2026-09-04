const ChartOfAccount = require('../models/ChartOfAccount');
const { dbClient } = require('../lib/prisma');

/**
 * Chart of Accounts Service
 * Foundation for all financial reports
 * Provides account balance computation and hierarchy traversal
 * Uses embedded lines in JournalEntry (no separate collection)
 */
class ChartOfAccountsService {

  /**
   * Get balance for a single account in a date range
   * scoped to company — the foundational function for all reports
   * Uses embedded lines via $unwind aggregation
   */
  static async getAccountBalance(companyId, accountId, dateFrom, dateTo) {
    // First get the account to know its code
    const account = await ChartOfAccount.findOne({
      _id: accountId,
      company: companyId
    }).lean();

    if (!account) throw new Error('ACCOUNT_NOT_FOUND');

    const result = await dbClient().journalEntryLine.aggregate({
      where: {
        companyId: String(companyId),
        accountCode: account.code,
        journalEntry: {
          status: 'posted',
          date: {
            gte: new Date(dateFrom),
            lte: new Date(dateTo),
          },
        },
      },
      _sum: {
        debit: true,
        credit: true,
      },
    });

    const dr = Number(result._sum.debit || 0);
    const cr = Number(result._sum.credit || 0);

    // Apply normal balance direction
    // For debit-normal accounts (Assets, Expenses, COGS): balance = dr - cr
    // For credit-normal accounts (Liabilities, Equity, Revenue): balance = cr - dr
    const balance = account.normal_balance === 'debit'
      ? dr - cr
      : cr - dr;

    return {
      account_id: account._id,
      account_code: account.code,
      account_name: account.name,
      account_type: account.type,
      normal_balance: account.normal_balance,
      total_dr: Number(dr),
      total_cr: Number(cr),
      balance: Number(balance) // always positive = normal position for the account type
    };
  }

  /**
   * Get balances for all accounts of given types in a date range
   * Used by P&L, Balance Sheet, Trial Balance
   */
  static async getAccountBalancesByType(companyId, types, dateFrom, dateTo) {
    const accounts = await ChartOfAccount.find({
      company: companyId,
      type: { $in: types },
      isActive: true,
      allow_direct_posting: true
    }).lean();

    const results = [];

    for (const account of accounts) {
      const bal = await ChartOfAccountsService.getAccountBalance(
        companyId,
        account._id,
        dateFrom,
        dateTo
      );
      if (bal.total_dr > 0 || bal.total_cr > 0) {
        results.push(bal);
      }
    }

    return results;
  }

  /**
   * Get opening balance for an account — all activity BEFORE dateFrom
   */
  static async getOpeningBalance(companyId, accountId, dateFrom) {
    const veryEarlyDate = new Date('1900-01-01');
    const dayBeforeStart = new Date(dateFrom);
    dayBeforeStart.setDate(dayBeforeStart.getDate() - 1);

    return ChartOfAccountsService.getAccountBalance(
      companyId,
      accountId,
      veryEarlyDate,
      dayBeforeStart
    );
  }

  /**
   * Get closing balance for an account — all activity UP TO dateTo
   */
  static async getClosingBalance(companyId, accountId, dateTo) {
    const veryEarlyDate = new Date('1900-01-01');

    return ChartOfAccountsService.getAccountBalance(
      companyId,
      accountId,
      veryEarlyDate,
      dateTo
    );
  }

  /**
   * Get account hierarchy - returns full tree structure
   */
  static async getAccountHierarchy(companyId) {
    const accounts = await ChartOfAccount.find({
      company: companyId,
      isActive: true
    }).sort({ code: 1 }).lean();

    // Build tree structure
    const accountMap = {};
    const rootAccounts = [];

    // First pass: create map
    accounts.forEach(acc => {
      accountMap[acc._id.toString()] = {
        ...acc,
        children: []
      };
    });

    // Second pass: build tree
    accounts.forEach(acc => {
      if (acc.parent_id) {
        const parent = accountMap[acc.parent_id.toString()];
        if (parent) {
          parent.children.push(accountMap[acc._id.toString()]);
        }
      } else {
        rootAccounts.push(accountMap[acc._id.toString()]);
      }
    });

    return rootAccounts;
  }

  /**
   * Validate account belongs to company
   */
  static async validateAccountOwnership(companyId, accountId) {
    const account = await ChartOfAccount.findOne({
      _id: accountId,
      company: companyId
    });

    if (!account) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }

    return account;
  }

  /**
   * Get all accounts for a company
   */
  static async getAllAccounts(companyId, filters = {}) {
    const query = { company: companyId };
    
    if (filters.type) {
      query.type = filters.type;
    }
    if (filters.isActive !== undefined) {
      query.isActive = filters.isActive;
    }
    if (filters.allowDirectPosting !== undefined) {
      query.allow_direct_posting = filters.allowDirectPosting;
    }

    return ChartOfAccount.find(query).sort({ code: 1 }).lean();
  }

  /**
   * Get account by code
   */
  static async getAccountByCode(companyId, code) {
    const account = await ChartOfAccount.findOne({
      company: companyId,
      code: code
    }).lean();

    if (!account) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }

    return account;
  }

  /** Load multiple account codes in one tenant-scoped query. */
  static async getAccountsByCodes(companyId, codes = []) {
    const uniqueCodes = [...new Set((codes || []).map((code) => String(code || '').trim()).filter(Boolean))];
    if (!uniqueCodes.length) return [];
    return ChartOfAccount.find({ company: companyId, code: { $in: uniqueCodes } })
      .select('_id code name type normal_balance')
      .sort({ code: 1 })
      .limit(uniqueCodes.length)
      .lean();
  }
}

module.exports = ChartOfAccountsService;
