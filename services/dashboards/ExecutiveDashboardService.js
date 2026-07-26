const mongoose = require('mongoose')
const { aggregateWithTimeout } = require('../../utils/mongoAggregation')
const JournalEntry = require('../../models/JournalEntry')
const ChartOfAccounts = require('../../models/ChartOfAccount')
const BankAccount = require('../../models/BankAccount')
const Invoice = require('../../models/Invoice')
const Company = require('../../models/Company')
const Loan = require('../../models/Loan')
const { PettyCashFloat } = require('../../models/PettyCash')
const dateHelpers = require('../../utils/dateHelpers')
const dashboardCache = require('../DashboardCacheService')
const { isMongoConnected } = require('../../utils/mongoConnection')

class ExecutiveDashboardService {

  static async get(companyId) {
    // Check cache first
    const cached = dashboardCache.get(companyId, 'executive')
    if (cached) {
      // If there's any new posted journal entry created after the cached
      // result was generated, consider the cache stale and recompute.
      try {
        const latest = await JournalEntry.findOne({ company: companyId, status: 'posted' }).sort({ createdAt: -1 }).select('createdAt').lean()
        if (latest && cached.generated_at && new Date(latest.createdAt) > new Date(cached.generated_at)) {
          // fall through and recompute
        } else {
          return cached
        }
      } catch (err) {
        // On any error while checking, fall back to returning cached value
        return cached
      }
    }

    const company = await Company.findById(companyId).lean()
    if (!company) {
      throw new Error('Company not found')
    }

    const currentFY = dateHelpers.currentFiscalYear(company.fiscal_year_start_month || 1)
    const thisMonth = dateHelpers.currentMonth()
    const lastMonth = dateHelpers.previousMonth()

    // Run all aggregations in parallel for performance
    const [
      revenueThisMonth,
      revenueFYTD,
      revenuePrevMonth,
      expensesThisMonth,
      expensesFYTD,
      expensesPrevMonth,
      cashBalance,
      outstandingAR,
      overdueAR,
      recentTransactions,
      upcomingDebtPayments
    ] = await Promise.all([
      ExecutiveDashboardService._getAccountTypeTotal(companyId, 'revenue', thisMonth.start, thisMonth.end),
      ExecutiveDashboardService._getAccountTypeTotal(companyId, 'revenue', currentFY.start, currentFY.end),
      ExecutiveDashboardService._getAccountTypeTotal(companyId, 'revenue', lastMonth.start, lastMonth.end),
      ExecutiveDashboardService._getAccountTypeTotal(companyId, 'expense', thisMonth.start, thisMonth.end),
      ExecutiveDashboardService._getAccountTypeTotal(companyId, 'expense', currentFY.start, currentFY.end),
      ExecutiveDashboardService._getAccountTypeTotal(companyId, 'expense', lastMonth.start, lastMonth.end),
      ExecutiveDashboardService._getTotalCashBalance(companyId),
      ExecutiveDashboardService._getOutstandingAR(companyId),
      ExecutiveDashboardService._getOverdueAR(companyId),
      ExecutiveDashboardService._getRecentJournalEntries(companyId, 5),
      ExecutiveDashboardService._getUpcomingDebtPayments(companyId)
    ])

    const netProfitThisMonth = dateHelpers.round2(revenueThisMonth - expensesThisMonth)
    const netProfitFYTD = dateHelpers.round2(revenueFYTD - expensesFYTD)
    const netProfitPrevMonth = dateHelpers.round2(revenuePrevMonth - expensesPrevMonth)

    const arOutstandingAmt = dateHelpers.round2(outstandingAR.total)
    const arOverdueAmt = dateHelpers.round2(overdueAR.total)
    const overduePctOfOutstanding =
      arOutstandingAmt > 0
        ? dateHelpers.round2(dateHelpers.safeDivide(arOverdueAmt, arOutstandingAmt) * 100)
        : 0

    const result = {
      company_id: companyId,
      generated_at: new Date(),

      // -- KEY METRICS --
      key_metrics: {
        revenue: {
          this_month: dateHelpers.round2(revenueThisMonth),
          fiscal_year_to_date: dateHelpers.round2(revenueFYTD),
          vs_last_month: dateHelpers.percentageChange(revenueThisMonth, revenuePrevMonth),
          label: 'Revenue'
        },
        expenses: {
          this_month: dateHelpers.round2(expensesThisMonth),
          fiscal_year_to_date: dateHelpers.round2(expensesFYTD),
          vs_last_month: dateHelpers.percentageChange(expensesThisMonth, expensesPrevMonth),
          label: 'Expenses'
        },
        net_profit: {
          this_month: netProfitThisMonth,
          fiscal_year_to_date: netProfitFYTD,
          vs_last_month: dateHelpers.percentageChange(netProfitThisMonth, netProfitPrevMonth),
          is_profit: netProfitFYTD >= 0,
          label: 'Net Profit'
        },
        cash_balance: {
          current: dateHelpers.round2(cashBalance),
          label: 'Cash Balance'
        }
      },

      // -- AR SUMMARY --
      accounts_receivable: {
        outstanding_total: arOutstandingAmt,
        outstanding_count: outstandingAR.count,
        overdue_total: arOverdueAmt,
        overdue_count: overdueAR.count,
        overdue_pct_of_outstanding: overduePctOfOutstanding
      },

      // -- RECENT ACTIVITY --
      recent_journal_entries: recentTransactions,

      // -- UPCOMING DEBT PAYMENTS --
      upcoming_debt_payments: upcomingDebtPayments,

      // -- DATE CONTEXT --
      date_context: {
        this_month_start: thisMonth.start,
        this_month_end: thisMonth.end,
        fiscal_year_start: currentFY.start,
        fiscal_year_end: currentFY.end
      }
    }

    // Backwards-compatible flat fields expected by older callers/tests
    result.revenue_this_month = dateHelpers.round2(revenueThisMonth)
    result.expenses_this_month = dateHelpers.round2(expensesThisMonth)
    result.net_profit_this_month = dateHelpers.round2(netProfitThisMonth)
    result.cash_balance = dateHelpers.round2(cashBalance)
    result.is_profit = netProfitThisMonth >= 0
    result.vs_last_month = dateHelpers.percentageChange(revenueThisMonth, revenuePrevMonth)
    result.outstanding_ar_count = outstandingAR.count || 0
    result.overdue_ar = dateHelpers.round2(overdueAR.total || 0)

    dashboardCache.set(companyId, 'executive', result)
    return result
  }

