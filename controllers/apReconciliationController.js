const APTrackingService = require('../services/apTrackingService');
const APTransactionLedger = require('../models/APTransactionLedger');
const { getAPTransactions } = require('../services/ledgerReadService');
const GoodsReceivedNote = require('../models/GoodsReceivedNote');
const Supplier = require('../models/Supplier');
const mongoose = require('mongoose');

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
          limit: parseInt(limit, 10),
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

      const query = {
        company: companyId,
        balance: { $gt: 0 }
      };

      if (supplierId) query.supplier = supplierId;
      // Include both GRNs and direct Purchases as outstanding payables
      const Purchase = require('../models/Purchase');

      const grnQuery = { ...query };
      const purchaseQuery = { ...query };

      // Count both
      const [grnCount, purchaseCount] = await Promise.all([
        GoodsReceivedNote.countDocuments(grnQuery),
        Purchase.countDocuments(purchaseQuery)
      ]);

      const [grns, purchases] = await Promise.all([
        GoodsReceivedNote.find(grnQuery).populate('supplier', 'name code').lean(),
        Purchase.find(purchaseQuery).populate('supplier', 'name code').lean()
      ]);

      // Normalize entries and merge
      const normalizedGRNs = grns.map(g => ({
        _id: g._id,
        type: 'grn',
        reference: g.referenceNo || g.grnNumber,
        supplier: g.supplier,
        date: g.receivedDate,
        totalAmount: parseFloat(g.totalAmount || 0),
        amountPaid: parseFloat(g.amountPaid || 0),
        balance: parseFloat(g.balance || 0),
        raw: g
      }));

      const normalizedPurchases = purchases.map(p => ({
        _id: p._id,
        type: 'purchase',
        reference: p.purchaseNumber || p.supplierInvoiceNumber,
        supplier: p.supplier,
        date: p.receivedDate || p.purchaseDate,
        totalAmount: parseFloat(p.grandTotal || p.roundedAmount || 0),
        amountPaid: parseFloat(p.amountPaid || 0),
        balance: parseFloat(p.balance || 0),
        raw: p
      }));

      const all = [...normalizedGRNs, ...normalizedPurchases];

      // sort by date desc
      all.sort((a, b) => {
        const da = a.date ? new Date(a.date).getTime() : 0;
        const db = b.date ? new Date(b.date).getTime() : 0;
        return db - da;
      });

      const total = grnCount + purchaseCount;
      const pages = Math.max(1, Math.ceil(total / parseInt(limit)));
      const start = (page - 1) * limit;
      const pageItems = all.slice(start, start + parseInt(limit));

      const totalOutstanding = all.reduce((s, it) => s + (it.balance || 0), 0);

      res.json({
        success: true,
        data: {
          grns: pageItems.map(i => ({
            ...i.raw,
            _apType: i.type,
            reference: i.reference,
            totalAmount: i.totalAmount,
            amountPaid: i.amountPaid,
            balance: i.balance
          })),
          summary: { totalOutstanding, totalGRNs: total },
          pagination: {
            total,
            page: parseInt(page),
            limit: parseInt(limit),
            pages
          }
        }
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

      // Get current balance
      const currentBalance = await APTrackingService.getSupplierBalance(companyId, supplierId);

      // Get transaction summary
      const transactions = await APTransactionLedger.find({
        company: companyId,
        supplier: supplierId
      });

      const summary = {
        totalTransactions: transactions.length,
        totalIncreases: transactions
          .filter(t => t.direction === 'increase')
          .reduce((sum, t) => sum + parseFloat(t.amount), 0),
        totalDecreases: transactions
          .filter(t => t.direction === 'decrease')
          .reduce((sum, t) => sum + parseFloat(t.amount), 0),
        currentBalance
      };

      res.json({
        success: true,
        data: {
          supplier: {
            _id: supplier._id,
            name: supplier.name,
            code: supplier.code
          },
          summary
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

      // Verify supplier
      const supplier = await Supplier.findOne({ _id: supplierId, company: companyId });
      if (!supplier) {
        return res.status(404).json({ success: false, message: 'Supplier not found' });
      }

      // Get GRNs
      const grnQuery = { supplier: supplierId, company: companyId };
      if (startDate || endDate) {
        grnQuery.receivedDate = {};
        if (startDate) grnQuery.receivedDate.$gte = new Date(startDate);
        if (endDate) grnQuery.receivedDate.$lte = new Date(endDate);
      }
      const grns = await GoodsReceivedNote.find(grnQuery)
        .populate('createdBy', 'name')
        .sort({ receivedDate: 1 });

      // Get transaction history
      const transactions = await APTrackingService.getSupplierHistory(companyId, supplierId, {
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        limit: parseInt(limit),
        skip: (page - 1) * limit
      });

      const totalTransactions = await APTransactionLedger.countDocuments({
        company: companyId,
        supplier: supplierId,
        ...(startDate && { transactionDate: { $gte: new Date(startDate) } }),
        ...(endDate && { transactionDate: { $lte: new Date(endDate) } })
      });

      // Calculate totals
      const totalGRNs = grns.reduce((sum, g) => sum + (parseFloat(g.totalAmount) || 0), 0);
      const totalPaid = grns.reduce((sum, g) => sum + (parseFloat(g.amountPaid) || 0), 0);
      const totalOutstanding = grns.reduce((sum, g) => sum + (parseFloat(g.balance) || 0), 0);

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
              totalGRNs: totalGRNs.toFixed(2),
              totalPaid: totalPaid.toFixed(2),
              totalOutstanding: totalOutstanding.toFixed(2),
              grnCount: grns.length
            }
          },
          transactions: {
            data: transactions,
            total: totalTransactions,
            pages: Math.ceil(totalTransactions / limit),
            currentPage: parseInt(page)
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
          company: new mongoose.Types.ObjectId(companyId),
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
