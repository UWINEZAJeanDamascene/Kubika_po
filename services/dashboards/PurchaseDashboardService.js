const mongoose = require('mongoose')
const { aggregateWithTimeout } = require('../../utils/mongoAggregation')
const PurchaseOrder = require('../../models/PurchaseOrder')
const GRN = require('../../models/GoodsReceivedNote')
const PurchaseReturn = require('../../models/PurchaseReturn')
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

const MS_PER_DAY = 1000 * 60 * 60 * 24

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
   */
  static async _getPOSummary(companyId, period) {
    const companyOid = new mongoose.Types.ObjectId(companyId)
    const marginMs = 24 * 60 * 60 * 1000
    const qStart = new Date(period.start.getTime() - marginMs)
    const qEnd = new Date(period.end.getTime() + marginMs)

    const result = await aggregateWithTimeout(PurchaseOrder, [
      {
        $match: {
          company: companyOid,
          orderDate: { $gte: qStart, $lte: qEnd }
        }
      },
      {
        $group: {
          _id: null,
          po_count: { $sum: 1 },
          total_value: { $sum: { $toDouble: { $ifNull: ['$totalAmount', 0] } } },
          open_count: {
            $sum: {
              $cond: [{ $in: ['$status', OPEN_PO_STATUSES] }, 1, 0]
            }
          },
          open_value: {
            $sum: {
              $cond: [
                { $in: ['$status', OPEN_PO_STATUSES] },
                { $toDouble: { $ifNull: ['$totalAmount', 0] } },
                0
              ]
            }
          }
        }
      }
    ], 'dashboard')

    const s = result[0] || {}
    return {
      po_count: s.po_count || 0,
      total_value: dateHelpers.round2(s.total_value || 0),
      open_count: s.open_count || 0,
      open_value: dateHelpers.round2(s.open_value || 0)
    }
  }

  /**
   * Confirmed GRNs awaiting payment — includes both invoice (total) value and remaining balance.
   */
  static async _getGRNPending(companyId) {
    const companyOid = new mongoose.Types.ObjectId(companyId)

    const result = await aggregateWithTimeout(GRN, [
      {
        $match: {
          company: companyOid,
          status: 'confirmed',
          paymentStatus: { $in: ['pending', 'partially_paid'] }
        }
      },
      {
        $group: {
          _id: null,
          grn_count: { $sum: 1 },
          total_value: {
            $sum: { $toDouble: { $ifNull: ['$totalAmount', 0] } }
          },
          total_balance_outstanding: {
            $sum: { $toDouble: { $ifNull: ['$balance', 0] } }
          }
        }
      }
    ], 'dashboard')

    const row = result[0] || {}
    return {
      count: row.grn_count || 0,
      total_value: dateHelpers.round2(row.total_value || 0),
      total_balance_outstanding: dateHelpers.round2(row.total_balance_outstanding || 0)
    }
  }

  /**
   * Single scan of unpaid GRNs for AP summary + aging buckets (fewer round-trips).
   */
  static async _getAPSummaryAndAging(companyId) {
    const companyOid = new mongoose.Types.ObjectId(companyId)
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)

    const [doc] = await aggregateWithTimeout(GRN, [
      {
        $match: {
          company: companyOid,
          status: 'confirmed',
          paymentStatus: { $ne: 'paid' }
        }
      },
      {
        $facet: {
          summary: [
            {
              $addFields: {
                outstanding: { $toDouble: { $ifNull: ['$balance', 0] } }
              }
            },
            {
              $group: {
                _id: null,
                total_ap: { $sum: '$outstanding' },
                count: { $sum: 1 },
                overdue_amount: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $ne: ['$paymentDueDate', null] },
                          { $lt: ['$paymentDueDate', today] }
                        ]
                      },
                      '$outstanding',
                      0
                    ]
                  }
                },
                overdue_count: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $ne: ['$paymentDueDate', null] },
                          { $lt: ['$paymentDueDate', today] }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                }
              }
            }
          ],
          aging: [
            {
              $addFields: {
                outstanding: { $toDouble: { $ifNull: ['$balance', 0] } },
                days_overdue: {
                  $cond: {
                    if: {
                      $and: [
                        { $ne: ['$paymentDueDate', null] },
                        { $lt: ['$paymentDueDate', today] }
                      ]
                    },
                    then: {
                      $toInt: {
                        $divide: [{ $subtract: [today, '$paymentDueDate'] }, MS_PER_DAY]
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
                    $cond: [{ $eq: ['$days_overdue', 0] }, '$outstanding', 0]
                  }
                },
                days_1_30: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gte: ['$days_overdue', 1] },
                          { $lte: ['$days_overdue', 30] }
                        ]
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
                        $and: [
                          { $gte: ['$days_overdue', 31] },
                          { $lte: ['$days_overdue', 60] }
                        ]
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
                        $and: [
                          { $gte: ['$days_overdue', 61] },
                          { $lte: ['$days_overdue', 90] }
                        ]
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
                total_outstanding: { $sum: '$outstanding' }
              }
            }
          ]
        }
      }
    ], 'dashboard')

    const s = (doc && doc.summary && doc.summary[0]) || {}
    const b = (doc && doc.aging && doc.aging[0]) || {}

    const apSummary = {
      total_outstanding: dateHelpers.round2(s.total_ap || 0),
      invoice_count: s.count || 0,
      overdue_amount: dateHelpers.round2(s.overdue_amount || 0),
      overdue_count: s.overdue_count || 0
    }

    const apAging = {
      not_due: dateHelpers.round2(b.not_due || 0),
      days_1_30: dateHelpers.round2(b.days_1_30 || 0),
      days_31_60: dateHelpers.round2(b.days_31_60 || 0),
      days_61_90: dateHelpers.round2(b.days_61_90 || 0),
      days_90_plus: dateHelpers.round2(b.days_90_plus || 0),
      total_outstanding: dateHelpers.round2(b.total_outstanding || 0)
    }

    return { apSummary, apAging }
  }

  static async _getTopSuppliers(companyId, limit) {
    const companyOid = new mongoose.Types.ObjectId(companyId)

    return aggregateWithTimeout(GRN, [
      {
        $match: {
          company: companyOid,
          status: 'confirmed',
          supplier: { $ne: null }
        }
      },
      {
        $group: {
          _id: '$supplier',
          total_value: { $sum: { $toDouble: { $ifNull: ['$totalAmount', 0] } } },
          grn_count: { $sum: 1 }
        }
      },
      { $sort: { total_value: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'suppliers',
          localField: '_id',
          foreignField: '_id',
          as: 'supplier'
        }
      },
      { $unwind: '$supplier' },
      {
        $project: {
          supplier_id: '$_id',
          supplier_name: '$supplier.name',
          supplier_code: { $ifNull: ['$supplier.code', ''] },
          total_value: { $round: ['$total_value', 2] },
          grn_count: 1
        }
      }
    ], 'dashboard')
  }

  static async _getPOsByStatus(companyId) {
    const companyOid = new mongoose.Types.ObjectId(companyId)

    const result = await aggregateWithTimeout(PurchaseOrder, [
      {
        $match: { company: companyOid }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          total_value: { $sum: { $toDouble: { $ifNull: ['$totalAmount', 0] } } }
        }
      }
    ], 'dashboard')

    const map = {}
    for (const row of result) {
      map[row._id] = {
        count: row.count,
        total_value: dateHelpers.round2(row.total_value || 0)
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
    const companyOid = new mongoose.Types.ObjectId(companyId)

    const result = await aggregateWithTimeout(PurchaseReturn, [
      { $match: { company: companyOid } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          total_amount: { $sum: { $toDouble: { $ifNull: ['$totalAmount', 0] } } }
        }
      }
    ], 'dashboard')

    let totalCount = 0
    let totalAmount = 0
    let draftCount = 0
    let confirmedCount = 0

    for (const row of result) {
      totalCount += row.count
      totalAmount += row.total_amount || 0
      if (row._id === 'draft') draftCount = row.count
      if (row._id === 'confirmed') confirmedCount = row.count
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
