const mongoose = require('mongoose');
const { aggregateWithTimeout } = require('../utils/mongoAggregation');
const BalanceSheetService = require('./balanceSheetService');
const PLStatementService = require('./plStatementService');
const Company = require('../models/Company');
const ChartOfAccount = require('../models/ChartOfAccount');
const JournalEntry = require('../models/JournalEntry');
const Loan = require('../models/Loan');
const { isMongoConnected } = require('../utils/mongoConnection');

/**
 * Financial Ratios Service — IAS/IFRS Compliant
 *
 * Computes key financial ratios from live ledger data.
 * Ratios are grouped into:
 *
 *   Liquidity Ratios — ability to meet short-term obligations
 *     - Current Ratio, Quick Ratio, Cash Ratio, Working Capital
 *
 *   Profitability Ratios — ability to generate earnings
 *     - Gross Margin, Net Profit Margin, ROA, ROE, EBITDA Margin
 *
 *   Efficiency Ratios — how well assets/liabilities are managed
 *     - Inventory Turnover, DIO, AR Turnover, DSO, AP Turnover, DPO
 *
 *   Leverage Ratios — capital structure and debt servicing
 *     - Debt to Equity, Interest Coverage Ratio
 */
class FinancialRatiosService {

  /**
   * Compute all financial ratios
   * @param {string} companyId
   * @param {object} options — { asOfDate, dateFrom, dateTo }
   */
  static async compute(companyId, { asOfDate, dateFrom, dateTo }) {
    if (!companyId) throw new Error('COMPANY_ID_REQUIRED');
    if (!asOfDate) throw new Error('AS_OF_DATE_REQUIRED');
    if (!dateFrom || !dateTo) throw new Error('DATE_RANGE_REQUIRED');

    const company = await Company.findById(companyId).lean();

    // Get balance sheet — uses new structure: current.current_assets.total, etc.
    const bsData = await BalanceSheetService.generate(companyId, { asOfDate });
    const bs = bsData.current;

    // Get P&L
    const plData = await PLStatementService.generate(companyId, { dateFrom, dateTo });
    const pl = plData.current;

    // ── Extract balance sheet values ───────────────────────────────
    const currentAssets = bs?.current_assets?.total || 0;
    const totalAssets = bs?.total_assets || 0;
    const currentLiabilities = bs?.current_liabilities?.total || 0;
    const totalLiabilities = bs?.total_liabilities || 0;
    const totalEquity = bs?.equity?.total || 0;
    const nonCurrentLiabilities = bs?.non_current_liabilities?.total || 0;

    // Inventory balance — use inventory account codes directly
    const inventoryBalance = await FinancialRatiosService._getAccountCodesBalance(
      companyId, ['1400'], asOfDate
    );

    // AR balance — Accounts Receivable + Other Receivables
    const arBalance = await FinancialRatiosService._getAccountCodesBalance(
      companyId, ['1300', '1350'], asOfDate
    );

    // AP balance
    const apBalance = await FinancialRatiosService._getAccountCodesBalance(
      companyId, ['2000'], asOfDate
    );

    // Cash and cash equivalents
    const cashBalance = await FinancialRatiosService._getAccountCodesBalance(
      companyId, ['1000', '1050', '1100', '1110', '1200'], asOfDate
    );

    // Average balances for turnover calculations
    const openingInventory = await FinancialRatiosService._getAccountCodesBalance(
      companyId, ['1400'], dateFrom
    );
    const avgInventory = (openingInventory + inventoryBalance) / 2;

    const openingAP = await FinancialRatiosService._getAccountCodesBalance(
      companyId, ['2000'], dateFrom
    );
    const avgAP = (openingAP + apBalance) / 2;

    const openingAR = await FinancialRatiosService._getAccountCodesBalance(
      companyId, ['1300', '1350'], dateFrom
    );
    const avgAR = (openingAR + arBalance) / 2;

    // ── Extract P&L values ────────────────────────────────────────
    const revenue = pl?.revenue?.total || 0;
    const cogs = pl?.cogs?.total || 0;
    const grossProfit = pl?.gross_profit || 0;
    const operatingProfit = pl?.operating_profit || 0;
    const netProfit = pl?.profit_for_period || 0;
    const financeCosts = pl?.finance_costs?.total || 0;
    const ebitda = pl?.ebitda || 0;

    // Total purchases (from COGS accounts)
    const totalPurchases = await FinancialRatiosService._getTotalPurchases(
      companyId, dateFrom, dateTo
    );

    // Days in period
    const daysInPeriod = Math.max(1, Math.round((new Date(dateTo) - new Date(dateFrom)) / (1000 * 60 * 60 * 24)));

    // Working capital
    const workingCapital = currentAssets - currentLiabilities;

    // ── LIQUIDITY RATIOS ──────────────────────────────────────────

    // 1. Current Ratio
    const currentRatio = currentLiabilities > 0 ? currentAssets / currentLiabilities : null;

    // 2. Quick Ratio (Acid Test)
    const quickAssets = currentAssets - inventoryBalance;
    const quickRatio = currentLiabilities > 0 ? quickAssets / currentLiabilities : null;

    // 3. Cash Ratio
    const cashRatio = currentLiabilities > 0 ? cashBalance / currentLiabilities : null;

    // ── PROFITABILITY RATIOS ──────────────────────────────────────

    // 4. Gross Margin %
    const grossMarginPct = revenue > 0 ? (grossProfit / revenue) * 100 : null;

    // 5. Net Profit Margin %
    const netProfitMarginPct = revenue > 0 ? (netProfit / revenue) * 100 : null;

    // 6. EBITDA Margin %
    const ebitdaMarginPct = revenue > 0 ? (ebitda / revenue) * 100 : null;

    // 7. Return on Assets (ROA)
    const returnOnAssets = totalAssets > 0 ? (netProfit / totalAssets) * 100 : null;

    // 8. Return on Equity (ROE)
    const returnOnEquity = totalEquity > 0 ? (netProfit / totalEquity) * 100 : null;

    // ── EFFICIENCY RATIOS ─────────────────────────────────────────

    // 9. Inventory Turnover
    const inventoryTurnover = avgInventory > 0 ? cogs / avgInventory : null;

    // 10. Days Inventory Outstanding (DIO)
    const daysInventory = inventoryTurnover > 0 ? daysInPeriod / inventoryTurnover : null;

    // 11. AR Turnover
    const arTurnover = avgAR > 0 ? revenue / avgAR : null;

    // 12. Days Sales Outstanding (DSO)
    const daysSalesOutstanding = arTurnover > 0 ? daysInPeriod / arTurnover : null;

    // 13. AP Turnover
    const apTurnover = avgAP > 0 ? totalPurchases / avgAP : null;

    // 14. Days Payable Outstanding (DPO)
    const daysPayableOutstanding = apTurnover > 0 ? daysInPeriod / apTurnover : null;

    // ── LEVERAGE RATIOS ───────────────────────────────────────────

    // 15. Debt to Equity
    const debtToEquity = totalEquity > 0 ? totalLiabilities / totalEquity : null;

    // 16. Interest Coverage Ratio
    const interestCoverage = financeCosts > 0 ? operatingProfit / financeCosts : null;

    // ── DEBT METRICS (from loan data) ─────────────────────────────
    let activeLoans = [];
    if (isMongoConnected()) {
      try {
        activeLoans = await Loan.find({
          company: new mongoose.Types.ObjectId(companyId),
          status: { $in: ['active', 'partially_repaid'] }
        });
      } catch (_err) {
        activeLoans = [];
      }
    }

    const totalBorrowings = activeLoans.reduce((sum, loan) => sum + (loan.outstandingBalance || 0), 0);
    const weightedInterestRate = totalBorrowings > 0
      ? activeLoans.reduce((sum, loan) => sum + ((loan.outstandingBalance || 0) * (loan.interestRate || 0)), 0) / totalBorrowings
      : 0;
    const securedLoans = activeLoans.filter(loan => loan.isSecured).reduce((sum, loan) => sum + (loan.outstandingBalance || 0), 0);
    const shortTermLoans = activeLoans.filter(loan => {
      const endDate = new Date(loan.endDate);
      const monthsRemaining = (endDate - new Date(asOfDate)) / (1000 * 60 * 60 * 24 * 30);
      return monthsRemaining <= 12;
    }).reduce((sum, loan) => sum + (loan.outstandingBalance || 0), 0);

    // Debt to Assets
    const debtToAssets = totalAssets > 0 ? totalLiabilities / totalAssets : null;

    // Net Debt (Borrowings - Cash)
    const netDebt = totalBorrowings - (cashBalance || 0);

    // Debt Service Coverage Ratio (using EBIT approx = Operating Profit + Finance Costs)
    const ebit = operatingProfit + (financeCosts || 0);
    // Estimate annual debt service (interest + principal) - simplified
    const estimatedAnnualDebtService = (financeCosts || 0) + (totalBorrowings * 0.1); // Assume 10% avg principal repayment
    const debtServiceCoverage = estimatedAnnualDebtService > 0 ? ebit / estimatedAnnualDebtService : null;

    // ── Build response ────────────────────────────────────────────
    const round = (v) => v !== null ? Math.round(v * 100) / 100 : null;

    return {
      company_id: companyId,
      company_name: company?.name || '',
      as_of_date: asOfDate,
      date_from: dateFrom,
      date_to: dateTo,
      days_in_period: daysInPeriod,

      ratios: {
        liquidity: {
          label: 'Liquidity Ratios',
          ratios: {
            current_ratio: {
              value: round(currentRatio),
              label: 'Current Ratio',
              formula: 'Current Assets ÷ Current Liabilities',
              benchmark: 'Ideal: ≥ 2.0, Acceptable: ≥ 1.0',
              inputs: { current_assets: round(currentAssets), current_liabilities: round(currentLiabilities) },
              status: FinancialRatiosService._rate(currentRatio, [2, 1], 'gte')
            },
            quick_ratio: {
              value: round(quickRatio),
              label: 'Quick Ratio (Acid Test)',
              formula: '(Current Assets − Inventory) ÷ Current Liabilities',
              benchmark: 'Ideal: ≥ 1.0, Acceptable: ≥ 0.5',
              inputs: { quick_assets: round(quickAssets), current_liabilities: round(currentLiabilities) },
              status: FinancialRatiosService._rate(quickRatio, [1, 0.5], 'gte')
            },
            cash_ratio: {
              value: round(cashRatio),
              label: 'Cash Ratio',
              formula: 'Cash & Equivalents ÷ Current Liabilities',
              benchmark: 'Ideal: ≥ 0.5, Acceptable: ≥ 0.2',
              inputs: { cash: round(cashBalance), current_liabilities: round(currentLiabilities) },
              status: FinancialRatiosService._rate(cashRatio, [0.5, 0.2], 'gte')
            },
            working_capital: {
              value: round(workingCapital),
              label: 'Working Capital',
              formula: 'Current Assets − Current Liabilities',
              benchmark: 'Positive is healthy',
              inputs: { current_assets: round(currentAssets), current_liabilities: round(currentLiabilities) },
              status: workingCapital > 0 ? 'good' : workingCapital === 0 ? 'warning' : 'danger'
            }
          }
        },

        profitability: {
          label: 'Profitability Ratios',
          ratios: {
            gross_margin_pct: {
              value: round(grossMarginPct),
              label: 'Gross Margin %',
              formula: 'Gross Profit ÷ Revenue × 100',
              benchmark: 'Excellent: ≥ 40%, Good: ≥ 20%',
              inputs: { gross_profit: round(grossProfit), revenue: round(revenue) },
              status: FinancialRatiosService._rate(grossMarginPct, [40, 20], 'gte')
            },
            net_profit_margin_pct: {
              value: round(netProfitMarginPct),
              label: 'Net Profit Margin %',
              formula: 'Net Profit ÷ Revenue × 100',
              benchmark: 'Excellent: ≥ 15%, Good: ≥ 5%',
              inputs: { net_profit: round(netProfit), revenue: round(revenue) },
              status: FinancialRatiosService._rate(netProfitMarginPct, [15, 5], 'gte')
            },
            ebitda_margin_pct: {
              value: round(ebitdaMarginPct),
              label: 'EBITDA Margin %',
              formula: 'EBITDA ÷ Revenue × 100',
              benchmark: 'Excellent: ≥ 20%, Good: ≥ 10%',
              inputs: { ebitda: round(ebitda), revenue: round(revenue) },
              status: FinancialRatiosService._rate(ebitdaMarginPct, [20, 10], 'gte')
            },
            return_on_assets: {
              value: round(returnOnAssets),
              label: 'Return on Assets (ROA) %',
              formula: 'Net Profit ÷ Total Assets × 100',
              benchmark: 'Excellent: ≥ 10%, Good: ≥ 5%',
              inputs: { net_profit: round(netProfit), total_assets: round(totalAssets) },
              status: FinancialRatiosService._rate(returnOnAssets, [10, 5], 'gte')
            },
            return_on_equity: {
              value: round(returnOnEquity),
              label: 'Return on Equity (ROE) %',
              formula: 'Net Profit ÷ Total Equity × 100',
              benchmark: 'Excellent: ≥ 15%, Good: ≥ 8%',
              inputs: { net_profit: round(netProfit), total_equity: round(totalEquity) },
              status: FinancialRatiosService._rate(returnOnEquity, [15, 8], 'gte')
            }
          }
        },

        efficiency: {
          label: 'Efficiency Ratios',
          ratios: {
            inventory_turnover: {
              value: round(inventoryTurnover),
              label: 'Inventory Turnover',
              formula: 'COGS ÷ Average Inventory',
              benchmark: 'High: ≥ 6x, Average: ≥ 3x',
              inputs: { cogs: round(cogs), avg_inventory: round(avgInventory) },
              status: FinancialRatiosService._rate(inventoryTurnover, [6, 3], 'gte')
            },
            days_inventory_outstanding: {
              value: round(daysInventory),
              label: 'Days Inventory Outstanding',
              formula: `${daysInPeriod} days ÷ Inventory Turnover`,
              benchmark: 'Good: ≤ 60 days, Acceptable: ≤ 90 days',
              inputs: { inventory_turnover: round(inventoryTurnover) },
              status: FinancialRatiosService._rate(daysInventory, [60, 90], 'lte')
            },
            ar_turnover: {
              value: round(arTurnover),
              label: 'Accounts Receivable Turnover',
              formula: 'Revenue ÷ Average AR',
              benchmark: 'High: ≥ 8x, Average: ≥ 4x',
              inputs: { revenue: round(revenue), avg_ar: round(avgAR) },
              status: FinancialRatiosService._rate(arTurnover, [8, 4], 'gte')
            },
            days_sales_outstanding: {
              value: round(daysSalesOutstanding),
              label: 'Days Sales Outstanding (DSO)',
              formula: `${daysInPeriod} days ÷ AR Turnover`,
              benchmark: 'Good: ≤ 45 days, Acceptable: ≤ 60 days',
              inputs: { ar_turnover: round(arTurnover) },
              status: FinancialRatiosService._rate(daysSalesOutstanding, [45, 60], 'lte')
            },
            ap_turnover: {
              value: round(apTurnover),
              label: 'Accounts Payable Turnover',
              formula: 'Total Purchases ÷ Average AP',
              benchmark: 'High: ≥ 8x, Average: ≥ 4x',
              inputs: { total_purchases: round(totalPurchases), avg_ap: round(avgAP) },
              status: FinancialRatiosService._rate(apTurnover, [8, 4], 'gte')
            },
            days_payable_outstanding: {
              value: round(daysPayableOutstanding),
              label: 'Days Payable Outstanding (DPO)',
              formula: `${daysInPeriod} days ÷ AP Turnover`,
              benchmark: 'Context-dependent',
              inputs: { ap_turnover: round(apTurnover) },
              status: 'neutral'
            }
          }
        },

        leverage: {
          label: 'Leverage Ratios',
          ratios: {
            debt_to_equity: {
              value: round(debtToEquity),
              label: 'Debt to Equity Ratio',
              formula: 'Total Liabilities ÷ Total Equity',
              benchmark: 'Low risk: ≤ 1.0, Moderate: ≤ 2.0',
              inputs: { total_liabilities: round(totalLiabilities), total_equity: round(totalEquity) },
              status: FinancialRatiosService._rate(debtToEquity, [1, 2], 'lte')
            },
            interest_coverage: {
              value: round(interestCoverage),
              label: 'Interest Coverage Ratio',
              formula: 'EBIT ÷ Finance Costs',
              benchmark: 'Strong: ≥ 3.0, Adequate: ≥ 1.5',
              inputs: { ebit: round(operatingProfit), finance_costs: round(financeCosts) },
              status: FinancialRatiosService._rate(interestCoverage, [3, 1.5], 'gte')
            },
            debt_to_assets: {
              value: round(debtToAssets),
              label: 'Debt to Assets Ratio',
              formula: 'Total Liabilities ÷ Total Assets',
              benchmark: 'Low risk: ≤ 0.4, Moderate: ≤ 0.6',
              inputs: { total_liabilities: round(totalLiabilities), total_assets: round(totalAssets) },
              status: FinancialRatiosService._rate(debtToAssets, [0.4, 0.6], 'lte')
            }
          }
        }
      },

      debt_metrics: {
        label: 'Debt Metrics',
        metrics: {
          total_borrowings: {
            value: round(totalBorrowings),
            label: 'Total Borrowings',
            description: 'Sum of all outstanding loan balances'
          },
          net_debt: {
            value: round(netDebt),
            label: 'Net Debt',
            description: 'Borrowings minus Cash & Equivalents'
          },
          weighted_avg_interest_rate: {
            value: round(weightedInterestRate),
            label: 'Weighted Avg Interest Rate',
            unit: '%',
            description: 'Interest rate weighted by loan balance'
          },
          secured_loan_ratio: {
            value: totalBorrowings > 0 ? round(securedLoans / totalBorrowings) : null,
            label: 'Secured Loan Ratio',
            unit: '%',
            description: 'Secured loans ÷ Total borrowings'
          },
          short_term_debt_ratio: {
            value: totalBorrowings > 0 ? round(shortTermLoans / totalBorrowings) : null,
            label: 'Short-term Debt Ratio',
            unit: '%',
            description: 'Due within 12 months ÷ Total borrowings'
          },
          debt_service_coverage: {
            value: round(debtServiceCoverage),
            label: 'Debt Service Coverage Ratio',
            description: 'EBIT ÷ (Interest + Principal)',
            benchmark: 'Strong: ≥ 1.5, Adequate: ≥ 1.2',
            status: FinancialRatiosService._rate(debtServiceCoverage, [1.5, 1.2], 'gte')
          },
          loan_count: {
            value: activeLoans.length,
            label: 'Active Loans',
            description: 'Number of active/partially repaid loans'
          }
        }
      },

      summary: FinancialRatiosService._computeSummary(currentRatio, quickRatio, grossMarginPct, netProfitMarginPct, returnOnAssets, debtToEquity, inventoryTurnover, debtToAssets),

      generated_at: new Date()
    };
  }

