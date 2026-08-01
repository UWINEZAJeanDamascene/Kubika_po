const { prisma } = require('../../lib/prisma')
const { toIdString } = require('../../utils/objectId')
const { decimalToNumber } = require('../../utils/decimalHelpers')
const dateHelpers = require('../../utils/dateHelpers')
const dashboardCache = require('../DashboardCacheService')

/** PO statuses considered “open” for pipeline / summary */
const OPEN_PO_STATUSES = ['draft', 'approved']

/** Default limit for top suppliers block */
const TOP_SUPPLIERS_LIMIT = 5

/** All PO statuses in display order (stable list for UIs) */
const PO_STATUS_ORDER = [
  'draft',
  'approved',
  'partially_received',
  'fully_received',
  'cancelled'
]

const MARGIN_MS = 24 * 60 * 60 * 1000

class PurchaseDashboardService {
  static async get(companyId) {
    const cached = await dashboardCache.get(companyId, 'purchase')
    if (cached) return cached

    const thisMonth = dateHelpers.currentMonth()

    const [poSummary, grnPending, apBundle, topSuppliers, posByStatus, purchaseReturns] = await Promise.all([
      PurchaseDashboardService._getPOSummary(companyId, thisMonth),
      PurchaseDashboardService._getGRNPending(companyId),
      PurchaseDashboardService._getAPSummaryAndAging(companyId),
      PurchaseDashboardService._getTopSuppliers(companyId, TOP_SUPPLIERS_LIMIT),
      PurchaseDashboardService._getPOsByStatus(companyId),
      PurchaseDashboardService._getPurchaseReturnsSummary(companyId)
    ])

    const { apSummary, apAging } = apBundle

    const result = {
      company_id: companyId,
      generated_at: new Date(),
      date_context: {
        current_month_start: thisMonth.start,
        current_month_end: thisMonth.end
      },
      summary: {
        po_count_mtd: poSummary.po_count,
        po_open_value: poSummary.open_value,
        grn_pending_count: grnPending.count,
        grn_pending_balance: grnPending.total_balance_outstanding,
        ap_total_outstanding: apSummary.total_outstanding,
        ap_overdue_amount: apSummary.overdue_amount
      },
      purchase_orders: poSummary,
      grn_pending: grnPending,
      accounts_payable: apSummary,
      ap_aging: apAging,
      top_suppliers: topSuppliers,
      by_status: posByStatus.map,
      by_status_list: posByStatus.list,
      purchase_returns: purchaseReturns
    }

    await dashboardCache.set(companyId, 'purchase', result)
    return result
  }

  /**
   * Month-to-date PO stats; orderDate uses ±24h margin vs UTC month bounds (journal-style).
   * One SQL scan with FILTER-based conditional sums instead of pulling every PO row.
   */
  static async _getPOSummary(companyId, period) {
    const cid = toIdString(companyId)
    const qStart = new Date(period.start.getTime() - MARGIN_MS)
    const qEnd = new Date(period.end.getTime() + MARGIN_MS)

    const rows = await prisma.$queryRaw`
      SELECT
        COUNT(*)::int AS "poCount",
        COALESCE(SUM(total_amount), 0)::float AS "totalValue",
        COUNT(*) FILTER (WHERE status = ANY(${OPEN_PO_STATUSES}::text[]))::int AS "openCount",
        COALESCE(SUM(total_amount) FILTER (WHERE status = ANY(${OPEN_PO_STATUSES}::text[])), 0)::float AS "openValue"
      FROM purchase_orders
      WHERE company_id = ${cid}
        AND order_date >= ${qStart}
        AND order_date <= ${qEnd}
    `

    const s = rows[0] || {}
    return {
      po_count: s.poCount || 0,
      total_value: dateHelpers.round2(s.totalValue || 0),
      open_count: s.openCount || 0,
      open_value: dateHelpers.round2(s.openValue || 0)
    }
  }

  /**
   * Confirmed GRNs awaiting payment — includes both invoice (total) value and remaining balance.
   */
  static async _getGRNPending(companyId) {
    const cid = toIdString(companyId)

    const agg = await prisma.goodsReceivedNote.aggregate({
      where: {
        companyId: cid,
        status: 'confirmed',
        paymentStatus: { in: ['pending', 'partially_paid'] }
      },
      _count: true,
      _sum: { totalAmount: true, balance: true }
    })

    return {
      count: agg._count || 0,
      total_value: dateHelpers.round2(decimalToNumber(agg._sum.totalAmount)),
      total_balance_outstanding: dateHelpers.round2(decimalToNumber(agg._sum.balance))
    }
  }

  /**
   * Single SQL scan of unpaid GRNs for AP summary + aging buckets (fewer round-trips,
   * and the summing itself happens in Postgres instead of Node).
   */
  static async _getAPSummaryAndAging(companyId) {
    const cid = toIdString(companyId)
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)

