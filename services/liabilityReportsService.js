/**
 * Liability Reports Service
 *
 * Generates IFRS-compliant liability reports including:
 * - Debt Maturity Schedule (IAS 1 disclosure requirement)
 * - Interest Expense Analysis
 * - Covenant Compliance Report
 * - Liability Reconciliation
 */

const mongoose = require("mongoose");
const Loan = require("../models/Loan");
const ChartOfAccount = require("../models/ChartOfAccount");
const JournalEntry = require("../models/JournalEntry");
const journalAgg = require("./journalAggregationService");

class LiabilityReportsService {
  /**
   * Generate Debt Maturity Schedule
   * IFRS 7 Financial Instruments: Disclosures - Full Compliance
   * IAS 1.74 - Covenant reclassification
   * IFRS 7.39 - Undiscounted cash flow analysis
   * IFRS 7.33 - Classifications
   * IFRS 7.34 - Currency risk
   *
   * @param {string} companyId - Company ID
   * @param {Date} asOfDate - Balance sheet date
   * @param {number} yearsAhead - Number of years to project (default 5)
   */
  static async generateDebtMaturitySchedule(
    companyId,
    asOfDate,
    yearsAhead = 5,
  ) {
    if (!companyId) throw new Error("COMPANY_ID_REQUIRED");

    const reportDate = new Date(asOfDate);
    reportDate.setHours(23, 59, 59, 999);

    // Get all active loans with outstanding balance
    const loans = await Loan.find({
      company: new mongoose.Types.ObjectId(companyId),
      status: { $in: ["active", "short-term", "long-term"] },
      outstandingBalance: { $gt: 0 },
    })
      .populate("liabilityAccountId", "code name")
      .populate("relatedPartyId", "name")
      .lean();

    // Get balance sheet borrowings total for reconciliation
    const bsBorrowings = await this._getBalanceSheetBorrowings(companyId, reportDate);

    // Build time buckets
    const buckets = this._buildTimeBuckets(reportDate, yearsAhead);

    // Initialize bucket totals with IFRS 7.39 cash flow columns
    const bucketTotals = {};
    buckets.forEach((bucket) => {
      bucketTotals[bucket.key] = {
        key: bucket.key,
        label: bucket.label,
        startDate: bucket.start,
        endDate: bucket.end,
        principal_amount: 0,
        interest_amount: 0,
        total_cash_flow: 0,
        loans: [],
      };
    });

    // Add "undetermined" bucket for loans without end dates
    bucketTotals["undetermined"] = {
      key: "undetermined",
      label: "No Maturity Date",
      startDate: null,
      endDate: null,
      principal_amount: 0,
      interest_amount: 0,
      total_cash_flow: 0,
      loans: [],
    };

    // Covenant breach loans get reclassified to Current per IAS 1.74
    const currentYearKey = "current_year";

    // Track classifications and currencies for breakdown
    const classificationBreakdown = {
      secured: { count: 0, amount: 0 },
      unsecured: { count: 0, amount: 0 },
    };
    const typeBreakdown = {
      bank_loan: { count: 0, amount: 0 },
      bond: { count: 0, amount: 0 },
      finance_lease: { count: 0, amount: 0 },
      related_party: { count: 0, amount: 0 },
      other: { count: 0, amount: 0 },
    };
    const currencyBreakdown = {};
    const covenantBreaches = [];

    const loanDetails = [];

    for (const loan of loans) {
      const outstanding = loan.outstandingBalance || 0;
      const interestRate = loan.interestRate || 0;

      // IAS 1.74: Covenant breach reclassification
      const hasCovenantBreach = loan.covenantBreach === true;
      let bucketKey = this._assignToBucket(loan.endDate, buckets);

      // If covenant breached, reclassify to Current per IAS 1.74
      if (hasCovenantBreach && bucketKey !== currentYearKey) {
        bucketKey = currentYearKey;
      }

      // Calculate undiscounted interest for the period (IFRS 7.39)
      const bucket = bucketTotals[bucketKey];
      const interestAmount = this._calculateBucketInterest(
        outstanding,
        interestRate,
        loan.endDate,
        bucket.startDate,
        bucket.endDate,
        reportDate
      );

      const loanDetail = {
        loanId: loan._id.toString(),
        loanNumber: loan.loanNumber,
        name: loan.name,
        lenderName: loan.lenderName,
        originalAmount: loan.originalAmount,
        outstandingBalance: outstanding,
        interestRate: interestRate,
        effectiveInterestRate: this._calculateEffectiveRate(loan),
        startDate: loan.startDate,
        endDate: loan.endDate,
        loanType: loan.loanType,
        bucket: bucketKey,
        // IFRS 7.33 Classification
        isSecured: loan.isSecured || false,
        securityDescription: loan.securityDescription || null,
        classification: loan.classification || 'bank_loan',
        // IFRS 7.34 Currency
        currencyCode: loan.currencyCode || 'RWF',
        exchangeRate: loan.exchangeRate || 1,
        amountInRWF: loan.currencyCode === 'RWF' ? outstanding : outstanding * (loan.exchangeRate || 1),
        // IAS 24 Related Party
        relatedPartyName: loan.relatedPartyName || (loan.relatedPartyId?.name) || null,
        // IAS 1.74 Covenant
        hasCovenants: loan.hasCovenants || false,
        covenantBreach: hasCovenantBreach,
        covenantBreachDate: loan.covenantBreachDate || null,
        covenantReclassified: hasCovenantBreach && bucketKey === currentYearKey,
        // Cash flow amounts (IFRS 7.39)
        principalAmount: outstanding,
        interestAmount: interestAmount,
        totalCashFlow: outstanding + interestAmount,
        // Liability account
        liabilityAccount: loan.liabilityAccountId
          ? {
              code: loan.liabilityAccountId.code,
              name: loan.liabilityAccountId.name,
            }
          : null,
      };

      loanDetails.push(loanDetail);

      // Add to bucket totals
      bucketTotals[bucketKey].principal_amount += outstanding;
      bucketTotals[bucketKey].interest_amount += interestAmount;
      bucketTotals[bucketKey].total_cash_flow += outstanding + interestAmount;
      bucketTotals[bucketKey].loans.push(loanDetail);

      // Update classification breakdown (IFRS 7.33)
      if (loan.isSecured) {
        classificationBreakdown.secured.count++;
        classificationBreakdown.secured.amount += outstanding;
      } else {
        classificationBreakdown.unsecured.count++;
        classificationBreakdown.unsecured.amount += outstanding;
      }

      // Update type breakdown
      const type = loan.classification || 'bank_loan';
      if (typeBreakdown[type]) {
        typeBreakdown[type].count++;
        typeBreakdown[type].amount += outstanding;
      }

      // Update currency breakdown (IFRS 7.34)
      const currency = loan.currencyCode || 'RWF';
      if (!currencyBreakdown[currency]) {
        currencyBreakdown[currency] = { count: 0, amount: 0, amountInRWF: 0 };
      }
      currencyBreakdown[currency].count++;
      currencyBreakdown[currency].amount += outstanding;
      currencyBreakdown[currency].amountInRWF += loanDetail.amountInRWF;

      // Track covenant breaches
      if (hasCovenantBreach) {
        covenantBreaches.push({
          loanId: loan._id.toString(),
          loanNumber: loan.loanNumber,
          name: loan.name,
          breachDate: loan.covenantBreachDate,
          reclassifiedTo: 'current_year',
        });
      }
    }

    // Calculate totals
    const totalDebt = loanDetails.reduce((sum, l) => sum + l.outstandingBalance, 0);
    const totalInterest = Object.values(bucketTotals).reduce((sum, b) => sum + b.interest_amount, 0);
    const totalCashFlow = totalDebt + totalInterest;

    // Calculate total with maturity (excluding undetermined)
    const totalWithMaturity = Object.values(bucketTotals)
      .filter((b) => b.key !== "undetermined")
      .reduce((sum, b) => sum + b.principal_amount, 0);

    // Sort buckets chronologically
    const orderedBuckets = buckets
      .map((b) => bucketTotals[b.key])
      .concat(bucketTotals["undetermined"]);

    // Round all amounts
    const round = (n) => Math.round(n * 100) / 100;

    return {
      company_id: companyId,
      report_date: reportDate.toISOString().split("T")[0],
      generated_at: new Date(),
      summary: {
        total_debt: round(totalDebt),
        total_interest: round(totalInterest),
        total_cash_flow: round(totalCashFlow),
        total_loans: loans.length,
        debt_with_maturity_date: round(totalWithMaturity),
        debt_without_maturity_date: round(bucketTotals["undetermined"].principal_amount || 0),
        covenant_breach_count: covenantBreaches.length,
      },
      // IFRS 7.39: Cash flow analysis by time bucket
      buckets: orderedBuckets.map((b) => ({
        key: b.key,
        label: b.label,
        startDate: b.startDate,
        endDate: b.endDate,
        principal_amount: round(b.principal_amount),
        interest_amount: round(b.interest_amount),
        total_cash_flow: round(b.total_cash_flow),
        loan_count: b.loans.length,
        effective_interest_rate: b.principal_amount > 0
          ? round((b.interest_amount / b.principal_amount) * 100)
          : 0,
      })),
      // IFRS 7.33: Classification breakdown
      classification_breakdown: {
        security: {
          secured: { count: classificationBreakdown.secured.count, amount: round(classificationBreakdown.secured.amount) },
          unsecured: { count: classificationBreakdown.unsecured.count, amount: round(classificationBreakdown.unsecured.amount) },
        },
        type: {
          bank_loan: { count: typeBreakdown.bank_loan.count, amount: round(typeBreakdown.bank_loan.amount), label: 'Bank Loan' },
          bond: { count: typeBreakdown.bond.count, amount: round(typeBreakdown.bond.amount), label: 'Bond' },
          finance_lease: { count: typeBreakdown.finance_lease.count, amount: round(typeBreakdown.finance_lease.amount), label: 'Finance Lease (IFRS 16)' },
          related_party: { count: typeBreakdown.related_party.count, amount: round(typeBreakdown.related_party.amount), label: 'Related Party (IAS 24)' },
          other: { count: typeBreakdown.other.count, amount: round(typeBreakdown.other.amount), label: 'Other' },
        },
      },
      // IFRS 7.34: Currency breakdown
      currency_breakdown: Object.entries(currencyBreakdown).map(([code, data]) => ({
        currency_code: code,
        count: data.count,
        amount: round(data.amount),
        amount_in_rwf: round(data.amountInRWF),
        exchange_rate_avg: code === 'RWF' ? 1 : round(data.amountInRWF / data.amount),
      })),
      // IAS 1.74: Covenant reclassifications
      covenant_reclassifications: covenantBreaches.map(c => ({
        loan_id: c.loanId,
        loan_number: c.loanNumber,
        name: c.name,
        breach_date: c.breachDate,
        note: 'Reclassified to Current due to covenant breach per IAS 1.74',
      })),
      // Balance Sheet reconciliation
      balance_sheet_reconciliation: {
        schedule_total: round(totalDebt),
        balance_sheet_borrowings: round(bsBorrowings),
        difference: round(Math.abs(totalDebt - bsBorrowings)),
        reconciled: Math.abs(totalDebt - bsBorrowings) < 0.01,
        note: Math.abs(totalDebt - bsBorrowings) < 0.01
          ? 'Schedule total reconciles to Balance Sheet borrowings'
          : 'Difference may be due to accrued interest or other adjustments',
      },
      loan_details: loanDetails.sort((a, b) => {
        if (!a.endDate) return 1;
        if (!b.endDate) return -1;
        return new Date(a.endDate) - new Date(b.endDate);
      }),
      ifrs_disclosure_notes: [
        "IFRS 7.39: Undiscounted cash flow analysis including contractual principal and interest payments",
        "IFRS 7.33: Loans classified by security (secured/unsecured) and type (bank loan, bond, finance lease, related party)",
        "IFRS 7.34: Foreign currency exposure disclosed by currency denomination",
        "IAS 1.74: Loans with covenant breaches reclassified to Current regardless of original maturity",
        "IAS 24: Related party loans identified separately for disclosure",
        "Amounts represent outstanding principal plus undiscounted future interest as of the report date",
        "Effective interest rate calculated as weighted average of interest rates within each bucket",
      ],
    };
  }

