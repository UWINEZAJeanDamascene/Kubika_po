const mongoose = require("mongoose");
const ChartOfAccount = require("../models/ChartOfAccount");
const JournalEntry = require("../models/JournalEntry");
const Loan = require("../models/Loan");
const { isMongoConnected } = require("../utils/mongoConnection");
const { aggregateWithTimeout } = require("../utils/mongoAggregation");
const Company = require("../models/Company");
const PLStatementService = require("./plStatementService");

/**
 * Balance Sheet Service — IAS 1 Compliant Statement of Financial Position
 *
 * Structure (IAS 1 / IFRS):
 *   ASSETS
 *     Non-Current Assets
 *       Property, Plant & Equipment (net of accumulated depreciation)
 *       Other Non-Current Assets
 *     Current Assets
 *       Inventories
 *       Trade & Other Receivables
 *       Cash & Cash Equivalents
 *       Other Current Assets
 *     TOTAL ASSETS
 *
 *   EQUITY & LIABILITIES
 *     Equity
 *       Share Capital
 *       Retained Earnings (including current period P&L)
 *       Dividends Paid
 *     Non-Current Liabilities
 *       Long-Term Borrowings
 *     Current Liabilities
 *       Trade & Other Payables
 *       Short-Term Borrowings
 *       Tax Payables
 *       Other Current Liabilities
 *     TOTAL EQUITY & LIABILITIES
 *
 * Assets = Liabilities + Equity (must balance)
 */
class BalanceSheetService {
  /**
   * Generate Balance Sheet report
   * @param {string} companyId - Company ID
   * @param {object} options - { asOfDate, comparativeDate }
   */
  static async generate(companyId, { asOfDate, comparativeDate }) {
    if (!companyId) throw new Error("COMPANY_ID_REQUIRED");
    if (!asOfDate) throw new Error("AS_OF_DATE_REQUIRED");

    const company = await Company.findById(companyId).lean();

    const [currentPeriod, comparativePeriod] = await Promise.all([
      BalanceSheetService._buildPeriodData(companyId, asOfDate, company),
      comparativeDate
        ? BalanceSheetService._buildPeriodData(
            companyId,
            comparativeDate,
            company,
          )
        : null,
    ]);

    return {
      company_id: companyId,
      company_name: company?.name || "",
      as_of_date: asOfDate,
      comparative_date: comparativeDate || null,
      current: currentPeriod,
      comparative: comparativePeriod,
      generated_at: new Date(),
    };
  }