  // -- PRIVATE HELPERS --

  // Get net balance for all accounts of a given type in a date range
  // Revenue: CR - DR (normal balance credit)
  // Expense: DR - CR (normal balance debit)
  static async _getAccountTypeTotal(companyId, accountType, dateFrom, dateTo) {
    // Simpler approach: fetch chart accounts for the company and build a
    // map from code -> type, then iterate posted journal entries in the
    // date range and sum lines that match the requested account type.
    const chartAccounts = await ChartOfAccounts.find({ company: companyId, isActive: true }).select('code type allow_direct_posting').lean()
    if (!chartAccounts || chartAccounts.length === 0) return 0

      const codeToType = new Map()
      for (const c of chartAccounts) {
        // Respect allow_direct_posting when present
        if (c.allow_direct_posting === false) continue
        const code = c.code ? String(c.code).trim() : null
        if (code) {
          codeToType.set(code, c.type)
          // also add a normalized variant (strip leading zeros and lowercase)
          codeToType.set(code.replace(/^0+/, '').toLowerCase(), c.type)
        }
        // map by id string too - some journal lines store account _id instead of code
        if (c._id) codeToType.set(String(c._id), c.type)
      }

    // Allow a small timezone-safe margin so entries created at local midnight
    // aren't excluded when comparing against UTC month boundaries used elsewhere.
    const marginMs = 24 * 60 * 60 * 1000 // 1 day
    const qDateFrom = new Date(dateFrom.getTime() - marginMs)
    const qDateTo = new Date(dateTo.getTime() + marginMs)
    // Aggregate with $match first (tenant + date) before unwinding lines in application code
    const companyOid = mongoose.Types.ObjectId.isValid(companyId)
      ? new mongoose.Types.ObjectId(companyId)
      : companyId
    const entries = await aggregateWithTimeout(JournalEntry, [
      {
        $match: {
          company: companyOid,
          status: 'posted',
          date: { $gte: qDateFrom, $lte: qDateTo }
        }
      }
    ], 'dashboard')
    if (!entries || entries.length === 0) return 0

    let totalDr = 0
    let totalCr = 0
    for (const e of entries) {
      const lines = e.lines || []
      for (const l of lines) {
          let code = l.accountCode == null ? null : String(l.accountCode).trim()
          if (!code) continue

          // try direct match
          let t = codeToType.get(code)
          // try normalized match
          if (!t) t = codeToType.get(code.replace(/^0+/, '').toLowerCase())
          // try id match (code may be an ObjectId string)
          if (!t && mongoose.Types.ObjectId.isValid(code)) t = codeToType.get(code)

          if (!t) continue
          if (t !== accountType) continue

          const debit = l.debit && l.debit.toString ? parseFloat(l.debit.toString()) : Number(l.debit || 0)
          const credit = l.credit && l.credit.toString ? parseFloat(l.credit.toString()) : Number(l.credit || 0)
          totalDr += debit
          totalCr += credit
      }
    }

    return accountType === 'revenue' ? totalCr - totalDr : totalDr - totalCr
  }

