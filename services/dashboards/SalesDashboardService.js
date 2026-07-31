const mongoose = require('mongoose')
const { aggregateWithTimeout } = require('../../utils/mongoAggregation')
const Invoice = require('../../models/Invoice')
const CreditNote = require('../../models/CreditNote')
const dateHelpers = require('../../utils/dateHelpers')
const dashboardCache = require('../DashboardCacheService')

const TOP_CLIENTS_LIMIT = 5

const MS_PER_DAY = 1000 * 60 * 60 * 24

/** Invoice statuses for AR aging (open balances) */
const AR_OPEN_STATUSES = ['confirmed', 'partially_paid']

/** Issued / billable invoices (exclude drafts from headline KPIs) */
const NON_DRAFT_STATUSES = ['confirmed', 'partially_paid', 'fully_paid', 'cancelled']

const INVOICE_STATUS_ORDER = [
  'draft',
  'confirmed',
  'partially_paid',
  'fully_paid',
  'cancelled'
]

class SalesDashboardService {
  static async get(companyId) {
    const cached = await dashboardCache.get(companyId, 'sales')
    if (cached) return cached

    const thisMonth = dateHelpers.currentMonth()

    const [
      invoicesSummary,
      arAgingBuckets,
      topClientsByRevenue,
      invoicesByStatus,
      creditNotesSummary,
      collectionRate
    ] = await Promise.all([
      SalesDashboardService._getInvoicesSummary(companyId, thisMonth),
      SalesDashboardService._getARAgingBuckets(companyId),
      SalesDashboardService._getTopClients(companyId, TOP_CLIENTS_LIMIT),
      SalesDashboardService._getInvoicesByStatus(companyId),
      SalesDashboardService._getCreditNotesSummary(companyId, thisMonth),
      SalesDashboardService._getCollectionRate(companyId, thisMonth)
    ])

    const result = {
      company_id: companyId,
      generated_at: new Date(),
      date_context: {
        current_month_start: thisMonth.start,
        current_month_end: thisMonth.end
      },
      summary: {
        invoices_raised_mtd: invoicesSummary.invoices_raised,
        total_invoiced_mtd: invoicesSummary.total_invoiced,
        total_outstanding_ar: arAgingBuckets.total_ar_outstanding,
        collection_rate_pct: collectionRate.collection_rate_pct,
        credit_notes_mtd: creditNotesSummary.count
      },
      invoices: invoicesSummary,
      ar_aging: arAgingBuckets,
      top_clients: topClientsByRevenue,
      by_status: invoicesByStatus.map,
      by_status_list: invoicesByStatus.list,
      credit_notes: creditNotesSummary,
      collection_rate: collectionRate
    }

    await dashboardCache.set(companyId, 'sales', result)
    return result
  }

  /**
   * MTD invoice KPIs — excludes **draft** from counts and amounts (not yet issued).
   */
  static async _getInvoicesSummary(companyId, period) {
    const companyOid = new mongoose.Types.ObjectId(companyId)
    const marginMs = 24 * 60 * 60 * 1000
    const qStart = new Date(period.start.getTime() - marginMs)
    const qEnd = new Date(period.end.getTime() + marginMs)

    const result = await aggregateWithTimeout(Invoice, [
      {
        $match: {
          company: companyOid,
          invoiceDate: { $gte: qStart, $lte: qEnd },
          status: { $ne: 'draft' }
        }
      },
      {
        $group: {
          _id: null,
          invoices_raised: { $sum: 1 },
          total_invoiced: { $sum: { $toDouble: { $ifNull: ['$totalAmount', 0] } } },
          total_collected: { $sum: { $toDouble: { $ifNull: ['$amountPaid', 0] } } },
          total_outstanding: { $sum: { $toDouble: { $ifNull: ['$amountOutstanding', 0] } } }
        }
      }
    ], 'dashboard')

    const s = result[0] || {}
    return {
      invoices_raised: s.invoices_raised || 0,
      total_invoiced: dateHelpers.round2(s.total_invoiced || 0),
      total_collected: dateHelpers.round2(s.total_collected || 0),
      total_outstanding: dateHelpers.round2(s.total_outstanding || 0)
    }
  }

  static async _getARAgingBuckets(companyId) {
    const companyOid = new mongoose.Types.ObjectId(companyId)
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)

    const result = await aggregateWithTimeout(Invoice, [
      {
        $match: {
          company: companyOid,
          status: { $in: AR_OPEN_STATUSES }
        }
      },
      {
        $addFields: {
          outstanding: { $toDouble: { $ifNull: ['$amountOutstanding', 0] } },
          days_overdue: {
            $cond: {
              if: { $lt: ['$dueDate', today] },
              then: {
                $toInt: {
                  $divide: [{ $subtract: [today, '$dueDate'] }, MS_PER_DAY]
                }
              },
              else: 0
            }
          }
        }
      },
      {
        $group: {
          _id: null,
          not_due: {
            $sum: {
              $cond: [{ $gte: ['$dueDate', today] }, '$outstanding', 0]
            }
          },
          days_1_30: {
            $sum: {
              $cond: [
                {
                  $and: [{ $gte: ['$days_overdue', 1] }, { $lte: ['$days_overdue', 30] }]
                },
                '$outstanding',
                0
              ]
            }
          },
          days_31_60: {
            $sum: {
              $cond: [
                {
                  $and: [{ $gte: ['$days_overdue', 31] }, { $lte: ['$days_overdue', 60] }]
                },
                '$outstanding',
                0
              ]
            }
          },
          days_61_90: {
            $sum: {
              $cond: [
                {
                  $and: [{ $gte: ['$days_overdue', 61] }, { $lte: ['$days_overdue', 90] }]
                },
                '$outstanding',
                0
              ]
            }
          },
          days_90_plus: {
            $sum: {
              $cond: [{ $gt: ['$days_overdue', 90] }, '$outstanding', 0]
            }
          },
          total_overdue: {
            $sum: {
              $cond: [{ $gt: ['$days_overdue', 0] }, '$outstanding', 0]
            }
          },
          total_ar_outstanding: { $sum: '$outstanding' }
        }
      }
    ], 'dashboard')

