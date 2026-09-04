const ChartOfAccount = require('../models/ChartOfAccount');
const { dbClient } = require('../lib/prisma');

/**
 * Trial Balance Service
 * 
 * Lists every account with activity in a period alongside its total DR movements,
 * total CR movements, and closing balance.
 * 
 * Fundamental invariant: SUM(all DR) = SUM(all CR)
 * 
 * Note: Uses embedded lines in JournalEntry (not separate JournalEntryLine collection)
 */
class TrialBalanceService {

  /**
   * Generate Trial Balance report
   * @param {string} companyId - Company ID
   * @param {object} options - { dateFrom, dateTo }
   */
  static async generate(companyId, { dateFrom, dateTo }) {
    if (!companyId) throw new Error('COMPANY_ID_REQUIRED');
    if (!dateFrom || !dateTo) throw new Error('DATE_RANGE_REQUIRED');
    if (new Date(dateFrom) > new Date(dateTo)) throw new Error('INVALID_DATE_RANGE');

    // Step 1 — Aggregate all posted journal lines by account in period
    // Using embedded lines approach with $unwind
    const lineAggregation = await dbClient().journalEntryLine.groupBy({
      by: ['accountCode'],
      where: {
        companyId: String(companyId),
        journalEntry: {
          status: 'posted',
          date: { gte: new Date(dateFrom), lte: new Date(dateTo) },
        },
      },
      _sum: { debit: true, credit: true },
      orderBy: { accountCode: 'asc' },
    });

    if (lineAggregation.length === 0) {
      return {
        company_id: companyId,
        date_from: dateFrom,
        date_to: dateTo,
        lines: [],
        total_dr: 0,
        total_cr: 0,
        is_balanced: true,
        difference: 0,
        generated_at: new Date()
      };
    }

    // Step 2 — Enrich with account details from chart of accounts
    const accountCodes = lineAggregation.map(l => l.accountCode);
    const accounts = await ChartOfAccount.find({
      code: { $in: accountCodes },
      company: companyId
    }).lean();

    const accountMap = {};
    for (const acc of accounts) {
      accountMap[acc.code] = acc;
    }

    // Step 3 — Build trial balance lines
    const lines = lineAggregation.map(row => {
      const totalDr = Number(row._sum.debit || 0);
      const totalCr = Number(row._sum.credit || 0);
      const account = accountMap[row.accountCode];
      const netDr = totalDr > totalCr ? totalDr - totalCr : 0;
      const netCr = totalCr > totalDr ? totalCr - totalDr : 0;

      return {
        account_id: account?._id || null,
        account_code: row.accountCode,
        account_name: account?.name || 'Unknown Account',
        account_type: account?.type || 'unknown',
        total_dr: Math.round(totalDr * 100) / 100,
        total_cr: Math.round(totalCr * 100) / 100,
        // Net columns — shown in traditional two-column TB format
        net_dr: Math.round(netDr * 100) / 100,
        net_cr: Math.round(netCr * 100) / 100
      };
    });

    // Sort by account code for readability
    lines.sort((a, b) => a.account_code.localeCompare(b.account_code, undefined, { numeric: true }));

    // Step 4 — Compute totals and verify balance
    const totalDr = Math.round(lines.reduce((s, l) => s + l.total_dr, 0) * 100) / 100;
    const totalCr = Math.round(lines.reduce((s, l) => s + l.total_cr, 0) * 100) / 100;
    const difference = Math.round(Math.abs(totalDr - totalCr) * 100) / 100;
    const isBalanced = difference < 0.01;

    return {
      company_id: companyId,
      date_from: dateFrom,
      date_to: dateTo,
      lines,
      total_dr: totalDr,
      total_cr: totalCr,
      net_dr_total: Math.round(lines.reduce((s, l) => s + l.net_dr, 0) * 100) / 100,
      net_cr_total: Math.round(lines.reduce((s, l) => s + l.net_cr, 0) * 100) / 100,
      is_balanced: isBalanced,
      difference,
      generated_at: new Date()
    };
  }
}

module.exports = TrialBalanceService;
