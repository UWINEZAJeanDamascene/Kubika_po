const mongoose = require('mongoose')
const { aggregateWithTimeout } = require('../../utils/mongoAggregation')
const BankAccount = require('../../models/BankAccount')
const Budget = require('../../models/Budget')
const BudgetLine = require('../../models/BudgetLine')
const JournalEntry = require('../../models/JournalEntry')
const ChartOfAccount = require('../../models/ChartOfAccount')
const GoodsReceivedNote = require('../../models/GoodsReceivedNote')
const { PettyCashFloat } = require('../../models/PettyCash')
const dateHelpers = require('../../utils/dateHelpers')
const dashboardCache = require('../DashboardCacheService')

/** Days ahead for GRN / AP “due soon” list — aligned with product default */
const UPCOMING_PAYMENT_DAYS = 14

class FinanceDashboardService {
  /**
   * Finance overview: bank balances, AP due, budget vs actual, VAT snapshot, cash movement (30d).
   * Cache invalidates with other dashboards when journals post (see journalService).
   */
  static async get(companyId) {
    const cached = await dashboardCache.get(companyId, 'finance')
    if (cached) return cached

    const thisMonth = dateHelpers.currentMonth()
    const cashFlowPeriod = dateHelpers.lastNDays(30)

    const [bankBalances, upcomingPayments, budgetVsActual, taxLiability, cashFlow30Days] =
      await Promise.all([
        FinanceDashboardService._getBankBalances(companyId),
        FinanceDashboardService._getUpcomingPayments(companyId, UPCOMING_PAYMENT_DAYS),
        FinanceDashboardService._getBudgetVsActual(companyId, thisMonth),
        FinanceDashboardService._getTaxLiability(companyId),
        FinanceDashboardService._getCashFlow30Days(companyId, cashFlowPeriod)
      ])

    const todayUtc = new Date()
    todayUtc.setUTCHours(0, 0, 0, 0)
    const upcomingDeadline = new Date(todayUtc)
    upcomingDeadline.setUTCDate(upcomingDeadline.getUTCDate() + UPCOMING_PAYMENT_DAYS)
    upcomingDeadline.setUTCHours(23, 59, 59, 999)

    const result = {
      company_id: companyId,
      generated_at: new Date(),
      date_context: {
        current_month_start: thisMonth.start,
        current_month_end: thisMonth.end,
        cash_flow_period_start: cashFlowPeriod.start,
        cash_flow_period_end: cashFlowPeriod.end,
        upcoming_payments_from: todayUtc,
        upcoming_payments_to: upcomingDeadline
      },
      summary: FinanceDashboardService._buildSummary({
        bankBalances,
        upcomingPayments,
        budgetVsActual,
        taxLiability,
        cashFlow30Days
      }),
      bank_balances: bankBalances,
      upcoming_payments: upcomingPayments,
      budget_vs_actual: budgetVsActual,
      tax_liability: taxLiability,
      cash_flow_30_days: cashFlow30Days
    }

     dashboardCache.set(companyId, 'finance', result)
    return result
  }

  static _buildSummary({ bankBalances, upcomingPayments, budgetVsActual, taxLiability, cashFlow30Days }) {
    return {
      total_bank_balance: bankBalances.total_balance,
      upcoming_ap_total: upcomingPayments.total,
      upcoming_ap_count: upcomingPayments.count,
      net_vat_payable: taxLiability.net_vat_payable,
      net_cash_flow_30d: cashFlow30Days.net,
      cash_inflows_30d: cashFlow30Days.inflows,
      cash_outflows_30d: cashFlow30Days.outflows,
      budget_has_data: budgetVsActual.has_budget === true && Array.isArray(budgetVsActual.lines),
      budget_over_budget: budgetVsActual.has_budget ? !!budgetVsActual.over_budget : null
    }
  }