  /**
   * Get borrowings balance from Balance Sheet for reconciliation
   * @private
   */
  static async _getBalanceSheetBorrowings(companyId, asOfDate) {
    const dateTo = new Date(asOfDate);
    dateTo.setHours(23, 59, 59, 999);

    // Aggregate journal entries for liability accounts (2000-2999 range)
    const result = (await journalAgg.sumJournalLines(companyId, {
      dateTo,
      status: "posted",
      excludeReversed: true,
      // Borrowings only: Short Term Loans, Accrued Interest, Long Term Loans
      accountCodes: ["2700", "2800", "2900"],
    })).map((r) => ({ _id: r._id, total_dr: r.debit, total_cr: r.credit }));

    let totalBorrowings = 0;
    for (const row of result) {
      // Liabilities are credit-normal
      const balance = (row.total_cr || 0) - (row.total_dr || 0);
      totalBorrowings += Math.abs(balance);
    }

    return Math.round(totalBorrowings * 100) / 100;
  }

  /**
   * Calculate undiscounted interest for a bucket period (IFRS 7.39)
   * @private
   */
  static _calculateBucketInterest(principal, rate, endDate, bucketStart, bucketEnd, reportDate) {
    if (!rate || rate <= 0) return 0;
    if (!bucketStart || !bucketEnd) {
      // For thereafter bucket - estimate based on remaining term
      if (!endDate) return 0;
      const remainingMonths = Math.max(0, Math.ceil((new Date(endDate) - reportDate) / (30 * 24 * 60 * 60 * 1000)));
      return principal * (rate / 100) * (remainingMonths / 12);
    }

    // Calculate months in this bucket
    const monthsInBucket = Math.max(1,
      Math.ceil((bucketEnd - bucketStart) / (30 * 24 * 60 * 60 * 1000))
    );

    // Simple interest calculation for the period (undiscounted per IFRS 7.39)
    const annualInterest = principal * (rate / 100);
    const periodInterest = annualInterest * (monthsInBucket / 12);

    return Math.max(0, periodInterest);
  }