    const b = result[0] || {}
    return {
      not_due: dateHelpers.round2(b.not_due || 0),
      days_1_30: dateHelpers.round2(b.days_1_30 || 0),
      days_31_60: dateHelpers.round2(b.days_31_60 || 0),
      days_61_90: dateHelpers.round2(b.days_61_90 || 0),
      days_90_plus: dateHelpers.round2(b.days_90_plus || 0),
      total_overdue: dateHelpers.round2(b.total_overdue || 0),
      total_ar_outstanding: dateHelpers.round2(b.total_ar_outstanding || 0)
    }
  }

  static async _getTopClients(companyId, limit) {
    const companyOid = new mongoose.Types.ObjectId(companyId)

    return aggregateWithTimeout(Invoice, [
      {
        $match: {
          company: companyOid,
          status: { $nin: ['draft', 'cancelled'] }
        }
      },
      {
        $group: {
          _id: '$client',
          total_invoiced: { $sum: { $toDouble: { $ifNull: ['$totalAmount', 0] } } },
          total_paid: { $sum: { $toDouble: { $ifNull: ['$amountPaid', 0] } } },
          invoice_count: { $sum: 1 }
        }
      },
      { $sort: { total_invoiced: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'clients',
          localField: '_id',
          foreignField: '_id',
          as: 'client'
        }
      },
      { $unwind: '$client' },
      {
        $project: {
          client_id: '$_id',
          client_name: '$client.name',
          client_code: { $ifNull: ['$client.code', ''] },
          total_invoiced: { $round: ['$total_invoiced', 2] },
          total_paid: { $round: ['$total_paid', 2] },
          outstanding: {
            $round: [
              {
                $subtract: ['$total_invoiced', '$total_paid']
              },
              2
            ]
          },
          invoice_count: 1
        }
      }
    ], 'dashboard')
  }

  static async _getInvoicesByStatus(companyId) {
    const companyOid = new mongoose.Types.ObjectId(companyId)

    const result = await aggregateWithTimeout(Invoice, [
      {
        $match: { company: companyOid }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          total_amount: { $sum: { $toDouble: { $ifNull: ['$totalAmount', 0] } } }
        }
      }
    ], 'dashboard')

    const map = {}
    for (const row of result) {
      map[row._id] = {
        count: row.count,
        total_amount: dateHelpers.round2(row.total_amount || 0)
      }
    }

    const list = INVOICE_STATUS_ORDER.map((status) => ({
      status,
      count: map[status] ? map[status].count : 0,
      total_amount: map[status] ? map[status].total_amount : 0
    }))

    return { map, list }
  }

  static async _getCreditNotesSummary(companyId, period) {
    const companyOid = new mongoose.Types.ObjectId(companyId)
    const marginMs = 24 * 60 * 60 * 1000
    const qStart = new Date(period.start.getTime() - marginMs)
    const qEnd = new Date(period.end.getTime() + marginMs)

    const result = await aggregateWithTimeout(CreditNote, [
      {
        $match: {
          company: companyOid,
          creditDate: { $gte: qStart, $lte: qEnd },
          status: 'confirmed'
        }
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          total_value: { $sum: { $toDouble: { $ifNull: ['$totalAmount', 0] } } }
        }
      }
    ], 'dashboard')

    return {
      count: result[0]?.count || 0,
      total_value: dateHelpers.round2(result[0]?.total_value || 0)
    }
  }

  static async _getCollectionRate(companyId, period) {
    const companyOid = new mongoose.Types.ObjectId(companyId)
    const marginMs = 24 * 60 * 60 * 1000
    const qStart = new Date(period.start.getTime() - marginMs)
    const qEnd = new Date(period.end.getTime() + marginMs)

    const result = await aggregateWithTimeout(Invoice, [
      {
        $match: {
          company: companyOid,
          invoiceDate: { $gte: qStart, $lte: qEnd },
          status: { $nin: ['draft', 'cancelled'] }
        }
      },
      {
        $group: {
          _id: null,
          total_billed: { $sum: { $toDouble: { $ifNull: ['$totalAmount', 0] } } },
          total_paid: { $sum: { $toDouble: { $ifNull: ['$amountPaid', 0] } } }
        }
      }
    ], 'dashboard')

    const billed = result[0]?.total_billed || 0
    const paid = result[0]?.total_paid || 0
    const rate = dateHelpers.round2(dateHelpers.safeDivide(paid, billed) * 100)

    return {
      total_billed: dateHelpers.round2(billed),
      total_collected: dateHelpers.round2(paid),
      collection_rate_pct: rate
    }
  }
}

module.exports = SalesDashboardService
