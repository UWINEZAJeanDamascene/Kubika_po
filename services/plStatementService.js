const { toIdString } = require("../utils/objectId");
const { prisma } = require("../lib/prisma");
const journalAgg = require("./journalAggregationService");
const ChartOfAccount = require("../models/ChartOfAccount");
const { CHART_OF_ACCOUNTS } = require("../constants/chartOfAccounts");

/**
 * P&L Statement Service — IAS 1 Compliant Income Statement Format
 *
 * Structure (IAS 1 / IFRS):
 *   1.  Revenue
 *   2.  Cost of Sales (COGS)
 *   3.  Gross Profit (= Revenue - COGS)
 *   4.  Other Income
 *   5.  Distribution Costs
 *   6.  Administrative Expenses
 *   7.  Other Expenses
 *   8.  Operating Profit / EBIT (= GP + Other Income - Distribution - Admin - Other)
 *   9.  Finance Costs
 *  10.  Share of Profit of Associates/JV (placeholder)
 *  11.  Profit Before Tax (= EBIT - Finance Costs + Share of Associates)
 *  12.  Tax Expense (income tax, with effective tax rate)
 *  13.  Profit for the Period from Continuing Operations (= PBT - Tax)
 *  14.  Profit/(Loss) from Discontinued Operations (net of tax)
 *  15.  Profit for the Period (= Continuing + Discontinued)
 *  16.  Other Comprehensive Income (OCI) items
 *  17.  Total Comprehensive Income (= Profit + OCI)
 *  18.  Profit attributable to: Owners / Non-controlling Interests
 *  19.  Earnings Per Share (Basic & Diluted)
 *
 * Also computes:
 *   - EBITDA (= EBIT + Depreciation + Amortisation)
 *   - Margin percentages (gross, operating, net)
 *   - Effective tax rate
 *
 * Uses embedded lines in JournalEntry.
 * All amounts computed from posted journal entries for the given period.
 */
class PLStatementService {
  static _parseDateBoundary(value, boundary) {
    if (!value) throw new Error("DATE_RANGE_REQUIRED");

    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const date = dateOnly ? new Date(`${value}T00:00:00.000Z`) : new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new Error("INVALID_DATE_RANGE");
    }

    if (dateOnly && boundary === "end") {
      date.setUTCHours(23, 59, 59, 999);
    }

