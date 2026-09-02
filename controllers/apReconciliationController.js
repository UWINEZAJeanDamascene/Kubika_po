const APTrackingService = require('../services/apTrackingService');
const APTransactionLedger = require('../models/APTransactionLedger');
const { getAPTransactions } = require('../services/ledgerReadService');
const GoodsReceivedNote = require('../models/GoodsReceivedNote');
const Supplier = require('../models/Supplier');
const { dbClient } = require('../lib/prisma');
const { parsePagination } = require('../utils/pagination');

function buildOutstandingPayablesSql(companyId, supplierId) {
  const params = [String(companyId)];
  let supplierClause = '';
  if (supplierId) {
    params.push(String(supplierId));
    supplierClause = ` AND supplier_id = $${params.length}`;
  }
  const sql = `
    SELECT id AS "_id", 'grn'::text AS type, reference_no AS reference,
           supplier_id AS "supplierId", received_date AS date,
           total_amount::double precision AS "totalAmount",
           amount_paid::double precision AS "amountPaid",
           balance::double precision AS balance
      FROM goods_received_notes
     WHERE company_id = $1 AND balance > 0${supplierClause}
    UNION ALL
    SELECT id AS "_id", 'purchase'::text AS type, purchase_number AS reference,
           supplier_id AS "supplierId", purchase_date AS date,
           total_amount::double precision AS "totalAmount",
           COALESCE((
             SELECT SUM(COALESCE((payment ->> 'amount')::numeric, 0))
               FROM jsonb_array_elements(COALESCE(payments, '[]'::jsonb)) AS payment
           ), 0)::double precision AS "amountPaid",
           total_amount::double precision AS balance
      FROM purchases
     WHERE company_id = $1 AND total_amount > 0${supplierClause}`;
  return { sql, params };
}