  /**
   * Net balance (DR − CR) per account code for cash-style asset accounts.
   */
  static async _journalBalancesForAccountCodes(companyId, codes) {
    const unique = [...new Set(codes.filter(Boolean).map(String))]
    if (unique.length === 0) return {}

    const result = await aggregateWithTimeout(JournalEntry, [
      {
        $match: {
          company: new mongoose.Types.ObjectId(companyId),
          status: 'posted'
        }
      },
      { $unwind: '$lines' },
      {
        $match: {
          'lines.accountCode': { $in: unique }
        }
      },
      {
        $group: {
          _id: '$lines.accountCode',
          total_dr: { $sum: { $toDouble: { $ifNull: ['$lines.debit', 0] } } },
          total_cr: { $sum: { $toDouble: { $ifNull: ['$lines.credit', 0] } } }
        }
      }
    ], 'dashboard')

    const map = {}
    for (const row of result) {
      map[row._id] = (row.total_dr || 0) - (row.total_cr || 0)
    }
    return map
  }

  static async _getBankBalances(companyId) {
    const banks = await BankAccount.find({
      company: companyId,
      isActive: true
    })
      .sort({ isDefault: -1, name: 1 })
      .lean()

    const codes = banks.map((b) => (b.ledgerAccountId ? String(b.ledgerAccountId) : null))
    const balanceByCode = await FinanceDashboardService._journalBalancesForAccountCodes(companyId, codes)

    const accounts = banks.map((bank) => {
      const code = bank.ledgerAccountId ? String(bank.ledgerAccountId) : null
      const journalBalance = code ? (balanceByCode[code] || 0) : 0
      const opening = bank.openingBalance ? parseFloat(bank.openingBalance.toString()) : 0
      const currentBalance = dateHelpers.round2(opening + journalBalance)

      return {
        bank_account_id: bank._id,
        bank_name: bank.name,
        account_number: bank.accountNumber || null,
        currency: bank.currencyCode || 'USD',
        current_balance: currentBalance,
        opening_balance: dateHelpers.round2(opening),
        is_default: !!bank.isDefault
      }
    })

    const totalBalance = dateHelpers.round2(accounts.reduce((s, b) => s + b.current_balance, 0))

    return {
      accounts,
      total_balance: totalBalance
    }
  }

  static async _getUpcomingPayments(companyId, daysAhead) {
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    const deadline = new Date(today)
    deadline.setUTCDate(deadline.getUTCDate() + daysAhead)
    deadline.setUTCHours(23, 59, 59, 999)

    const upcomingAP = await GoodsReceivedNote.find({
      company: companyId,
      status: 'confirmed',
      paymentStatus: { $ne: 'paid' },
      paymentDueDate: { $gte: today, $lte: deadline }
    })
      .populate('supplier', 'name')
      .select('referenceNo supplier totalAmount balance paymentDueDate')
      .sort({ paymentDueDate: 1 })
      .lean()

    const parseAmt = (v) => {
      if (v == null) return 0
      if (typeof v === 'object' && v.toString) return parseFloat(v.toString())
      return Number(v) || 0
    }

    return {
      days_ahead: daysAhead,
      count: upcomingAP.length,
      total: dateHelpers.round2(
        upcomingAP.reduce((s, p) => s + parseAmt(p.balance), 0)
      ),
      items: upcomingAP.map((p) => {
        const due = p.paymentDueDate ? new Date(p.paymentDueDate) : today
        const daysUntil = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
        const supplierDoc = p.supplier
        const partyName =
          supplierDoc && typeof supplierDoc === 'object' && supplierDoc.name
            ? supplierDoc.name
            : 'Unknown'
        return {
          type: 'ap_payment',
          reference: p.referenceNo,
          party_name: partyName,
          amount: dateHelpers.round2(parseAmt(p.balance)),
          due_date: p.paymentDueDate,
          days_until_due: daysUntil
        }
      })
    }
  }