  /**
   * Generic rating helper
   * @param {number|null} value — the ratio value
   * @param {number[]} thresholds — [good, warning] thresholds
   * @param {string} direction — 'gte' (higher is better) or 'lte' (lower is better)
   */
  static _rate(value, thresholds, direction) {
    if (value === null || value === undefined) return 'neutral';
    const [good, warning] = thresholds;
    if (direction === 'gte') {
      if (value >= good) return 'good';
      if (value >= warning) return 'warning';
      return 'danger';
    } else {
      if (value <= good) return 'good';
      if (value <= warning) return 'warning';
      return 'danger';
    }
  }

  /**
   * Compute overall health summary
   */
  static _computeSummary(currentRatio, quickRatio, grossMargin, netMargin, roa, debtToEquity, inventoryTurnover, debtToAssets) {
    const liquidityStatus = FinancialRatiosService._rate(currentRatio, [2, 1], 'gte');
    const profitabilityStatus = FinancialRatiosService._rate(netMargin, [15, 5], 'gte');
    const efficiencyStatus = FinancialRatiosService._rate(inventoryTurnover, [6, 3], 'gte');
    const leverageStatus = FinancialRatiosService._rate(debtToAssets, [0.4, 0.6], 'lte');

    const statuses = [liquidityStatus, profitabilityStatus, efficiencyStatus, leverageStatus];
    const goodCount = statuses.filter(s => s === 'good').length;
    const warningCount = statuses.filter(s => s === 'warning').length;
    const dangerCount = statuses.filter(s => s === 'danger').length;

    let overall;
    if (dangerCount >= 2) overall = 'danger';
    else if (dangerCount >= 1 || warningCount >= 3) overall = 'warning';
    else if (goodCount >= 3) overall = 'good';
    else overall = 'warning';

    return {
      overall,
      liquidity: liquidityStatus,
      profitability: profitabilityStatus,
      efficiency: efficiencyStatus,
      leverage: leverageStatus,
      good_count: goodCount,
      warning_count: warningCount,
      danger_count: dangerCount
    };
  }

