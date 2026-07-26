const ARTransactionLedger = require('../models/ARTransactionLedger');
const ARTrackingService = require('../services/arTrackingService');
const { getARTransactions } = require('../services/ledgerReadService');

/**
 * AR Reconciliation Controller
 * 
 * Provides endpoints for:
 * - Viewing AR transaction history
 * - Verifying data integrity
 * - Running reconciliation and corrections
 * - AR summary reports
 */

/**
 * @desc    Get AR transaction history for a company
 * @route   GET /api/ar-reconciliation/transactions
 * @access  Private (admin, accountant)
 */
exports.getTransactions = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { 
      page = 1, 
      limit = 50, 
      clientId, 
      invoiceId, 
      transactionType,
      startDate, 
      endDate,
      reconciliationStatus
    } = req.query;

    const { items, total, pages, currentPage } = await getARTransactions(
      companyId,
      {
        clientId,
        invoiceId,
        transactionType,
        startDate,
        endDate,
        reconciliationStatus,
      },
      { page, limit },
    );

    res.json({
      success: true,
      count: items.length,
      total,
      pages,
      currentPage,
      data: items,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get AR transaction details
 * @route   GET /api/ar-reconciliation/transactions/:id
 * @access  Private (admin, accountant)
 */
exports.getTransactionById = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const transaction = await ARTransactionLedger.findOne({
      _id: req.params.id,
      company: companyId
    })
      .populate('client', 'name code')
      .populate('invoice', 'referenceNo invoiceNumber amountOutstanding')
      .populate('receipt', 'referenceNo amountReceived')
      .populate('createdBy', 'name email')
      .populate('reversedFrom')
      .populate('reversedBy');

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      data: transaction
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Verify AR data integrity
 * @route   POST /api/ar-reconciliation/verify
 * @access  Private (admin, accountant)
 */
exports.verifyIntegrity = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { clientId, invoiceId, startDate, endDate } = req.body;

    const result = await ARTrackingService.verifyIntegrity(companyId, {
      clientId,
      invoiceId,
      startDate,
      endDate
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Run reconciliation and auto-correct discrepancies
 * @route   POST /api/ar-reconciliation/reconcile
 * @access  Private (admin)
 */
exports.reconcileAndCorrect = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { clientId, invoiceId, startDate, endDate } = req.body;

    const result = await ARTrackingService.reconcileAndCorrect(companyId, userId, {
      clientId,
      invoiceId,
      startDate,
      endDate
    });

    res.json({
      success: true,
      message: result.message,
      corrected: result.corrected
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get AR summary for a client
 * @route   GET /api/ar-reconciliation/clients/:clientId/summary
 * @access  Private (admin, accountant, sales)
 */
exports.getClientARSummary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { clientId } = req.params;

    const summary = await ARTrackingService.getClientARSummary(companyId, clientId);

    if (!summary) {
      return res.status(404).json({
        success: false,
        message: 'Client not found or no AR data'
      });
    }

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get AR aging report with ledger verification
 * @route   GET /api/ar-reconciliation/aging
 * @access  Private (admin, accountant)
 */
exports.getAgingWithVerification = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { clientId, asOfDate } = req.query;

    // Get aging from ARService
    const ARService = require('../services/arService');
    const agingReport = await ARService.getAgingReport(companyId, { clientId, asOfDate });

    // Verify against ledger
    const verification = await ARTrackingService.verifyIntegrity(companyId, { clientId });

    res.json({
      success: true,
      data: {
        aging: agingReport,
        verification: {
          verified: verification.verified,
          discrepancyCount: verification.discrepancies?.length || 0
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get client statement with full transaction history
 * @route   GET /api/ar-reconciliation/clients/:clientId/statement
 * @access  Private (admin, accountant, sales)
 */
exports.getClientStatementWithHistory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { clientId } = req.params;
    const { startDate, endDate, page = 1, limit = 50 } = req.query;

    // Get standard client statement
    const ARService = require('../services/arService');
    const statement = await ARService.getClientStatement(companyId, clientId, { startDate, endDate });

    // Get transaction history
    const query = { 
      company: companyId,
      client: clientId
    };
    
    if (startDate || endDate) {
      query.transactionDate = {};
      if (startDate) query.transactionDate.$gte = new Date(startDate);
      if (endDate) query.transactionDate.$lte = new Date(endDate);
    }

    const transactions = await ARTransactionLedger.find(query)
      .populate('invoice', 'referenceNo')
      .populate('receipt', 'referenceNo')
      .sort({ transactionDate: -1, createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await ARTransactionLedger.countDocuments(query);

    res.json({
      success: true,
      data: {
        statement: statement.data,
        transactions: {
          data: transactions,
          total,
          pages: Math.ceil(total / limit),
          currentPage: page
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Find discrepancies in AR data
 * @route   GET /api/ar-reconciliation/discrepancies
 * @access  Private (admin, accountant)
 */
exports.findDiscrepancies = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { clientId, startDate, endDate } = req.query;

    const discrepancies = await ARTransactionLedger.findDiscrepancies(companyId, {
      clientId,
      startDate,
      endDate
    });

    res.json({
      success: true,
      count: discrepancies.length,
      data: discrepancies
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get current receivables (outstanding invoices)
 * @route   GET /api/ar-reconciliation/current-receivables
 * @access  Private (admin, accountant, sales)
 */
exports.getCurrentReceivables = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { clientId, page = 1, limit = 50 } = req.query;

    const Invoice = require('../models/Invoice');
    const Client = require('../models/Client');
    const mongoose = require('mongoose');

    // Build query for outstanding invoices
    // Note: amountOutstanding is Decimal128, so we need special handling
    const query = {
      company: companyId,
      status: { $in: ['confirmed', 'partially_paid'] }
    };

    if (clientId) query.client = clientId;

    // Get invoices that have amountOutstanding > 0 (handling Decimal128)
    const invoices = await Invoice.find(query)
      .populate('client', 'name code')
      .sort({ invoiceDate: -1 })
      .lean();

    // Filter invoices with outstanding amount > 0 (convert Decimal128 to number)
    const outstandingInvoices = invoices.filter(inv => {
      const outstanding = inv.amountOutstanding ? parseFloat(inv.amountOutstanding.toString()) : 0;
      return outstanding > 0;
    });

    // Paginate manually
    const total = outstandingInvoices.length;
    const paginatedInvoices = outstandingInvoices
      .slice((page - 1) * limit, page * limit);

    // Calculate summary
    const summary = {
      totalOutstanding: 0,
      totalInvoices: outstandingInvoices.length,
      overdueAmount: 0,
      overdueCount: 0
    };

    const clientSummary = {};
    const now = new Date();

    outstandingInvoices.forEach(inv => {
      const outstanding = inv.amountOutstanding ? parseFloat(inv.amountOutstanding.toString()) : 0;
      summary.totalOutstanding += outstanding;

      // Check if overdue
      if (inv.dueDate && new Date(inv.dueDate) < now) {
        summary.overdueAmount += outstanding;
        summary.overdueCount += 1;
      }

      // Client summary
      const clientId = inv.client?._id?.toString();
      if (clientId) {
        if (!clientSummary[clientId]) {
          clientSummary[clientId] = {
            _id: inv.client._id,
            client: inv.client,
            totalOutstanding: 0,
            invoiceCount: 0
          };
        }
        clientSummary[clientId].totalOutstanding += outstanding;
        clientSummary[clientId].invoiceCount += 1;
      }
    });

    // Sort client summary by outstanding amount
    const sortedClientSummary = Object.values(clientSummary)
      .sort((a, b) => b.totalOutstanding - a.totalOutstanding)
      .slice(0, 10);

    // Convert Decimal128 fields in invoices to plain numbers for JSON serialization
    const serializedInvoices = paginatedInvoices.map(inv => ({
      ...inv,
      totalAmount: inv.totalAmount ? parseFloat(inv.totalAmount.toString()) : 0,
      amountPaid: inv.amountPaid ? parseFloat(inv.amountPaid.toString()) : 0,
      amountOutstanding: inv.amountOutstanding ? parseFloat(inv.amountOutstanding.toString()) : 0,
      balance: inv.balance ? parseFloat(inv.balance.toString()) : (inv.amountOutstanding ? parseFloat(inv.amountOutstanding.toString()) : 0)
    }));

    res.json({
      success: true,
      data: {
        invoices: serializedInvoices,
        summary,
        clientSummary: sortedClientSummary,
        pagination: {
          total,
          pages: Math.ceil(total / limit),
          currentPage: parseInt(page)
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get AR summary dashboard data
 * @route   GET /api/ar-reconciliation/dashboard
 * @access  Private (admin, accountant)
 */
exports.getDashboard = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    // Get summary stats
    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [
      totalTransactions,
      recentTransactions,
      pendingReconciliation,
      discrepancyCount
    ] = await Promise.all([
      ARTransactionLedger.countDocuments({ company: companyId }),
      ARTransactionLedger.countDocuments({ 
        company: companyId,
        transactionDate: { $gte: thirtyDaysAgo }
      }),
      ARTransactionLedger.countDocuments({ 
        company: companyId,
        reconciliationStatus: 'pending'
      }),
      ARTransactionLedger.countDocuments({ 
        company: companyId,
        reconciliationStatus: 'discrepancy'
      })
    ]);

    // Get transaction type breakdown
    const typeBreakdown = await ARTransactionLedger.aggregate([
      { $match: { company: companyId } },
      {
        $group: {
          _id: '$transactionType',
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' }
        }
      }
    ]);

    // Get recent activity
    const recentActivity = await ARTransactionLedger.find({ company: companyId })
      .populate('client', 'name')
      .sort({ createdAt: -1 })
      .limit(10);

    res.json({
      success: true,
      data: {
        stats: {
          totalTransactions,
          recentTransactions,
          pendingReconciliation,
          discrepancyCount
        },
        typeBreakdown,
        recentActivity
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Verify all pending transactions (force update)
 * @route   POST /api/ar-reconciliation/verify-all
 * @access  Private (admin)
 */
exports.verifyAllPending = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;

    const ARTransactionLedger = require('../models/ARTransactionLedger');
    const mongoose = require('mongoose');

    // Update all pending transactions to verified
    const result = await ARTransactionLedger.updateMany(
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
      action: 'verify_all_pending_transactions',
      module: 'ar_reconciliation',
      details: { count: result.modifiedCount },
      status: 'success'
    });

    res.json({
      success: true,
      message: `${result.modifiedCount} transactions marked as verified`,
      count: result.modifiedCount
    });
  } catch (error) {
    next(error);
  }
};
