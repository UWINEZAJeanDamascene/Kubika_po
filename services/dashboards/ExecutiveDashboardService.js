const mongoose = require('mongoose')
const { aggregateWithTimeout } = require('../../utils/mongoAggregation')
const JournalEntry = require('../../models/JournalEntry')
const BankAccount = require('../../models/BankAccount')
const Invoice = require('../../models/Invoice')
const Company = require('../../models/Company')
const Loan = require('../../models/Loan')
const { PettyCashFloat } = require('../../models/PettyCash')
const dateHelpers = require('../../utils/dateHelpers')
const dashboardCache = require('../DashboardCacheService')
const journalAgg = require('../journalAggregationService')
const { isMongoConnected } = require('../../utils/mongoConnection')

class ExecutiveDashboardService {

  static async get(companyId) {
    const cached = await dashboardCache.get(companyId, 'executive')
    if (cached) return cached

    const company = await Company.findById(companyId).lean()
    if (!company) {
      throw new Error('Company not found')
    }

    const currentFY = dateHelpers.currentFiscalYear(company.fiscal_year_start_month || 1)
    const thisMonth = dateHelpers.currentMonth()
    const lastMonth = dateHelpers.previousMonth()

    const codeToType = await journalAgg.loadChartTypeMap(companyId)
    const thisMonthRange = journalAgg.withDateMargin(thisMonth.start, thisMonth.end)
    const lastMonthRange = journalAgg.withDateMargin(lastMonth.start, lastMonth.end)
    const fyRange = journalAgg.withDateMargin(currentFY.start, currentFY.end)

    // Three SQL aggregations replace six full journal scans.
    const [
      thisMonthLines,
      lastMonthLines,
      fyLines,
      cashBalance,
      outstandingAR,
      overdueAR,
      recentTransactions,
      upcomingDebtPayments
    ] = await Promise.all([
      journalAgg.sumLinesByAccountCode(companyId, thisMonthRange),
      journalAgg.sumLinesByAccountCode(companyId, lastMonthRange),
      journalAgg.sumLinesByAccountCode(companyId, fyRange),
      ExecutiveDashboardService._getTotalCashBalance(companyId),
      ExecutiveDashboardService._getOutstandingAR(companyId),
      ExecutiveDashboardService._getOverdueAR(companyId),
      ExecutiveDashboardService._getRecentJournalEntries(companyId, 5),
      ExecutiveDashboardService._getUpcomingDebtPayments(companyId)
    ])

    const revenueThisMonth = journalAgg.totalForAccountType(thisMonthLines, codeToType, 'revenue')
    const revenueFYTD = journalAgg.totalForAccountType(fyLines, codeToType, 'revenue')
    const revenuePrevMonth = journalAgg.totalForAccountType(lastMonthLines, codeToType, 'revenue')
    const expensesThisMonth = journalAgg.totalForAccountType(thisMonthLines, codeToType, 'expense')
    const expensesFYTD = journalAgg.totalForAccountType(fyLines, codeToType, 'expense')
    const expensesPrevMonth = journalAgg.totalForAccountType(lastMonthLines, codeToType, 'expense')

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

     await dashboardCache.set(companyId, 'executive', result)
    return result
  }

  // -- PRIVATE HELPERS --

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

    if (!cashAccountCodes.includes('1000')) cashAccountCodes.push('1000')

    if (cashAccountCodes.length === 0) return 0

    const rows = await journalAgg.sumLinesByAccountCode(companyId, {
      accountCodes: cashAccountCodes,
      excludeSourceType: 'opening_balance',
    })

    const journalBalance = rows.reduce(
      (sum, row) => sum + (Number(row.totalDebit) || 0) - (Number(row.totalCredit) || 0),
      0,
    )

    const bankOpeningTotal = banks.reduce((s, b) => {
      const val = b.openingBalance
      return s + (val ? parseFloat(val.toString()) : 0)
    }, 0)
    const pettyCashOpeningTotal = pettyCash.reduce((s, p) => s + (p.openingBalance || 0), 0)

    if (rows.length === 0 && (bankOpeningTotal + pettyCashOpeningTotal) > 0) {
      return bankOpeningTotal + pettyCashOpeningTotal
    }

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