    const rows = await prisma.$queryRaw`
      SELECT
        COUNT(*)::int AS count,
        COALESCE(SUM(balance), 0)::float AS "totalAp",
        COALESCE(SUM(balance) FILTER (
          WHERE payment_due_date IS NOT NULL AND payment_due_date < ${today}
        ), 0)::float AS "overdueAmount",
        COUNT(*) FILTER (
          WHERE payment_due_date IS NOT NULL AND payment_due_date < ${today}
        )::int AS "overdueCount",
        COALESCE(SUM(balance) FILTER (
          WHERE payment_due_date IS NULL OR payment_due_date >= ${today}
        ), 0)::float AS "notDue",
        COALESCE(SUM(balance) FILTER (
          WHERE payment_due_date < ${today}
            AND FLOOR(EXTRACT(EPOCH FROM (${today} - payment_due_date)) / 86400) BETWEEN 1 AND 30
        ), 0)::float AS "days1To30",
        COALESCE(SUM(balance) FILTER (
          WHERE payment_due_date < ${today}
            AND FLOOR(EXTRACT(EPOCH FROM (${today} - payment_due_date)) / 86400) BETWEEN 31 AND 60
        ), 0)::float AS "days31To60",
        COALESCE(SUM(balance) FILTER (
          WHERE payment_due_date < ${today}
            AND FLOOR(EXTRACT(EPOCH FROM (${today} - payment_due_date)) / 86400) BETWEEN 61 AND 90
        ), 0)::float AS "days61To90",
        COALESCE(SUM(balance) FILTER (
          WHERE payment_due_date < ${today}
            AND FLOOR(EXTRACT(EPOCH FROM (${today} - payment_due_date)) / 86400) > 90
        ), 0)::float AS "days90Plus",
        COALESCE(SUM(balance), 0)::float AS "totalOutstanding"
      FROM goods_received_notes
      WHERE company_id = ${cid}
        AND status = 'confirmed'
        AND payment_status <> 'paid'
    `

    const r = rows[0] || {}

    const apSummary = {
      total_outstanding: dateHelpers.round2(r.totalAp || 0),
      invoice_count: r.count || 0,
      overdue_amount: dateHelpers.round2(r.overdueAmount || 0),
      overdue_count: r.overdueCount || 0
    }

    const apAging = {
      not_due: dateHelpers.round2(r.notDue || 0),
      days_1_30: dateHelpers.round2(r.days1To30 || 0),
      days_31_60: dateHelpers.round2(r.days31To60 || 0),
      days_61_90: dateHelpers.round2(r.days61To90 || 0),
      days_90_plus: dateHelpers.round2(r.days90Plus || 0),
      total_outstanding: dateHelpers.round2(r.totalOutstanding || 0)
    }

    return { apSummary, apAging }
  }

  static async _getTopSuppliers(companyId, limit) {
    const cid = toIdString(companyId)

    // supplierId is a required column on goods_received_notes, so no null-check is needed here.
    const grouped = await prisma.goodsReceivedNote.groupBy({
      by: ['supplierId'],
      where: { companyId: cid, status: 'confirmed' },
      _sum: { totalAmount: true },
      _count: true,
      orderBy: { _sum: { totalAmount: 'desc' } },
      take: limit
    })

    if (grouped.length === 0) return []

    const suppliers = await prisma.supplier.findMany({
      where: { id: { in: grouped.map((g) => g.supplierId) } },
      select: { id: true, name: true, code: true }
    })
    const supplierById = new Map(suppliers.map((s) => [s.id, s]))

    return grouped.map((g) => {
      const supplier = supplierById.get(g.supplierId)
      return {
        supplier_id: g.supplierId,
        supplier_name: supplier ? supplier.name : null,
        supplier_code: (supplier && supplier.code) || '',
        total_value: dateHelpers.round2(decimalToNumber(g._sum.totalAmount)),
        grn_count: g._count
      }
    })
  }

  static async _getPOsByStatus(companyId) {
    const cid = toIdString(companyId)

    const grouped = await prisma.purchaseOrder.groupBy({
      by: ['status'],
      where: { companyId: cid },
      _count: true,
      _sum: { totalAmount: true }
    })

    const map = {}
    for (const row of grouped) {
      map[row.status] = {
        count: row._count,
        total_value: dateHelpers.round2(decimalToNumber(row._sum.totalAmount))
      }
    }

    const list = PO_STATUS_ORDER.map((status) => ({
      status,
      count: map[status] ? map[status].count : 0,
      total_value: map[status] ? map[status].total_value : 0
    }))

    return { map, list }
  }

  static async _getPurchaseReturnsSummary(companyId) {
    const cid = toIdString(companyId)

    const grouped = await prisma.purchaseReturn.groupBy({
      by: ['status'],
      where: { companyId: cid },
      _count: true,
      _sum: { totalAmount: true }
    })

    let totalCount = 0
    let totalAmount = 0
    let draftCount = 0
    let confirmedCount = 0

    for (const row of grouped) {
      totalCount += row._count
      totalAmount += decimalToNumber(row._sum.totalAmount)
      if (row.status === 'draft') draftCount = row._count
      if (row.status === 'confirmed') confirmedCount = row._count
    }

    return {
      total_count: totalCount,
      total_amount: dateHelpers.round2(totalAmount),
      draft_count: draftCount,
      confirmed_count: confirmedCount
    }
  }
}

module.exports = PurchaseDashboardService