  static async _getBudgetVsActual(companyId, period) {
    const fy = new Date().getUTCFullYear()
    const budget = await Budget.findOne({
      company_id: companyId,
      status: { $in: ['approved', 'locked'] },
      fiscal_year: fy
    }).lean()

    if (!budget) {
      return { has_budget: false, message: 'No approved budget for current fiscal year' }
    }

    const currentMonth = new Date().getUTCMonth() + 1
    const currentYear = new Date().getUTCFullYear()

    const budgetLines = await BudgetLine.find({
      company_id: companyId,
      budget_id: budget._id,
      period_month: currentMonth,
      period_year: currentYear
    }).lean()

    if (budgetLines.length === 0) {
      return { has_budget: true, message: 'No budget lines for current month' }
    }

    const accountIds = budgetLines.map((l) => l.account_id)
    const charts = await ChartOfAccount.find({ _id: { $in: accountIds } })
      .select('code')
      .lean()
    const idToCode = new Map(charts.map((c) => [c._id.toString(), c.code]))

    const codes = [...new Set(budgetLines.map((bl) => idToCode.get(bl.account_id.toString())).filter(Boolean))]
    if (codes.length === 0) {
      return {
        has_budget: true,
        message: 'No chart accounts for budget lines',
        budget_id: budget._id,
        budget_name: budget.name
      }
    }

    const marginMs = 24 * 60 * 60 * 1000
    const qFrom = new Date(period.start.getTime() - marginMs)
    const qTo = new Date(period.end.getTime() + marginMs)

    const agg = await aggregateWithTimeout(JournalEntry, [
      {
        $match: {
          company: new mongoose.Types.ObjectId(companyId),
          status: 'posted',
          date: { $gte: qFrom, $lte: qTo }
        }
      },
      { $unwind: '$lines' },
      {
        $match: {
          'lines.accountCode': { $in: codes }
        }
      },
      {
        $group: {
          _id: '$lines.accountCode',
          total_dr: { $sum: { $toDouble: { $ifNull: ['$lines.debit', 0] } } },
          total_cr: { $sum: { $toDouble: { $ifNull: ['$lines.credit', 0] } } }
        }
      }
    ], 'dashboard')

    const actualByCode = {}
    for (const row of agg) {
      actualByCode[row._id] = row
    }

    const lines = budgetLines.map((bl) => {
      const code = idToCode.get(bl.account_id.toString())
      const actual = code ? actualByCode[code] : null
      const actualDr = actual ? actual.total_dr || 0 : 0
      const actualCr = actual ? actual.total_cr || 0 : 0
      const actualAmt = dateHelpers.round2(actualDr - actualCr)
      const bud = bl.budgeted_amount ? parseFloat(bl.budgeted_amount.toString()) : 0
      const variance = dateHelpers.round2(bud - actualAmt)
      const variancePct = dateHelpers.round2(dateHelpers.safeDivide(variance, bud) * 100)

      return {
        account_id: bl.account_id,
        budgeted_amount: dateHelpers.round2(bud),
        actual_amount: actualAmt,
        variance,
        variance_pct: variancePct,
        status: variance >= 0 ? 'under_budget' : 'over_budget'
      }
    })

    const totalBudgeted = dateHelpers.round2(lines.reduce((s, l) => s + l.budgeted_amount, 0))
    const totalActual = dateHelpers.round2(lines.reduce((s, l) => s + l.actual_amount, 0))
    const totalVariance = dateHelpers.round2(totalBudgeted - totalActual)

    return {
      has_budget: true,
      budget_id: budget._id,
      budget_name: budget.name,
      period_month: currentMonth,
      period_year: currentYear,
      total_budgeted: totalBudgeted,
      total_actual: totalActual,
      total_variance: totalVariance,
      over_budget: totalVariance < 0,
      lines
    }
  }