  /**
   * Build balance sheet data for a specific date
   * @private
   */
  static async _buildPeriodData(companyId, asOfDate, company) {
    // Interpret asOfDate as inclusive (end of day) so entries on that date are included
    const dateTo = new Date(asOfDate);
    dateTo.setHours(23, 59, 59, 999);

    // Fetch loan maturity data for proper liability classification (IAS 1)
    const loanMaturityData = await BalanceSheetService._getLoanMaturityData(
      companyId,
      dateTo,
    );

    // Get all account balances up to asOfDate
    const accountBalances = await aggregateWithTimeout(JournalEntry, [
      {
        $match: {
          company: new mongoose.Types.ObjectId(companyId),
          status: "posted",
          reversed: { $ne: true },
          date: { $lte: dateTo },
        },
      },
      { $unwind: "$lines" },
      {
        $group: {
          _id: "$lines.accountCode",
          total_dr: { $sum: "$lines.debit" },
          total_cr: { $sum: "$lines.credit" },
        },
      },
    ]);

    if (accountBalances.length === 0) {
      return BalanceSheetService._emptyPeriodData();
    }

    // Get all accounts that have balances (include all types so fallback logic
    // is not needed for correctly-typed expense/revenue accounts)
    const accountCodes = accountBalances.map((b) => b._id);
    const accounts = await ChartOfAccount.find({
      code: { $in: accountCodes },
      company: new mongoose.Types.ObjectId(companyId),
    }).lean();

    const accountMap = {};
    for (const acc of accounts) {
      accountMap[acc.code] = acc;
    }

    // Build section arrays
    const nonCurrentAssetLines = [];
    const currentAssetLines = [];
    const equityLines = [];
    const nonCurrentLiabilityLines = [];
    const currentLiabilityLines = [];

    for (const bal of accountBalances) {
      let account = accountMap[bal._id];

      // If the Chart of Accounts entry is missing for this code, attempt a
      // conservative fallback: infer account type from numeric code ranges.
      // This helps when the COA hasn't been seeded for the company yet but
      // journal entries exist (trial balance will still show amounts).
      if (!account) {
        const codeNum = Number(bal._id);
        if (!Number.isNaN(codeNum)) {
          // Infer common account classes by numeric ranges.
          // Important: only include asset/liability/equity in the balance sheet.
          let inferredType = null;
          let inferredNormal = 'debit';

          if (codeNum >= 1000 && codeNum < 2000) {
            inferredType = 'asset';
            inferredNormal = 'debit';
          } else if (codeNum >= 2000 && codeNum < 3000) {
            inferredType = 'liability';
            inferredNormal = 'credit';
          } else if (codeNum >= 3000 && codeNum < 4000) {
            inferredType = 'equity';
            inferredNormal = 'credit';
          } else if (codeNum >= 4000 && codeNum < 5000) {
            inferredType = 'revenue';
            inferredNormal = 'credit';
          } else if (codeNum >= 5000 && codeNum < 6000) {
            inferredType = 'cogs';
            inferredNormal = 'debit';
          } else if (codeNum >= 6000 && codeNum < 8000) {
            // 6000-6999: operating expenses; 7000-7999: special/clearing expense accounts (7100, etc.)
            inferredType = 'expense';
            inferredNormal = 'debit';
          } else {
            // Default to asset for unknown ranges (8000+)
            inferredType = 'asset';
            inferredNormal = 'debit';
          }

          // Only include asset, liability or equity in the balance sheet.
          if (!['asset', 'liability', 'equity'].includes(inferredType)) {
            continue;
          }

          account = {
            _id: null,
            code: String(bal._id),
            name: String(bal._id),
            subtype: null,
            type: inferredType,
            normal_balance: inferredNormal,
          };
        } else {
          // Can't infer a sensible account code; skip it
          continue;
        }
      }

      const dr = parseFloat(bal.total_dr?.toString() || "0");
      const cr = parseFloat(bal.total_cr?.toString() || "0");

      // Apply normal balance direction
      let amount = account.normal_balance === "debit" ? dr - cr : cr - dr;

      // Dividends Paid is debit-normal equity — negate for balance sheet (reduces equity)
      if (account.subtype === "dividends") {
        amount = -Math.abs(amount);
      }

      const line = {
        account_id: account._id,
        account_code: account.code,
        account_name: account.name,
        sub_type: account.subtype,
        amount: Math.round(amount * 100) / 100,
      };

      const subtype = account.subtype || "";
      const type = account.type;

      // ── Classification Logic (IAS 1) ──────────────────────────────
      if (type === "asset") {
        if (BalanceSheetService._isNonCurrentAsset(subtype)) {
          // Non-Current Assets: fixed, land
          nonCurrentAssetLines.push(line);
        } else if (BalanceSheetService._isContraAsset(subtype)) {
          // Contra Assets (Accumulated Depreciation) — show as negative under non-current
          line.amount = -Math.abs(line.amount);
          nonCurrentAssetLines.push(line);
        } else {
          // Current Assets: cash, current, inventory, prepaid, ar, vat_input
          currentAssetLines.push(line);
        }
      } else if (type === "liability") {
        // VAT Input (2210) is liability type but debit-normal — it's a receivable, classify as current asset
        if (subtype === "vat_input" && account.normal_balance === "debit") {
          currentAssetLines.push(line);
          continue;
        }

        // IAS 1: Classify liabilities as current or non-current based on maturity
        const maturityData = loanMaturityData.get(account._id?.toString());

        if (maturityData && (maturityData.dueWithin12Months > 0 || maturityData.dueAfter12Months > 0)) {
          // This account has linked loans with maturity data - split between current and non-current
          const totalBalance = Math.abs(line.amount);
          const currentPortion = Math.min(maturityData.dueWithin12Months, totalBalance);
          const nonCurrentPortion = totalBalance - currentPortion;

          // Add current portion if significant (> 0.01)
          if (currentPortion > 0.01) {
            currentLiabilityLines.push({
              ...line,
              amount: line.amount >= 0 ? currentPortion : -currentPortion,
              maturity_classification: "current",
              due_within_12_months: maturityData.dueWithin12Months,
              due_after_12_months: maturityData.dueAfter12Months,
              loan_details: maturityData.loans.filter(l => l.isCurrent)
            });
          }

          // Add non-current portion if significant (> 0.01)
          if (nonCurrentPortion > 0.01) {
            nonCurrentLiabilityLines.push({
              ...line,
              amount: line.amount >= 0 ? nonCurrentPortion : -nonCurrentPortion,
              maturity_classification: "non_current",
              due_within_12_months: maturityData.dueWithin12Months,
              due_after_12_months: maturityData.dueAfter12Months,
              loan_details: maturityData.loans.filter(l => !l.isCurrent)
            });
          }
        } else if (subtype === "non_current" || subtype === "long_term_loan") {
          // Explicit non-current subtype with no loan data - classify as non-current
          nonCurrentLiabilityLines.push({
            ...line,
            maturity_classification: "non_current"
          });
        } else if (subtype === "current" || subtype === "short_term_loan") {
          // Explicit current subtype - classify as current
          currentLiabilityLines.push({
            ...line,
            maturity_classification: "current"
          });
        } else if (
          ["vat_output", "paye_payable", "rssb_payable", "withholding_tax_payable", "income_tax_payable"].includes(subtype)
        ) {
          // Tax payables are always current liabilities (<12 months)
          currentLiabilityLines.push({
            ...line,
            maturity_classification: "current"
          });
        } else {
          // Default: check account code range for loans (typically 2100-2199 current, 2200-2299 non-current)
          const codeNum = Number(account.code);
          if (!Number.isNaN(codeNum) && codeNum >= 2200 && codeNum < 2300) {
            // Loan accounts in 2200-2299 range - default to non-current if no maturity data
            nonCurrentLiabilityLines.push({
              ...line,
              maturity_classification: "non_current_assumed"
            });
          } else {
            // Everything else (AP, tax, accruals, etc.) - current liability
            currentLiabilityLines.push({
              ...line,
              maturity_classification: "current"
            });
          }
        }
      } else if (type === "equity") {
        // Exclude 3200 (Current Period Profit) — it is already injected into Retained
        // Earnings below via PLStatementService, so including it here would double-count.
        if (account.code !== "3200") {
          equityLines.push(line);
        }
      }
    }

    // Sort each section by account code
    const sortFn = (a, b) =>
      a.account_code.localeCompare(b.account_code, undefined, {
        numeric: true,
      });
    nonCurrentAssetLines.sort(sortFn);
    currentAssetLines.sort(sortFn);
    equityLines.sort(sortFn);
    nonCurrentLiabilityLines.sort(sortFn);
    currentLiabilityLines.sort(sortFn);

    // Compute current period net profit from P&L
    const fiscalYearStart = BalanceSheetService._getFiscalYearStart(
      asOfDate,
      company?.fiscal_year_start_month || 1,
    );

    const plData = await PLStatementService._buildPeriodData(
      companyId,
      fiscalYearStart.toISOString().split("T")[0],
      asOfDate,
    );
    const currentPeriodNetProfit = plData.net_profit;

    // Add current period net profit to retained earnings display
    const retainedEarningsLine = equityLines.find(
      (l) => l.sub_type === "retained",
    );
    if (retainedEarningsLine) {
      retainedEarningsLine.amount =
        Math.round(
          (retainedEarningsLine.amount + currentPeriodNetProfit) * 100,
        ) / 100;
      retainedEarningsLine.includes_current_period_profit = true;
      retainedEarningsLine.current_period_net_profit = currentPeriodNetProfit;
    } else {
      // No retained earnings journal entries exist — create a synthetic line with P&L net profit
      equityLines.push({
        account_id: null,
        account_code: "3100",
        account_name: "Retained Earnings",
        sub_type: "retained",
        amount: Math.round(currentPeriodNetProfit * 100) / 100,
        includes_current_period_profit: true,
        current_period_net_profit: currentPeriodNetProfit,
      });
      equityLines.sort((a, b) =>
        a.account_code.localeCompare(b.account_code, undefined, {
          numeric: true,
        }),
      );
    }

    // ── Inject computed income tax payable if P&L auto-computed tax ──
    // When the P&L computes statutory tax (no journal entry posted yet), the tax
    // liability must still appear on the balance sheet so that
    // Assets = Liabilities + Equity holds.
    if (plData.computed_tax && plData.tax && plData.tax.total > 0) {
      const computedTax = Math.round(plData.tax.total * 100) / 100;
      const existingTaxLine = currentLiabilityLines.find(
        (l) => l.account_code === "2400",
      );
      if (existingTaxLine) {
        existingTaxLine.amount =
          Math.round((existingTaxLine.amount + computedTax) * 100) / 100;
        existingTaxLine.includes_computed_tax = true;
        existingTaxLine.computed_tax_amount = computedTax;
      } else {
        currentLiabilityLines.push({
          account_id: null,
          account_code: "2400",
          account_name: "Income Tax Payable",
          sub_type: "income_tax_payable",
          amount: computedTax,
          maturity_classification: "current",
          is_computed: true,
          computed_tax_amount: computedTax,
        });
      }
      currentLiabilityLines.sort((a, b) =>
        a.account_code.localeCompare(b.account_code, undefined, {
          numeric: true,
        }),
      );
    }

    // Compute section totals
    const round = (n) => Math.round(n * 100) / 100;
    const sumLines = (lines) => round(lines.reduce((s, l) => s + l.amount, 0));

    const totalNonCurrentAssets = sumLines(nonCurrentAssetLines);
    const totalCurrentAssets = sumLines(currentAssetLines);
    const totalAssets = round(totalNonCurrentAssets + totalCurrentAssets);

    const totalEquity = sumLines(equityLines);
    const totalNonCurrentLiabilities = sumLines(nonCurrentLiabilityLines);
    const totalCurrentLiabilities = sumLines(currentLiabilityLines);
    const totalLiabilities = round(
      totalNonCurrentLiabilities + totalCurrentLiabilities,
    );
    const totalEquityAndLiabilities = round(totalEquity + totalLiabilities);

    const difference = Math.abs(totalAssets - totalEquityAndLiabilities);
    const isBalanced = difference < 0.01;

    return {
      // Non-Current Assets
      non_current_assets: {
        lines: nonCurrentAssetLines,
        total: totalNonCurrentAssets,
      },

      // Current Assets
      current_assets: {
        lines: currentAssetLines,
        total: totalCurrentAssets,
      },

      // Total Assets
      total_assets: totalAssets,

      // Equity
      equity: {
        lines: equityLines,
        total: totalEquity,
      },

      // Non-Current Liabilities
      non_current_liabilities: {
        lines: nonCurrentLiabilityLines,
        total: totalNonCurrentLiabilities,
      },

      // Current Liabilities
      current_liabilities: {
        lines: currentLiabilityLines,
        total: totalCurrentLiabilities,
      },

      // Total Liabilities
      total_liabilities: totalLiabilities,

      // Total Equity & Liabilities
      total_equity_and_liabilities: totalEquityAndLiabilities,

      // Balance check
      is_balanced: isBalanced,
      difference: round(difference),

      // P&L integration
      current_period_net_profit: round(currentPeriodNetProfit),
    };
  }