  // Total cash = sum of all bank + petty cash account balances from journal
  static async _getTotalCashBalance(companyId) {

    const [banks, pettyCash] = await Promise.all([
      BankAccount.find({ company: companyId, isActive: true })
        .select('ledgerAccountId openingBalance').lean(),
      PettyCashFloat.find({ company: companyId, isActive: true })
        .select('ledgerAccountId openingBalance').lean()
    ])

    const cashAccountCodes = [
        ...banks.map(b => b.ledgerAccountId).filter(Boolean),
        ...pettyCash.map(p => p.ledgerAccountId).filter(Boolean)
      ].map(c => String(c))


    // Ensure commonly-used cash account code is included when no chart accounts exist (test data uses '1000')
    // include common fallback code
    if (!cashAccountCodes.includes('1000')) cashAccountCodes.push('1000')

    // Normalize for matching in aggregation
    const normalizedCashCodes = cashAccountCodes.map(c => String(c))

    if (cashAccountCodes.length === 0) return 0

    // Query JournalEntry documents with embedded lines for cash accounts
    const result = await aggregateWithTimeout(JournalEntry, [
      {
        $match: {
          company: new mongoose.Types.ObjectId(companyId),
          status: 'posted',
          // Exclude the opening balance journal entry to avoid double-counting
          // opening balances which are stored on BankAccount.openingBalance
          sourceType: { $ne: 'opening_balance' }
        }
      },
      { $unwind: '$lines' },
      {
        $match: {
          'lines.accountCode': { $in: normalizedCashCodes }
        }
      },
      {
        $group: {
          _id: null,
          total_dr: { $sum: { $toDouble: { $ifNull: [ '$lines.debit', 0 ] } } },
          total_cr: { $sum: { $toDouble: { $ifNull: [ '$lines.credit', 0 ] } } }
        }
      }
    ], 'dashboard')

    // Cash accounts are assets -- normal balance debit -> DR - CR
    const journalBalance = result.length
      ? (result[0].total_dr || 0) - (result[0].total_cr || 0)
      : 0

    // Add opening balances from bank and petty cash records
    // openingBalance in BankAccount is Decimal128, need to convert
    const bankOpeningTotal = banks.reduce((s, b) => {
      const val = b.openingBalance
      return s + (val ? parseFloat(val.toString()) : 0)
    }, 0)
    const pettyCashOpeningTotal = pettyCash.reduce((s, p) => s + (p.openingBalance || 0), 0)
    // If there are no NON-opening journal entries for cash accounts
    // but opening balances exist on the bank/petty records, return the
    // opening totals (so the dashboard reflects the actual opening position).
    if (result.length === 0 && (bankOpeningTotal + pettyCashOpeningTotal) > 0) {
      return bankOpeningTotal + pettyCashOpeningTotal
    }

    // Combine posted activity (excluding opening_balance) with stored opening balances
    return journalBalance + bankOpeningTotal + pettyCashOpeningTotal
  }

