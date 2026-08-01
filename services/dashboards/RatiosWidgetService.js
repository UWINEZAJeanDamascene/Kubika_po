const FinancialRatiosService = require('../financialRatiosService')
const Company = require('../../models/Company')
const dateHelpers = require('../../utils/dateHelpers')
const dashboardCache = require('../DashboardCacheService')

class RatiosWidgetService {
  static async get(companyId) {
    const cached = await dashboardCache.get(companyId, 'ratios')
    if (cached) return cached

    const company = await Company.findById(companyId).lean()
    if (!company) {
      throw new Error('Company not found')
    }

    const today = new Date().toISOString().split('T')[0]
    const fyStartMonth = company.fiscal_year_start_month || 1
    const currentFY = dateHelpers.currentFiscalYear(fyStartMonth)
    const dateFrom = currentFY.start.toISOString().split('T')[0]

    const ratiosResult = await FinancialRatiosService.compute(companyId, {
      asOfDate: today,
      dateFrom,
      dateTo: today
    })

    const statusConfig = {
      good: { color: '#1D9E75', label: 'Good', icon: 'up' },
      warning: { color: '#EF9F27', label: 'Watch', icon: 'neutral' },
      danger: { color: '#E24B4A', label: 'Danger', icon: 'down' },
      neutral: { color: '#888780', label: 'N/A', icon: 'neutral' }
    }

    // ratiosResult.ratios is grouped by category (liquidity/profitability/
    // efficiency/leverage), each holding a `ratios` map of individual ratios.
    // Flatten to one list for the widget; each ratio already carries its own
    // label/formula from FinancialRatiosService, so _getLabel() is only a
    // fallback.
    const formattedRatios = []
    for (const [categoryKey, category] of Object.entries(ratiosResult.ratios || {})) {
      for (const [key, ratio] of Object.entries(category?.ratios || {})) {
        formattedRatios.push({
          key,
          category: categoryKey,
          label: ratio.label || RatiosWidgetService._getLabel(key),
          value: ratio.value,
          formula: ratio.formula,
          status: ratio.status,
          status_color: statusConfig[ratio.status]?.color || statusConfig.neutral.color,
          status_label: statusConfig[ratio.status]?.label || 'N/A',
          inputs: ratio.inputs
        })
      }
    }

    const result = {
      company_id: companyId,
      generated_at: new Date(),
      as_of_date: today,
      date_from: dateFrom,
      ratios: formattedRatios,
      summary: {
        good_count: formattedRatios.filter((r) => r.status === 'good').length,
        warning_count: formattedRatios.filter((r) => r.status === 'warning').length,
        danger_count: formattedRatios.filter((r) => r.status === 'danger').length,
        neutral_count: formattedRatios.filter((r) => r.status === 'neutral').length
      }
    }

    await dashboardCache.set(companyId, 'ratios', result, '', 5 * 60 * 1000)
    return result
  }

  static _getLabel(key) {
    const labels = {
      current_ratio: 'Current Ratio',
      quick_ratio: 'Quick Ratio',
      gross_margin_pct: 'Gross Margin',
      inventory_turnover: 'Inventory Turnover',
      days_inventory_outstanding: 'Days Inventory (DIO)',
      ap_turnover: 'AP Turnover',
      return_on_assets: 'Return on Assets',
      debt_to_equity: 'Debt to Equity',
      net_profit_margin_pct: 'Net Profit Margin'
    }
    return labels[key] || key
  }
}

module.exports = RatiosWidgetService