  /**
   * Get loan maturity data for liability accounts to determine current vs non-current split
   * @param {string} companyId - Company ID
   * @param {Date} asOfDate - Balance sheet date
   * @returns {Map<string, {dueWithin12Months: number, dueAfter12Months: number, loans: Array}>}
   */
  static async _getLoanMaturityData(companyId, asOfDate) {
    const twelveMonthsLater = new Date(asOfDate);
    twelveMonthsLater.setMonth(twelveMonthsLater.getMonth() + 12);

    // Get all active loans for this company
    let loans = [];
    if (isMongoConnected()) {
      try {
        loans = await Loan.find({
          company: new mongoose.Types.ObjectId(companyId),
          status: { $in: ['active', 'short-term', 'long-term'] },
          outstandingBalance: { $gt: 0 }
        }).lean();
      } catch (_err) {
        loans = [];
      }
    }

    const maturityMap = new Map();

    for (const loan of loans) {
      const liabilityAccountId = loan.liabilityAccountId?.toString();
      if (!liabilityAccountId) continue;

      if (!maturityMap.has(liabilityAccountId)) {
        maturityMap.set(liabilityAccountId, {
          dueWithin12Months: 0,
          dueAfter12Months: 0,
          loans: []
        });
      }

      const data = maturityMap.get(liabilityAccountId);
      const endDate = loan.endDate ? new Date(loan.endDate) : null;
      const outstandingBalance = loan.outstandingBalance || 0;

      // Determine if loan matures within 12 months of balance sheet date
      if (endDate && endDate <= twelveMonthsLater) {
        data.dueWithin12Months += outstandingBalance;
      } else {
        data.dueAfter12Months += outstandingBalance;
      }

      data.loans.push({
        loanNumber: loan.loanNumber,
        name: loan.name,
        endDate: loan.endDate,
        outstandingBalance: outstandingBalance,
        isCurrent: endDate ? endDate <= twelveMonthsLater : false
      });
    }

    return maturityMap;
  }