    return date;
  }

  /**
   * Generate P&L Statement report
   * @param {string} companyId
   * @param {object} options — { dateFrom, dateTo, comparativeDateFrom, comparativeDateTo }
   */
  static async generate(
    companyId,
    { dateFrom, dateTo, comparativeDateFrom, comparativeDateTo },
  ) {
    if (!companyId) throw new Error("COMPANY_ID_REQUIRED");
    if (!dateFrom || !dateTo) throw new Error("DATE_RANGE_REQUIRED");
    if (
      PLStatementService._parseDateBoundary(dateFrom, "start") >
      PLStatementService._parseDateBoundary(dateTo, "end")
    ) {
      throw new Error("INVALID_DATE_RANGE");
    }

    if (
      (comparativeDateFrom && !comparativeDateTo) ||
      (!comparativeDateFrom && comparativeDateTo)
    ) {
      throw new Error("COMPARATIVE_DATE_RANGE_REQUIRED");
    }
    if (
      comparativeDateFrom &&
      comparativeDateTo &&
      PLStatementService._parseDateBoundary(comparativeDateFrom, "start") >
        PLStatementService._parseDateBoundary(comparativeDateTo, "end")
    ) {
      throw new Error("INVALID_COMPARATIVE_DATE_RANGE");
    }

    const [currentPeriod, comparativePeriod] = await Promise.all([
      PLStatementService._buildPeriodData(companyId, dateFrom, dateTo),
      comparativeDateFrom && comparativeDateTo
        ? PLStatementService._buildPeriodData(
            companyId,
            comparativeDateFrom,
            comparativeDateTo,
          )
        : null,
    ]);

    return {
      company_id: companyId,
      date_from: dateFrom,
      date_to: dateTo,
      current: currentPeriod,
      comparative: comparativePeriod,
      generated_at: new Date(),
    };
  }

  /**
   * Build period data — full IAS 1 compliant P&L with all sections.
   * @private
   */
  static async _buildPeriodData(companyId, dateFrom, dateTo) {
    // ── Step 1: Aggregate all journal entry lines by account code ────
    // Interpret YYYY-MM-DD ranges as full UTC business days. Local setHours()
    // can drop late-day UTC postings for tenants in non-UTC time zones.
    const dateFromInclusive = PLStatementService._parseDateBoundary(dateFrom, "start");
    const dateToInclusive = PLStatementService._parseDateBoundary(dateTo, "end");

    const cid = toIdString(companyId);
    const rawAccountBalances = await journalAgg.sumLinesByAccountCode(cid, {
      dateFrom: dateFromInclusive,
      dateTo: dateToInclusive,
    });

    const accountBalanceMap = new Map();
    for (const balance of rawAccountBalances) {
      const code = String(balance.accountCode || "").trim();
      if (!code) continue;

      const existing = accountBalanceMap.get(code) || {
        _id: code,
        total_dr: 0,
        total_cr: 0,
      };

      existing.total_dr += Number(balance.totalDebit) || 0;
      existing.total_cr += Number(balance.totalCredit) || 0;
      accountBalanceMap.set(code, existing);
    }

    const accountBalances = Array.from(accountBalanceMap.values());

    if (accountBalances.length === 0) {
      return PLStatementService._emptyPeriodData();
    }

    // ── Step 2: Load account details for classification ──────────────
    const accountCodes = accountBalances.map((b) => b._id);
    const accounts = await ChartOfAccount.find({
      code: { $in: accountCodes },
      company: cid,
      type: { $in: ["revenue", "expense", "cogs"] },
    }).lean();

    const accountMap = {};
    for (const acc of accounts) {
      accountMap[String(acc.code || "").trim()] = acc;
    }

    for (const rawCode of accountCodes) {
      const code = String(rawCode || "").trim();
      if (!accountMap[code] && CHART_OF_ACCOUNTS[code]) {
        accountMap[code] = {
          _id: code,
          code,
          ...CHART_OF_ACCOUNTS[code],
        };
      }
    }

    // ── Step 3: Classify each account into IAS 1 P&L sections ───────
    const revenueLines = []; // Sales Revenue (4000), Sales Returns (4100 — contra, negated)
    const cogsLines = []; // COGS (5000), Purchases (5100), Purchase Returns (5200 — contra, negated)
    const distributionCostLines = []; // Transport & Delivery (5700), Marketing (5850)
    const adminExpenseLines = []; // Salaries (5400), Rent (5500), Utilities (5600), etc.
    const otherExpenseLines = []; // Other Expenses (6100), Loss on Disposal (6050)
    const otherIncomeLines = []; // Other Income (4200), Gain on Disposal (4250)
    const financeIncomeLines = []; // Interest Income (4300) — shown below EBIT per IAS 1
    const financeCostLines = []; // Interest Expense (6000), Bank Charges (6200)
    const depreciationLines = []; // Depreciation (5800+) — tracked separately for EBITDA
    const taxLines = []; // Corporate Tax (6400)

    for (const bal of accountBalances) {
      const rawCode = String(bal._id || "").trim();
      const configuredAccount = accountMap[rawCode];
      const builtinAccount = CHART_OF_ACCOUNTS[rawCode];
      const account = configuredAccount || (builtinAccount
        ? { _id: rawCode, code: rawCode, ...builtinAccount }
        : null);
      if (!account) continue;

      const dr = parseFloat(bal.total_dr?.toString() || "0");
      const cr = parseFloat(bal.total_cr?.toString() || "0");

      // Amount based on normal balance direction
      let amount =
        account.normal_balance === "credit"
          ? cr - dr // credit-normal: revenue, liabilities, equity
          : dr - cr; // debit-normal: assets, expenses, cogs

      // ── Contra accounts: negate so they REDUCE their parent section ──
      // e.g. Sales Returns (4100) reduces Revenue; Purchase Returns (5200) reduces COGS
      const code = rawCode;
      const effectiveSubtype =
        code === "5300" ? "cogs" : code === "5200" ? "contra" : account.subtype || "";
      const effectiveType = code === "5300" || code === "5200" ? "cogs" : account.type;

      if (effectiveSubtype === "contra") {
        amount = -Math.abs(amount);
      }

      const line = {
        account_id: account._id,
        account_code: code,
        account_name: account.name,
        amount: Math.round(amount * 100) / 100,
      };

      const subtype = effectiveSubtype;
      const type = effectiveType;

      // ── Classification Logic (IAS 1) ──────────────────────────────
      if (type === "revenue") {
        if (subtype === "contra") {
          // Sales Returns (4100) — already negated above; reduces gross revenue
          revenueLines.push(line);
        } else if (subtype === "non_operating") {
          if (code === "4300") {
            // Interest Income → Finance Income (below EBIT per IAS 1 §82)
            financeIncomeLines.push(line);
          } else {
            // Other non-operating income: Other Income (4200), Gain on Disposal (4250)
            otherIncomeLines.push(line);
          }
        } else {
          // Operating Revenue: 4000 Sales Revenue
          revenueLines.push(line);
        }
      } else if (type === "cogs") {
        // COGS: 5000, 5100, 5110, 5150, 5300
        // Purchase Returns (5200, contra) — already negated, reduces COGS
        cogsLines.push(line);
      } else if (type === "expense") {
        if (subtype === "cogs") {
          // Backward compatibility: older companies/tests stored COGS as
          // expense + subtype=cogs before the dedicated "cogs" type existed.
          cogsLines.push(line);
        } else if (subtype === "financial") {
          // Finance Costs: 6000 (Interest Expense), 6200 (Bank Charges)
          financeCostLines.push(line);
        } else if (subtype === "tax") {
          // Tax Expense: 6400 (Corporate Tax)
          taxLines.push(line);
        } else if (subtype === "non_operating") {
          // Non-operating expense: 6050 Loss on Disposal → Other Expenses (P&L item, NOT OCI)
          otherExpenseLines.push(line);
        } else if (subtype === "depreciation" || code === "5800") {
          // Depreciation — tracked separately for EBITDA; also in admin expenses for EBIT calc
          depreciationLines.push(line);
          adminExpenseLines.push(line);
        } else if (subtype === "distribution") {
          // Distribution Costs: Transport & Delivery (5700), Marketing & Advertising (5850)
          distributionCostLines.push(line);
        } else if (subtype === "other_expense" && code !== "5910") {
          if (code === "5250") {
            // Bad Debt Expense is presented under Administrative Expenses.
            adminExpenseLines.push(line);
          } else {
            // Other Expenses: Other Expenses (6100)
            otherExpenseLines.push(line);
          }
        } else if (code === "5910") {
          // Miscellaneous Expenses → Administrative Expenses (override stale subtype)
          adminExpenseLines.push(line);
        } else if (subtype === "operating") {
          // Classify remaining operating expenses by code (backward-compat fallback)
          if (code === "5700" || code === "5850") {
            // Distribution Costs: Transport & Delivery, Marketing & Advertising
            // (fallback for ChartOfAccount records created before subtype update)
            distributionCostLines.push(line);
          } else if (code === "5250") {
            // Bad Debt Expense → Administrative Expenses
            adminExpenseLines.push(line);
          } else if (code === "6100") {
            // Other Expenses
            // (fallback for ChartOfAccount records created before subtype update)
            otherExpenseLines.push(line);
          } else {
            // Administrative Expenses: Salaries, Rent, Utilities, Payroll, etc.
            adminExpenseLines.push(line);
          }
        } else if (subtype === "rssb_employer_cost") {
          // RSSB Employer Cost → Administrative Expenses
          adminExpenseLines.push(line);
        } else {
          // Default: Administrative Expenses
          adminExpenseLines.push(line);
        }
      }
    }

    // ── Step 4: Sort each section by account code ───────────────────
    if (!cogsLines.some((line) => line.account_code === "5300")) {
      // Note: deliberately does NOT filter out reversed entries, matching the
      // original behavior of this fallback exactly.
      const directLaborRows = await prisma.$queryRaw`
        SELECT COALESCE(SUM(jel.debit), 0)::float AS "totalDebit",
               COALESCE(SUM(jel.credit), 0)::float AS "totalCredit"
        FROM journal_entry_lines jel
        INNER JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.company_id = ${cid}
          AND je.status = 'posted'
          AND je.date >= ${dateFromInclusive}
          AND je.date <= ${dateToInclusive}
          AND jel.account_code = '5300'
      `;

      const directLabor = directLaborRows[0];
      if (directLabor && (directLabor.totalDebit || directLabor.totalCredit)) {
        const amount =
          Math.round(
            (Number(directLabor.totalDebit) - Number(directLabor.totalCredit)) *
              100,
          ) / 100;

        if (amount !== 0) {
          cogsLines.push({
            account_id: accountMap["5300"]?._id || "5300",
            account_code: "5300",
            account_name: accountMap["5300"]?.name || "Direct Labor",
            amount,
          });
        }
      }
    }

    const sortFn = (a, b) =>
      a.account_code.localeCompare(b.account_code, undefined, {
        numeric: true,
      });
    revenueLines.sort(sortFn);
    cogsLines.sort(sortFn);
    distributionCostLines.sort(sortFn);
    adminExpenseLines.sort(sortFn);
    otherExpenseLines.sort(sortFn);
    otherIncomeLines.sort(sortFn);
    financeIncomeLines.sort(sortFn);
    financeCostLines.sort(sortFn);
    depreciationLines.sort(sortFn);
    taxLines.sort(sortFn);

    // ── Step 5: Compute section totals ──────────────────────────────
    const round = (n) => Math.round(n * 100) / 100;
    const sumLines = (lines) => round(lines.reduce((s, l) => s + l.amount, 0));

    const totalRevenue = sumLines(revenueLines); // Net revenue after contra (Sales Returns)
    const totalCOGS = sumLines(cogsLines); // Net COGS after contra (Purchase Returns)
    const grossProfit = round(totalRevenue - totalCOGS);

    const totalOtherIncome = sumLines(otherIncomeLines); // Other Income (4200, 4250)
    const totalDistributionCosts = sumLines(distributionCostLines);
    const totalAdminExpenses = sumLines(adminExpenseLines); // Includes depreciation
    const totalOtherExpenses = sumLines(otherExpenseLines); // Loss on Disposal, Other Expenses, etc.

    // ── Operating Profit (EBIT) per IAS 1 ────────────────────────────────
    // = Gross Profit + Other Operating Income − Distribution − Admin − Other Operating Expenses
    // Finance Income (Interest) is excluded from EBIT (shown separately below)
    const operatingProfit = round(
      grossProfit +
        totalOtherIncome -
        totalDistributionCosts -
        totalAdminExpenses -
        totalOtherExpenses,
    );

    // ── EBITDA ────────────────────────────────────────────────────────────
    // = EBIT + Depreciation & Amortisation (add back non-cash charge)
    const totalFinanceCosts = sumLines(financeCostLines);
    const totalFinanceIncome = sumLines(financeIncomeLines); // Interest Income (below EBIT)
    const totalDepreciation = sumLines(depreciationLines);
    const ebitda = round(operatingProfit + totalDepreciation);

    const shareOfAssociates = 0; // placeholder for equity method investments

    // ── Profit Before Tax (PBT) per IAS 1 §82 ────────────────────────────
    // = EBIT + Finance Income − Finance Costs + Share of Associates
    const profitBeforeTax = round(
      operatingProfit +
        totalFinanceIncome -
        totalFinanceCosts +
        shareOfAssociates,
    );

    // Corporate income tax: use posted/accrued tax journal entries when present.
    // If no tax entry has been posted, compute the statutory provision at 30%
    // of positive PBT so the P&L presents profit after income tax.
    const CORPORATE_TAX_RATE = 0.3;
    let totalTax = sumLines(taxLines);
    let computedTax = false;
    if (totalTax === 0 && profitBeforeTax > 0) {
      totalTax = round(profitBeforeTax * CORPORATE_TAX_RATE);
      computedTax = true;
    }

    const profitAfterTax = round(profitBeforeTax - totalTax);
    const effectiveTaxRate =
      profitBeforeTax > 0
        ? round((totalTax / profitBeforeTax) * 100 * 100) / 100
        : 0;

    // Discontinued operations (placeholder — no data unless journal entries exist)
    const totalDiscontinuedOps = 0;

    const profitForPeriod = round(profitAfterTax + totalDiscontinuedOps);

    // ── Other Comprehensive Income (OCI) ─────────────────────────────────
    // IAS 1 §82A: OCI includes revaluation surplus, FX translation differences,
    // actuarial gains/losses on defined benefit plans, etc.
    // These require dedicated OCI account codes not yet in this chart of accounts.
    // Loss on Disposal (6050) is a P&L item (now in otherExpenses), NOT OCI.
    const ociLines = []; // Reserved: add OCI account codes when needed
    const totalOCI = 0; // Zero until OCI accounts (e.g. revaluation reserve) are configured

    const totalComprehensiveIncome = round(profitForPeriod + totalOCI);

    // Non-controlling interests (placeholder — for group reporting)
    const nciShare = 0;
    const ownersShare = round(totalComprehensiveIncome - nciShare);
    const profitAttributableToOwners = round(profitForPeriod - nciShare);

    // Earnings Per Share (placeholder — requires share count from company settings)
    const weightedAvgShares = 0; // Would come from company settings
    const basicEPS =
      weightedAvgShares > 0
        ? round(profitAttributableToOwners / weightedAvgShares)
        : null;
    const dilutedEPS = basicEPS; // Same unless dilutive instruments exist

    // ── Step 6: Compute margin percentages ──────────────────────────
    const pct = (numerator, denominator) =>
      denominator > 0 ? round((numerator / denominator) * 100 * 100) / 100 : 0;

    const grossMarginPct = pct(grossProfit, totalRevenue);
    const operatingMarginPct = pct(operatingProfit, totalRevenue);
    const netMarginPct = pct(profitForPeriod, totalRevenue);
    const ebitdaMarginPct = pct(ebitda, totalRevenue);

    return {
      // Section 1: Revenue (net of Sales Returns — contra already negated)
      revenue: {
        lines: revenueLines,
        total: totalRevenue,
      },

      // Section 2: Cost of Sales (net of Purchase Returns — contra already negated)
      cogs: {
        lines: cogsLines,
        total: totalCOGS,
      },

      // Section 3: Gross Profit
      gross_profit: grossProfit,
      gross_margin_pct: grossMarginPct,

      // Section 4: Other Income (non-finance: 4200 Other Income, 4250 Gain on Disposal)
      other_income: {
        lines: otherIncomeLines,
        total: totalOtherIncome,
      },

      // Section 5: Distribution Costs
      distribution_costs: {
        lines: distributionCostLines,
        total: totalDistributionCosts,
      },

      // Section 6: Administrative Expenses (includes Depreciation)
      administrative_expenses: {
        lines: adminExpenseLines,
        total: totalAdminExpenses,
      },

      // Section 7: Other Expenses (Loss on Disposal, misc)
      other_expenses: {
        lines: otherExpenseLines,
        total: totalOtherExpenses,
      },

      // Section 8: Operating Profit (EBIT)
      // = Gross Profit + Other Income − Distribution − Admin − Other Expenses
      operating_profit: operatingProfit,
      operating_margin_pct: operatingMarginPct,

      // EBITDA = EBIT + Depreciation & Amortisation
      ebitda: ebitda,
      ebitda_margin_pct: ebitdaMarginPct,
      depreciation_and_amortisation: totalDepreciation,

      // Section 9: Finance Income (Interest Income 4300 — below EBIT per IAS 1)
      finance_income: {
        lines: financeIncomeLines,
        total: totalFinanceIncome,
      },

      // Section 10: Finance Costs (Interest Expense 6000, Bank Charges 6200)
      finance_costs: {
        lines: financeCostLines,
        total: totalFinanceCosts,
      },

      // Section 11: Share of Profit of Associates/JV
      share_of_associates: shareOfAssociates,

      // Section 12: Profit Before Tax
      // = EBIT + Finance Income − Finance Costs + Share of Associates
      profit_before_tax: profitBeforeTax,

      // Section 13: Tax Expense
      tax: {
        lines: taxLines,
        total: totalTax,
      },
      corporate_tax_rate: CORPORATE_TAX_RATE,
      effective_tax_rate: effectiveTaxRate,
      computed_tax: computedTax,

      // Section 14: Profit After Tax (from continuing operations)
      profit_after_tax: profitAfterTax,

      // Section 15: Discontinued Operations
      discontinued_operations: {
        total: totalDiscontinuedOps,
      },

      // Section 16: Profit for the Period
      profit_for_period: profitForPeriod,

      // Section 17: Other Comprehensive Income
      // (currently zero — no OCI accounts configured; Loss on Disposal is a P&L item)
      other_comprehensive_income: {
        lines: ociLines,
        total: totalOCI,
      },

      // Section 18: Total Comprehensive Income
      total_comprehensive_income: totalComprehensiveIncome,

      // Section 19: Profit Attributable To
      profit_attributable_to_owners: profitAttributableToOwners,
      profit_attributable_to_nci: nciShare,
      comprehensive_income_attributable_to_owners: ownersShare,
      comprehensive_income_attributable_to_nci: nciShare,

      // Section 20: Earnings Per Share
      earnings_per_share: {
        weighted_avg_shares: weightedAvgShares,
        basic_eps: basicEPS,
        diluted_eps: dilutedEPS,
      },

      // Convenience aliases
      net_profit: profitForPeriod,
      net_margin_pct: netMarginPct,
      is_profit: profitForPeriod >= 0,

      // Legacy fields for backward compatibility
      operating_expenses: {
        lines: [
          ...distributionCostLines,
          ...adminExpenseLines,
          ...otherExpenseLines,
        ],
        total: round(
          totalDistributionCosts + totalAdminExpenses + totalOtherExpenses,
        ),
      },
      expenses: {
        lines: [
          ...distributionCostLines,
          ...adminExpenseLines,
          ...otherExpenseLines,
          ...financeCostLines,
          ...taxLines,
        ],
        total: round(
          totalDistributionCosts +
            totalAdminExpenses +
            totalOtherExpenses +
            totalFinanceCosts +
            totalTax,
        ),
      },
    };
  }

  /**
   * Return empty period data structure (all sections present with zero values).
   * @private
   */
  static _emptyPeriodData() {
    return {
      revenue: { lines: [], total: 0 },
      cogs: { lines: [], total: 0 },
      gross_profit: 0,
      gross_margin_pct: 0,
      other_income: { lines: [], total: 0 },
      distribution_costs: { lines: [], total: 0 },
      administrative_expenses: { lines: [], total: 0 },
      other_expenses: { lines: [], total: 0 },
      operating_profit: 0,
      operating_margin_pct: 0,
      ebitda: 0,
      ebitda_margin_pct: 0,
      depreciation_and_amortisation: 0,
      finance_income: { lines: [], total: 0 },
      finance_costs: { lines: [], total: 0 },
      share_of_associates: 0,
      profit_before_tax: 0,
      tax: { lines: [], total: 0 },
      corporate_tax_rate: 0.3,
      effective_tax_rate: 0,
      computed_tax: false,
      profit_after_tax: 0,
      discontinued_operations: { total: 0 },
      profit_for_period: 0,
      other_comprehensive_income: { lines: [], total: 0 },
      total_comprehensive_income: 0,
      profit_attributable_to_owners: 0,
      profit_attributable_to_nci: 0,
      comprehensive_income_attributable_to_owners: 0,
      comprehensive_income_attributable_to_nci: 0,
      earnings_per_share: {
        weighted_avg_shares: 0,
        basic_eps: null,
        diluted_eps: null,
      },
      net_profit: 0,
      net_margin_pct: 0,
      is_profit: true,
      operating_expenses: { lines: [], total: 0 },
      expenses: { lines: [], total: 0 },
    };
  }
}

module.exports = PLStatementService;
