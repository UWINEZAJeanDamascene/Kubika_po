const dateHelpers = require('../../utils/dateHelpers')
const dashboardCache = require('../DashboardCacheService')
const journalAgg = require('../journalAggregationService')

class PeriodComparisonService {
  static async get(companyId) {
    const cached = await dashboardCache.get(companyId, 'period_comparison')
    if (cached) return cached

    const thisMonth = dateHelpers.currentMonth()
    const lastMonth = dateHelpers.previousMonth()
    const sameMonthLastY = dateHelpers.sameMonthLastYear()

    const [current, previous, lastYear] = await Promise.all([
      PeriodComparisonService._getPeriodMetrics(companyId, thisMonth.start, thisMonth.end),
      PeriodComparisonService._getPeriodMetrics(companyId, lastMonth.start, lastMonth.end),
      PeriodComparisonService._getPeriodMetrics(companyId, sameMonthLastY.start, sameMonthLastY.end)
    ])

    const result = {
      company_id: companyId,
      generated_at: new Date(),
      periods: {
        current: {
          label: 'This Month',
          start: thisMonth.start,
          end: thisMonth.end,
          metrics: current
        },
        previous: {
          label: 'Last Month',
          start: lastMonth.start,
          end: lastMonth.end,
          metrics: previous
        },
        same_month_last_year: {
          label: 'Same Month Last Year',
          start: sameMonthLastY.start,
          end: sameMonthLastY.end,
          metrics: lastYear
        }
      },
      changes: {
        revenue_vs_last_month: dateHelpers.percentageChange(current.revenue, previous.revenue),
        revenue_vs_last_year: dateHelpers.percentageChange(current.revenue, lastYear.revenue),
        expenses_vs_last_month: dateHelpers.percentageChange(current.expenses, previous.expenses),
        expenses_vs_last_year: dateHelpers.percentageChange(current.expenses, lastYear.expenses),
        net_profit_vs_last_month: dateHelpers.percentageChange(current.net_profit, previous.net_profit),
        net_profit_vs_last_year: dateHelpers.percentageChange(current.net_profit, lastYear.net_profit)
      }
    }

    await dashboardCache.set(companyId, 'period_comparison', result)
    return result
  }

  static async _getPeriodMetrics(companyId, dateFrom, dateTo) {
    const codeToType = await journalAgg.loadChartTypeMap(companyId)
    const range = journalAgg.withDateMargin(dateFrom, dateTo)
    const lines = await journalAgg.sumLinesByAccountCode(companyId, range)
    const revenue = journalAgg.totalForAccountType(lines, codeToType, 'revenue')
    const expenses = journalAgg.totalForAccountTypes(lines, codeToType, ['expense', 'cogs'])
    const netProfit = dateHelpers.round2(revenue - expenses)
    return {
      revenue: dateHelpers.round2(revenue),
      expenses: dateHelpers.round2(expenses),
      net_profit: netProfit,
      is_profit: netProfit >= 0
    }
  }
}

module.exports = PeriodComparisonService