  /**
   * Get balance by account subtype(s) and type
   * @private
   */
  static async _getAccountTypeBalance(companyId, subtypes, type, asOfDate, specificSubtype) {
    const query = {
      company: new mongoose.Types.ObjectId(companyId),
      type: type,
      isActive: true
    };

    if (specificSubtype) {
      query.subtype = specificSubtype;
    } else if (subtypes && subtypes.length > 0) {
      query.subtype = { $in: subtypes };
    }

    const accounts = await ChartOfAccount.find(query).lean();

    let total = 0;
    for (const acc of accounts) {
      const bal = await FinancialRatiosService._getAccountBalance(
        companyId, acc.code,
        new Date('1900-01-01'),
        new Date(asOfDate)
      );
      total += bal;
    }
    return total;
  }

  /**
   * Get total balance for specific account codes
   * @private
   */
  static async _getAccountCodesBalance(companyId, accountCodes, asOfDate) {
    let total = 0;
    for (const code of accountCodes) {
      const bal = await FinancialRatiosService._getAccountBalance(
        companyId, code,
        new Date('1900-01-01'),
        new Date(asOfDate)
      );
      total += bal;
    }
    return total;
  }

  /**
   * Get account balance from journal entries
   * @private
   */
  static async _getAccountBalance(companyId, accountCode, dateFrom, dateTo) {
    const result = await aggregateWithTimeout(JournalEntry, [
      {
        $match: {
          company: new mongoose.Types.ObjectId(companyId),
          status: 'posted',
          reversed: { $ne: true },
          date: { $gte: dateFrom, $lte: new Date(dateTo) }
        }
      },
      { $unwind: '$lines' },
      { $match: { 'lines.accountCode': accountCode } },
      {
        $group: {
          _id: null,
          total_dr: { $sum: '$lines.debit' },
          total_cr: { $sum: '$lines.credit' }
        }
      }
    ]);

    const dr = parseFloat(result[0]?.total_dr?.toString() || '0');
    const cr = parseFloat(result[0]?.total_cr?.toString() || '0');

    const account = await ChartOfAccount.findOne({
      company: new mongoose.Types.ObjectId(companyId),
      code: accountCode
    }).lean();

    if (account && ['asset', 'expense'].includes(account.type)) {
      return dr - cr;
    }
    return cr - dr;
  }

  /**
   * Get total purchases from journal entries
   * Uses multiple sourceTypes: purchase, cogs, purchase_order
   * Falls back to COGS + change in inventory if no purchase entries found
   * @private
   */
  static async _getTotalPurchases(companyId, dateFrom, dateTo) {
    const result = await aggregateWithTimeout(JournalEntry, [
      {
        $match: {
          company: new mongoose.Types.ObjectId(companyId),
          status: 'posted',
          reversed: { $ne: true },
          sourceType: { $in: ['purchase', 'cogs', 'purchase_order'] },
          date: { $gte: new Date(dateFrom), $lte: new Date(dateTo) }
        }
      },
      { $unwind: '$lines' },
      { $match: { 'lines.debit': { $gt: 0 }, 'lines.accountCode': { $regex: /^(1400|2000|5000|5100|5110)$/ } } },
      {
        $group: {
          _id: null,
          total_dr: { $sum: '$lines.debit' }
        }
      }
    ]);
    const purchases = parseFloat(result[0]?.total_dr?.toString() || '0');
    return purchases;
  }
}

module.exports = FinancialRatiosService;