  /**
   * Calculate effective interest rate for a loan
   * @private
   */
  static _calculateEffectiveRate(loan) {
    // Simplified - in practice would include fees and charges
    return loan.interestRate || 0;
  }

  /**
   * Build time buckets for maturity analysis
   * @private
   */
  static _buildTimeBuckets(asOfDate, yearsAhead) {
    const buckets = [];
    const start = new Date(asOfDate);

    // Current year remaining (from asOfDate to end of fiscal year)
    const currentYearEnd = new Date(start.getFullYear(), 11, 31);
    buckets.push({
      key: "current_year",
      label: `Current Year (${start.getFullYear()})`,
      start: new Date(start),
      end: new Date(currentYearEnd),
    });

    // Year 1 bucket (next 12 months from asOfDate)
    const year1Start = new Date(start);
    const year1End = new Date(start);
    year1End.setMonth(year1End.getMonth() + 12);
    buckets.push({
      key: "year_1",
      label: "Due Within 1 Year",
      start: new Date(year1Start),
      end: new Date(year1End),
    });

    // Year 2-5 buckets
    for (let i = 2; i <= yearsAhead; i++) {
      const bucketStart = new Date(start);
      bucketStart.setMonth(bucketStart.getMonth() + (i - 1) * 12);
      const bucketEnd = new Date(start);
      bucketEnd.setMonth(bucketEnd.getMonth() + i * 12);

      buckets.push({
        key: `year_${i}`,
        label: `Year ${i}`,
        start: bucketStart,
        end: bucketEnd,
      });
    }

    // Thereafter (beyond year 5)
    const thereafterStart = new Date(start);
    thereafterStart.setMonth(thereafterStart.getMonth() + yearsAhead * 12);
    buckets.push({
      key: "thereafter",
      label: "Thereafter (> 5 Years)",
      start: thereafterStart,
      end: null, // Open-ended
    });

    return buckets;
  }