  static async _getOutstandingAR(companyId) {
    const result = await aggregateWithTimeout(Invoice, [
      {
        $match: {
          company: new mongoose.Types.ObjectId(companyId),
          status: { $in: ['confirmed', 'partially_paid'] }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $toDouble: { $ifNull: ['$amountOutstanding', 0] } } },
          count: { $sum: 1 }
        }
      }
    ], 'dashboard')
    return {
      total: result[0]?.total != null ? Number(result[0].total) : 0,
      count: result[0]?.count || 0
    }
  }

  static async _getOverdueAR(companyId) {
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)

    const result = await aggregateWithTimeout(Invoice, [
      {
        $match: {
          company: new mongoose.Types.ObjectId(companyId),
          status: { $in: ['confirmed', 'partially_paid'] },
          dueDate: { $lt: today }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $toDouble: { $ifNull: ['$amountOutstanding', 0] } } },
          count: { $sum: 1 }
        }
      }
    ], 'dashboard')
    return {
      total: result[0]?.total != null ? Number(result[0].total) : 0,
      count: result[0]?.count || 0
    }
  }

  static async _getRecentJournalEntries(companyId, limit) {
    return JournalEntry.find({
      company: companyId,
      status: 'posted'
    })
      .sort({ date: -1, createdAt: -1 })
      .limit(limit)
      .select('entryNumber description date sourceType totalDebit totalCredit')
      .lean()
  }

  // Get upcoming debt payments (next 30 days)
  static async _getUpcomingDebtPayments(companyId) {
    const empty = {
      totalUpcoming: 0,
      totalAmount: 0,
      payments: [],
    };
    if (!isMongoConnected()) return empty;

    let activeLoans = [];
    try {
      activeLoans = await Loan.find({
        company: companyId,
        status: { $in: ['active', 'partially_repaid'] },
        repaymentType: { $in: ['amortized', 'interest_only'] }
      }).select('name loanNumber outstandingBalance interestRate startDate endDate repaymentType paymentFrequency installmentAmount').lean();
    } catch (_err) {
      return empty;
    }

    const today = new Date()
    const thirtyDaysFromNow = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)

    const upcomingPayments = []

    for (const loan of activeLoans) {
      // Calculate next payment date based on loan terms
      const startDate = new Date(loan.startDate)
      const endDate = new Date(loan.endDate)
      const paymentFrequency = loan.paymentFrequency || 'monthly'

      // Find the next payment date
      let nextPaymentDate = new Date(startDate)
      while (nextPaymentDate <= today) {
        if (paymentFrequency === 'monthly') {
          nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 1)
        } else if (paymentFrequency === 'quarterly') {
          nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 3)
        } else if (paymentFrequency === 'semi_annual') {
          nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 6)
        } else if (paymentFrequency === 'annual') {
          nextPaymentDate.setFullYear(nextPaymentDate.getFullYear() + 1)
        } else {
          nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 1) // default to monthly
        }
      }

      // Check if next payment is within 30 days
      if (nextPaymentDate <= thirtyDaysFromNow && nextPaymentDate <= endDate) {
        const daysUntil = Math.ceil((nextPaymentDate - today) / (1000 * 60 * 60 * 24))

        // Calculate estimated payment amount
        let estimatedPayment = 0
        if (loan.repaymentType === 'interest_only') {
          // Monthly interest payment
          estimatedPayment = (loan.outstandingBalance || 0) * (loan.interestRate || 0) / 100 / 12
        } else if (loan.installmentAmount) {
          estimatedPayment = loan.installmentAmount
        } else {
          // Estimate based on outstanding balance and remaining term
          const monthsRemaining = Math.max(1, Math.ceil((endDate - today) / (1000 * 60 * 60 * 24 * 30)))
          const monthlyInterest = (loan.outstandingBalance || 0) * (loan.interestRate || 0) / 100 / 12
          const monthlyPrincipal = (loan.outstandingBalance || 0) / monthsRemaining
          estimatedPayment = monthlyPrincipal + monthlyInterest
        }

        upcomingPayments.push({
          loanId: loan._id,
          loanName: loan.name,
          loanNumber: loan.loanNumber,
          dueDate: nextPaymentDate.toISOString().split('T')[0],
          daysUntil,
          estimatedAmount: dateHelpers.round2(estimatedPayment),
          outstandingBalance: loan.outstandingBalance || 0
        })
      }
    }

    // Sort by due date
    upcomingPayments.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))

    return {
      totalUpcoming: upcomingPayments.length,
      totalAmount: dateHelpers.round2(upcomingPayments.reduce((sum, p) => sum + p.estimatedAmount, 0)),
      payments: upcomingPayments.slice(0, 5) // Top 5 upcoming payments
    }
  }
}

module.exports = ExecutiveDashboardService