  /**
   * Check if asset subtype is non-current
   */
  static _isNonCurrentAsset(subtype) {
    return ["fixed", "fixed_asset", "non_current", "land"].includes(subtype);
  }

  /**
   * Check if asset subtype is contra (accumulated depreciation)
   */
  static _isContraAsset(subtype) {
    return ["contra", "contra_asset"].includes(subtype);
  }

  /**
   * Get fiscal year start date
   */
  static _getFiscalYearStart(asOfDate, fiscalYearStartMonth) {
    const date = new Date(asOfDate);
    const year =
      date.getMonth() + 1 >= fiscalYearStartMonth
        ? date.getFullYear()
        : date.getFullYear() - 1;
    return new Date(
      `${year}-${String(fiscalYearStartMonth).padStart(2, "0")}-01`,
    );
  }

  /**
   * Return empty period data structure
   * @private
   */
  static _emptyPeriodData() {
    return {
      non_current_assets: { lines: [], total: 0 },
      current_assets: { lines: [], total: 0 },
      total_assets: 0,
      equity: { lines: [], total: 0 },
      non_current_liabilities: { lines: [], total: 0 },
      current_liabilities: { lines: [], total: 0 },
      total_liabilities: 0,
      total_equity_and_liabilities: 0,
      is_balanced: true,
      difference: 0,
      current_period_net_profit: 0,
    };
  }
}

module.exports = BalanceSheetService;