async function readOutstandingPayables(companyId, supplierId, page, limit) {
  const { page: safePage, limit: safeLimit, skip } = parsePagination(
    { page, limit },
    { defaultLimit: 50, maxLimit: 100 },
  );
  const base = buildOutstandingPayablesSql(companyId, supplierId);
  const summaryRows = await dbClient().$queryRawUnsafe(
    `WITH payables AS (${base.sql})
     SELECT COUNT(*)::int AS total,
            COALESCE(SUM(balance), 0)::double precision AS "totalOutstanding"
       FROM payables`,
    ...base.params,
  );
  const total = Number(summaryRows[0]?.total || 0);
  const totalOutstanding = Number(summaryRows[0]?.totalOutstanding || 0);
  const pages = Math.max(1, Math.ceil(total / safeLimit));
  const currentPage = Math.min(safePage, pages);
  const params = [...base.params, safeLimit, (currentPage - 1) * safeLimit];
  const rows = await dbClient().$queryRawUnsafe(
    `WITH payables AS (${base.sql})
     SELECT * FROM payables
      ORDER BY date DESC NULLS LAST, "_id" DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    ...params,
  );

  const grnIds = rows.filter((row) => row.type === 'grn').map((row) => String(row._id));
  const purchaseIds = rows.filter((row) => row.type === 'purchase').map((row) => String(row._id));
  const Purchase = require('../models/Purchase');
  const [grns, purchases] = await Promise.all([
    grnIds.length
      ? GoodsReceivedNote.find({ _id: { $in: grnIds }, company: companyId })
        .populate('supplier', 'name code')
        .limit(grnIds.length)
        .lean()
      : [],
    purchaseIds.length
      ? Purchase.find({ _id: { $in: purchaseIds }, company: companyId })
        .populate('supplier', 'name code')
        .limit(purchaseIds.length)
        .lean()
      : [],
  ]);
  const rawById = new Map([...grns, ...purchases].map((row) => [String(row._id), row]));
  const data = rows.map((row) => {
    const raw = rawById.get(String(row._id)) || {};
    return {
      ...raw,
      _id: row._id,
      _apType: row.type,
      reference: row.reference,
      supplier: raw.supplier || row.supplierId,
      date: row.date,
      totalAmount: Number(row.totalAmount || 0),
      amountPaid: Number(row.amountPaid || 0),
      balance: Number(row.balance || 0),
    };
  });
  return {
    data,
    total,
    totalOutstanding,
    pagination: { total, page: currentPage, limit: safeLimit, pages },
  };
}

/**
 * AP Reconciliation Controller
 * Mirrors ARReconciliationController for Accounts Payable
 */
const apReconciliationController = {
  /**
   * GET /api/ap-reconciliation/dashboard - Get dashboard data
   */
  async getDashboard(req, res, next) {
    try {
      const companyId = req.user.company._id;
      const dashboard = await APTrackingService.getDashboardStats(companyId);

      // Convert Decimal128 fields in recentActivity to plain numbers
      if (dashboard.recentActivity) {
        dashboard.recentActivity = dashboard.recentActivity.map(tx => ({
          ...tx.toObject ? tx.toObject() : tx,
          amount: parseFloat(tx.amount || 0),
          supplierBalanceAfter: parseFloat(tx.supplierBalanceAfter || 0),
          grnBalanceAfter: tx.grnBalanceAfter ? parseFloat(tx.grnBalanceAfter) : null
        }));
      }

      res.json(dashboard);
    } catch (error) {
      next(error);
    }
  },

  /**
   * GET /api/ap-reconciliation/transactions - List transactions
   */
  async getTransactions(req, res, next) {
    try {
      const companyId = req.user.company._id;
      const {
        supplierId,
        transactionType,
        reconciliationStatus,
        startDate,
        endDate,
        page = 1,
        limit = 50
      } = req.query;

      const { items, total, pages, currentPage } = await getAPTransactions(
        companyId,
        {
          supplierId,
          transactionType,
          startDate,
          endDate,
          reconciliationStatus,
        },
        { page, limit },
      );

      res.json({
        success: true,
        data: items,
        pagination: {
          total,
          page: currentPage,
          limit: Math.min(100, Math.max(1, parseInt(limit, 10) || 50)),
          pages,
        },
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * GET /api/ap-reconciliation/transactions/:id - Get single transaction
   */
  async getTransactionById(req, res, next) {
    try {
      const companyId = req.user.company._id;
      const { id } = req.params;

      const transaction = await APTransactionLedger.findOne({
        _id: id,
        company: companyId
      })
        .populate('supplier', 'name code')
        .populate('grn', 'referenceNo grnNumber')
        .populate('payment', 'referenceNo amountPaid')
        .populate('createdBy', 'name');

      if (!transaction) {
        return res.status(404).json({ success: false, message: 'Transaction not found' });
      }

      res.json({ success: true, data: transaction });
    } catch (error) {
      next(error);
    }
  },

  /**
   * POST /api/ap-reconciliation/verify - Verify data integrity
   */
  async verifyIntegrity(req, res, next) {
    try {
      const companyId = req.user.company._id;
      const { supplierId, startDate, endDate } = req.body;

      const result = await APTrackingService.verifyIntegrity(companyId, {
        supplierId,
        startDate,
        endDate
      });

      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  },

  /**
   * POST /api/ap-reconciliation/reconcile - Reconcile and correct
   */
  async reconcileAndCorrect(req, res, next) {
    try {
      const companyId = req.user.company._id;
      const userId = req.user._id;
      const { supplierId, startDate, endDate } = req.body;

      const result = await APTrackingService.reconcileAndCorrect(companyId, userId, {
        supplierId,
        startDate,
        endDate
      });

      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  },

  /**
   * GET /api/ap-reconciliation/current-payables - Current outstanding payables
   */
  async getCurrentPayables(req, res, next) {
    try {
      const companyId = req.user.company._id;
      const { supplierId, page = 1, limit = 50 } = req.query;
      const result = await readOutstandingPayables(companyId, supplierId, page, limit);

      res.json({
        success: true,
        data: {
          grns: result.data,
          summary: { totalOutstanding: result.totalOutstanding, totalGRNs: result.total },
          pagination: result.pagination,
        },
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * GET /api/ap-reconciliation/aging - Get aging report with verification
   */
  async getAgingWithVerification(req, res, next) {
    try {
      const companyId = req.user.company._id;
      const { supplierId, asOfDate } = req.query;

      const result = await APTrackingService.getAgingWithVerification(companyId, {
        supplierId,
        asOfDate
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * GET /api/ap-reconciliation/suppliers/:supplierId/summary - Get supplier summary
   */
  async getSupplierSummary(req, res, next) {
    try {
      const companyId = req.user.company._id;
      const { supplierId } = req.params;

      // Verify supplier
      const supplier = await Supplier.findOne({ _id: supplierId, company: companyId });
      if (!supplier) {
        return res.status(404).json({ success: false, message: 'Supplier not found' });
      }

      const currentBalance = await APTrackingService.getSupplierBalance(companyId, supplierId);
      const summaryRows = await dbClient().$queryRaw`
        SELECT COUNT(*)::int AS "totalTransactions",
               COALESCE(SUM(amount) FILTER (WHERE direction = 'increase'), 0)::double precision AS "totalIncreases",
               COALESCE(SUM(amount) FILTER (WHERE direction = 'decrease'), 0)::double precision AS "totalDecreases"
          FROM ap_transaction_ledger
         WHERE company_id = ${String(companyId)} AND supplier_id = ${String(supplierId)}`;
      const summaryRow = summaryRows[0] || {};

      res.json({
        success: true,
        data: {
          supplier: {
            _id: supplier._id,
            name: supplier.name,
            code: supplier.code
          },
          summary: {
            totalTransactions: Number(summaryRow.totalTransactions || 0),
            totalIncreases: Number(summaryRow.totalIncreases || 0),
            totalDecreases: Number(summaryRow.totalDecreases || 0),
            currentBalance
          }
        }
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * GET /api/ap-reconciliation/suppliers/:supplierId/statement - Get supplier statement
   */
  async getSupplierStatementWithHistory(req, res, next) {
    try {
      const companyId = req.user.company._id;
      const { supplierId } = req.params;
      const { startDate, endDate, page = 1, limit = 50 } = req.query;
      const { page: pageNum, limit: limitNum, skip } = parsePagination({ page, limit }, { defaultLimit: 50, maxLimit: 100 });

      // Verify supplier
      const supplier = await Supplier.findOne({ _id: supplierId, company: companyId });
      if (!supplier) {
        return res.status(404).json({ success: false, message: 'Supplier not found' });
      }

      const dateFilter = {};
      if (startDate) dateFilter.$gte = new Date(startDate);
      if (endDate) dateFilter.$lte = new Date(endDate);
      const grnQuery = { supplier: supplierId, company: companyId };
      if (Object.keys(dateFilter).length) grnQuery.receivedDate = dateFilter;
      const grnParams = [String(companyId), String(supplierId)];
      const grnWhere = ['company_id = $1', 'supplier_id = $2'];
      if (startDate) {
        grnParams.push(new Date(startDate));
        grnWhere.push(`received_date >= $${grnParams.length}`);
      }
      if (endDate) {
        grnParams.push(new Date(endDate));
        grnWhere.push(`received_date <= $${grnParams.length}`);
      }
      const [grnStats, grns] = await Promise.all([
        dbClient().$queryRawUnsafe(`
          SELECT COUNT(*)::int AS count,
                 COALESCE(SUM(total_amount), 0)::double precision AS total,
                 COALESCE(SUM(amount_paid), 0)::double precision AS paid,
                 COALESCE(SUM(balance), 0)::double precision AS outstanding
            FROM goods_received_notes
           WHERE ${grnWhere.join(' AND ')}`,
          ...grnParams,
        ),
        GoodsReceivedNote.find(grnQuery)
          .populate('createdBy', 'name')
          .sort({ receivedDate: 1 })
          .skip(skip)
          .limit(limitNum),
      ]);

      const transactions = await APTrackingService.getSupplierHistory(companyId, supplierId, {
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        limit: limitNum,
        skip,
      });
      const totalTransactions = await APTransactionLedger.countDocuments({
        company: companyId,
        supplier: supplierId,
        ...(startDate || endDate ? { transactionDate: dateFilter } : {}),
      });
      const stats = grnStats[0] || {};
      const grnCount = Number(stats.count || 0);

      res.json({
        success: true,
        data: {
          supplier: {
            _id: supplier._id,
            name: supplier.name,
            code: supplier.code
          },
          statement: {
            grns: grns.map(g => ({
              id: g._id,
              reference: g.referenceNo || g.grnNumber,
              date: g.receivedDate,
              total: parseFloat(g.totalAmount || 0).toFixed(2),
              paid: parseFloat(g.amountPaid || 0).toFixed(2),
              balance: parseFloat(g.balance || 0).toFixed(2),
              status: g.paymentStatus
            })),
            summary: {
              totalGRNs: Number(stats.total || 0).toFixed(2),
              totalPaid: Number(stats.paid || 0).toFixed(2),
              totalOutstanding: Number(stats.outstanding || 0).toFixed(2),
              grnCount
            }
          },
          transactions: {
            data: transactions,
            total: totalTransactions,
            pages: Math.max(1, Math.ceil(totalTransactions / limitNum)),
            currentPage: pageNum
          }
        }
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * GET /api/ap-reconciliation/discrepancies - Find discrepancies
   */
  async findDiscrepancies(req, res, next) {
    try {
      const companyId = req.user.company._id;
      const { supplierId, startDate, endDate } = req.query;

      const verification = await APTrackingService.verifyIntegrity(companyId, {
        supplierId,
        startDate,
        endDate
      });

      res.json({
        success: true,
        count: verification.discrepancyCount,
        data: verification.discrepancies
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * POST /api/ap-reconciliation/verify-all - Verify all pending transactions
   */
  async verifyAllPending(req, res, next) {
    try {
      const companyId = req.user.company._id;
      const userId = req.user._id;

      // Update all pending transactions to verified
      const result = await APTransactionLedger.updateMany(
        {
          company: companyId,
          reconciliationStatus: 'pending'
        },
        {
          $set: {
            reconciliationStatus: 'verified',
            verifiedAt: new Date()
          }
        }
      );

      // Log the action
      const ActionLog = require('../models/ActionLog');
      await ActionLog.create({
        company: companyId,
        user: userId,
        action: 'verify_all_pending_ap_transactions',
        module: 'ap_reconciliation',
        details: { count: result.modifiedCount },
        status: 'success'
      });

      res.json({
        success: true,
        message: `${result.modifiedCount} AP transactions marked as verified`,
        count: result.modifiedCount
      });
    } catch (error) {
      next(error);
    }
  }
};

module.exports = apReconciliationController;