  /**
   * Assign a loan to the appropriate time bucket
   * @private
   */
  static _assignToBucket(endDate, buckets) {
    if (!endDate) return "undetermined";

    const loanEnd = new Date(endDate);

    // Check each bucket in reverse order (thereafter first)
    for (let i = buckets.length - 1; i >= 0; i--) {
      const bucket = buckets[i];
      if (bucket.end === null) {
        // Thereafter bucket
        if (loanEnd >= bucket.start) return bucket.key;
      } else if (loanEnd <= bucket.end && loanEnd > bucket.start) {
        return bucket.key;
      }
    }

    // If before all buckets, assign to current year
    if (loanEnd <= buckets[0].end) return "current_year";

    return "undetermined";
  }

  /**
   * Generate Interest Expense Analysis
   * Compare actual interest expense vs budgeted/expected
   */
  static async generateInterestExpenseAnalysis(
    companyId,
    dateFrom,
    dateTo,
  ) {
    if (!companyId) throw new Error("COMPANY_ID_REQUIRED");

    const start = new Date(dateFrom);
    start.setHours(0, 0, 0, 0);
    const end = new Date(dateTo);
    end.setHours(23, 59, 59, 999);

    // Get interest expense accounts
    const interestAccounts = await ChartOfAccount.find({
      company: new mongoose.Types.ObjectId(companyId),
      $or: [
        { subtype: "interest" },
        { subtype: "interest_expense" },
        { name: { $regex: "interest", $options: "i" } },
      ],
      isActive: true,
    }).lean();

    const accountCodes = interestAccounts.map((a) => a.code);

    // Get journal entries for interest expense
    const interestEntries = await JournalEntry.find({
      company: new mongoose.Types.ObjectId(companyId),
      status: "posted",
      date: { $gte: start, $lte: end },
      $or: [
        { "lines.accountCode": { $in: accountCodes } },
        { sourceType: "liability_interest" },
      ],
    }).lean();

    // Calculate interest by source
    const bySource = {};
    let totalInterest = 0;

    for (const entry of interestEntries) {
      for (const line of entry.lines) {
        if (
          accountCodes.includes(line.accountCode) ||
          (entry.sourceType === "liability_interest" && line.debit > 0)
        ) {
          const amount = parseFloat(line.debit || 0);
          totalInterest += amount;

          const source = entry.sourceType || "other";
          if (!bySource[source]) {
            bySource[source] = { amount: 0, entries: [] };
          }
          bySource[source].amount += amount;
          bySource[source].entries.push({
            date: entry.date,
            description: entry.description,
            amount: amount,
            reference: entry.reference,
          });
        }
      }
    }

    // Get active loans for comparison
    const loans = await Loan.find({
      company: new mongoose.Types.ObjectId(companyId),
      status: { $in: ["active", "short-term", "long-term"] },
      outstandingBalance: { $gt: 0 },
    }).lean();

    // Calculate expected interest (simple calculation)
    const expectedInterest = loans.reduce((sum, loan) => {
      const rate = loan.interestRate || 0;
      const balance = loan.outstandingBalance || 0;
      const days = Math.max(1, (end - start) / (1000 * 60 * 60 * 24));
      // Simple interest for the period
      const annualInterest = balance * (rate / 100);
      const periodInterest = annualInterest * (days / 365);
      return sum + periodInterest;
    }, 0);

    return {
      company_id: companyId,
      period: { from: dateFrom, to: dateTo },
      generated_at: new Date(),
      summary: {
        total_interest_expense: Math.round(totalInterest * 100) / 100,
        expected_interest: Math.round(expectedInterest * 100) / 100,
        variance: Math.round((totalInterest - expectedInterest) * 100) / 100,
        loan_count: loans.length,
      },
      by_source: Object.entries(bySource).map(([source, data]) => ({
        source,
        total_amount: Math.round(data.amount * 100) / 100,
        entry_count: data.entries.length,
      })),
      loan_details: loans.map((loan) => ({
        loanNumber: loan.loanNumber,
        name: loan.name,
        outstandingBalance: loan.outstandingBalance,
        interestRate: loan.interestRate,
        annualInterest: Math.round(
          (loan.outstandingBalance * (loan.interestRate || 0)) / 100 * 100,
        ) / 100,
      })),
    };
  }
}

module.exports = LiabilityReportsService;