  static async _getTaxLiability(companyId) {
    const taxAccounts = await ChartOfAccount.find({
      company: companyId,
      subtype: 'tax',
      isActive: true
    }).lean()

    if (taxAccounts.length === 0) {
      return { output_vat: 0, input_vat: 0, net_vat_payable: 0, tax_accounts_configured: 0 }
    }

    const codes = taxAccounts.map((a) => a.code).filter(Boolean)
    const agg = await aggregateWithTimeout(JournalEntry, [
      {
        $match: {
          company: new mongoose.Types.ObjectId(companyId),
          status: 'posted'
        }
      },
      { $unwind: '$lines' },
      {
        $match: {
          'lines.accountCode': { $in: codes }
        }
      },
      {
        $group: {
          _id: '$lines.accountCode',
          total_dr: { $sum: { $toDouble: { $ifNull: ['$lines.debit', 0] } } },
          total_cr: { $sum: { $toDouble: { $ifNull: ['$lines.credit', 0] } } }
        }
      }
    ], 'dashboard')

    let outputVat = 0
    let inputVat = 0

    for (const row of agg) {
      const account = taxAccounts.find((a) => a.code === row._id)
      if (!account) continue
      outputVat += row.total_cr || 0
      inputVat += row.total_dr || 0
    }

    return {
      output_vat: dateHelpers.round2(outputVat),
      input_vat: dateHelpers.round2(inputVat),
      net_vat_payable: dateHelpers.round2(outputVat - inputVat),
      tax_accounts_configured: taxAccounts.length
    }
  }

  static async _getCashFlow30Days(companyId, period) {
    const OPERATING_INFLOW_TYPES = ['ar_receipt']
    const OPERATING_OUTFLOW_TYPES = [
      'ap_payment',
      'expense',
      'petty_cash_expense',
      'payroll_run',
      'tax_settlement'
    ]

    const [banks, petty] = await Promise.all([
      BankAccount.find({ company: companyId, isActive: true }).select('ledgerAccountId').lean(),
      PettyCashFloat.find({ company: companyId, isActive: true }).select('ledgerAccountId').lean()
    ])

    const cashCodes = [
      ...new Set(
        [...banks, ...petty]
          .map((a) => a.ledgerAccountId)
          .filter(Boolean)
          .map(String)
      )
    ]

    if (cashCodes.length === 0) {
      return {
        period_days: 30,
        period_start: period.start,
        period_end: period.end,
        inflows: 0,
        outflows: 0,
        net: 0,
        by_source: []
      }
    }

    const marginMs = 24 * 60 * 60 * 1000
    const qFrom = new Date(period.start.getTime() - marginMs)
    const qTo = new Date(period.end.getTime() + marginMs)

    const rows = await aggregateWithTimeout(JournalEntry, [
      {
        $match: {
          company: new mongoose.Types.ObjectId(companyId),
          status: 'posted',
          date: { $gte: qFrom, $lte: qTo }
        }
      },
      { $unwind: '$lines' },
      {
        $match: {
          'lines.accountCode': { $in: cashCodes }
        }
      },
      {
        $group: {
          _id: '$sourceType',
          cash_in: { $sum: { $toDouble: { $ifNull: ['$lines.debit', 0] } } },
          cash_out: { $sum: { $toDouble: { $ifNull: ['$lines.credit', 0] } } }
        }
      }
    ], 'dashboard')

    let totalInflows = 0
    let totalOutflows = 0
    const bySource = []

    for (const row of rows) {
      const st = row._id
      const cin = row.cash_in || 0
      const cout = row.cash_out || 0
      if (OPERATING_INFLOW_TYPES.includes(st)) {
        totalInflows += cin
      } else if (OPERATING_OUTFLOW_TYPES.includes(st)) {
        totalOutflows += cout
      }
      if ((cin || cout) && st) {
        bySource.push({
          source_type: st || 'unknown',
          cash_debit: dateHelpers.round2(cin),
          cash_credit: dateHelpers.round2(cout)
        })
      }
    }

    bySource.sort((a, b) => (a.source_type || '').localeCompare(b.source_type || ''))

    return {
      period_days: 30,
      period_start: period.start,
      period_end: period.end,
      inflows: dateHelpers.round2(totalInflows),
      outflows: dateHelpers.round2(totalOutflows),
      net: dateHelpers.round2(totalInflows - totalOutflows),
      by_source: bySource
    }
  }
}

module.exports = FinanceDashboardService
