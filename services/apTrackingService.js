const APTransactionLedger = require('../models/APTransactionLedger');
const { dbClient } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const APPayment = require('../models/APPayment');
const APPaymentAllocation = require('../models/APPaymentAllocation');
const GoodsReceivedNote = require('../models/GoodsReceivedNote');
const Supplier = require('../models/Supplier');
const cacheService = require('./cacheService');

/**
 * AP Tracking Service
 * Mirrors ARTrackingService for Accounts Payable
 * Handles AP transaction recording, integrity verification, and reconciliation
 */
class APTrackingService {
  static async lockSupplierBalance(companyId, supplierId) {
    const client = dbClient();
    if (typeof client.$queryRaw !== 'function') {
      throw new Error('Supplier AP updates require a PostgreSQL transaction');
    }
    await client.$queryRaw`
      SELECT id FROM suppliers
      WHERE id = ${String(supplierId)} AND company_id = ${String(companyId)}
      FOR UPDATE`;
  }

  /**
   * Record a new GRN received (increases AP)
   */
  static async recordGRNReceived(grn, userId) {
    const companyId = grn.company;
    const supplierId = grn.supplier;
    const amount = parseFloat(grn.totalAmount) || 0;

    // An event can be retried (for example, a GRN confirmation response timing out).
    const existing = await APTransactionLedger.findOne({ company: companyId, sourceType: 'grn', sourceId: grn._id });
    if (existing) return existing;
    await this.lockSupplierBalance(companyId, supplierId);
    const currentBalance = await this.getSupplierBalance(companyId, supplierId, { bypassCache: true });
    const newBalance = currentBalance + amount;

    // Create ledger entry
    const transaction = new APTransactionLedger({
      company: companyId,
      supplier: supplierId,
      transactionType: 'grn_received',
      transactionDate: grn.receivedDate || new Date(),
      referenceNo: grn.referenceNo || grn.grnNumber,
      description: `GRN ${grn.referenceNo || grn.grnNumber} received - Amount: ${amount.toFixed(2)}`,
      amount: amount,
      direction: 'increase',
      supplierBalanceAfter: newBalance,
      grnBalanceAfter: amount,
      grn: grn._id,
      sourceType: 'grn',
      sourceId: grn._id,
      sourceReference: grn.referenceNo || grn.grnNumber,
      createdBy: userId,
      reconciliationStatus: 'verified',
      metadata: {
        grnDate: grn.grnDate,
        supplierRef: grn.supplierRef
      }
    });

    await transaction.save();

    // Invalidate cache
    await this.invalidateSupplierBalanceCache(companyId, supplierId);

    return transaction;
  }

  /**
   * Record a supplier credit note when returned goods are accepted.
   */
  static async recordPurchaseReturn(returnDoc, userId) {
    const companyId = returnDoc.company;
    const supplierId = returnDoc.supplier;
    const existing = await APTransactionLedger.findOne({
      company: companyId,
      sourceType: 'purchase_return',
      sourceId: returnDoc._id,
    });
    if (existing) return existing;

    await this.lockSupplierBalance(companyId, supplierId);
    const amount = Number(returnDoc.totalAmount) || 0;
    const currentBalance = await this.getSupplierBalance(companyId, supplierId, { bypassCache: true });
    const transaction = new APTransactionLedger({
      company: companyId,
      supplier: supplierId,
      transactionType: 'purchase_return',
      transactionDate: returnDoc.returnDate || new Date(),
      referenceNo: returnDoc.referenceNo,
      description: `Purchase return ${returnDoc.referenceNo} accepted - supplier credit ${amount.toFixed(2)}`,
      amount,
      direction: 'decrease',
      supplierBalanceAfter: currentBalance - amount,
      grn: returnDoc.grn,
      sourceType: 'purchase_return',
      sourceId: returnDoc._id,
      sourceReference: returnDoc.referenceNo,
      createdBy: userId,
      reconciliationStatus: 'verified',
      metadata: { supplierCreditNoteNo: returnDoc.supplierCreditNoteNo || null },
    });
    await transaction.save();
    await this.invalidateSupplierBalanceCache(companyId, supplierId);
    return transaction;
  }

  /**
   * Record cash received from the supplier to settle an accepted credit note.
   */
  static async recordPurchaseReturnRefund(returnDoc, userId) {
    const companyId = returnDoc.company;
    const supplierId = returnDoc.supplier;
    const sourceType = 'purchase_return_refund';
    const existing = await APTransactionLedger.findOne({
      company: companyId,
      sourceType,
      sourceId: returnDoc._id,
    });
    if (existing) return existing;

    await this.lockSupplierBalance(companyId, supplierId);
    const amount = Number(returnDoc.totalAmount) || 0;
    const currentBalance = await this.getSupplierBalance(companyId, supplierId, { bypassCache: true });
    const transaction = new APTransactionLedger({
      company: companyId,
      supplier: supplierId,
      transactionType: 'supplier_refund_received',
      transactionDate: returnDoc.refundedAt || new Date(),
      referenceNo: returnDoc.bankRefundReference || returnDoc.referenceNo,
      description: `Supplier refund received for purchase return ${returnDoc.referenceNo}`,
      amount,
      direction: 'increase',
      supplierBalanceAfter: currentBalance + amount,
      grn: returnDoc.grn,
      sourceType,
      sourceId: returnDoc._id,
      sourceReference: returnDoc.referenceNo,
      createdBy: userId,
      reconciliationStatus: 'verified',
      metadata: { refundMethod: returnDoc.refundMethod },
    });
    await transaction.save();
    await this.invalidateSupplierBalanceCache(companyId, supplierId);
    return transaction;
  }

  /**
   * Record a payment posted (decreases AP)
   */
  static async recordPaymentPosted(payment, userId) {
    const companyId = payment.company;
    const supplierId = payment.supplier;
    const amount = parseFloat(payment.amountPaid) || 0;

    const existing = await APTransactionLedger.findOne({ company: companyId, sourceType: 'ap_payment', sourceId: payment._id });
    if (existing) return existing;

    // Get current supplier balance
    const currentBalance = await this.getSupplierBalance(companyId, supplierId);
    const newBalance = currentBalance - amount;

    // Create ledger entry for payment
    const transaction = new APTransactionLedger({
      company: companyId,
      supplier: supplierId,
      transactionType: 'payment_posted',
      transactionDate: payment.paymentDate || new Date(),
      referenceNo: payment.referenceNo || payment.reference,
      description: `Payment ${payment.referenceNo || payment.reference} posted - Payment: ${amount.toFixed(2)}`,
      amount: amount,
      direction: 'decrease',
      supplierBalanceAfter: newBalance,
      sourceType: 'ap_payment',
      sourceId: payment._id,
      sourceReference: payment.referenceNo || payment.reference,
      createdBy: userId,
      reconciliationStatus: 'verified',
      metadata: {
        paymentMethod: payment.paymentMethod,
        unallocatedAmount: payment.unallocatedAmount || 0
      }
    });

    await transaction.save();

    // Allocations explain which liabilities were settled; they are not separate
    // cash/AP events. Recording them as decreases here double-counted payments.

    // Invalidate cache
    await this.invalidateSupplierBalanceCache(companyId, supplierId);

    return transaction;
  }

  /**
   * Record a payment reversal (increases AP back)
   */
  static async recordPaymentReversed(payment, userId, reason) {
    const companyId = payment.company;
    const supplierId = payment.supplier;
    const amount = parseFloat(payment.amountPaid) || 0;

    // Get current supplier balance
    const existing = await APTransactionLedger.findOne({ company: companyId, sourceType: 'ap_payment_reversal', sourceId: payment._id });
    if (existing) return existing;
    const currentBalance = await this.getSupplierBalance(companyId, supplierId);
    const newBalance = currentBalance + amount;

    // Create reversal entry
    const transaction = new APTransactionLedger({
      company: companyId,
      supplier: supplierId,
      transactionType: 'payment_reversed',
      transactionDate: new Date(),
      referenceNo: payment.referenceNo || payment.reference,
      description: `Payment ${payment.referenceNo || payment.reference} reversed: ${reason || 'Reversed'}`,
      amount: amount,
      direction: 'increase',
      supplierBalanceAfter: newBalance,
      sourceType: 'ap_payment_reversal',
      sourceId: payment._id,
      sourceReference: payment.referenceNo || payment.reference,
      createdBy: userId,
      reconciliationStatus: 'verified',
      metadata: {
        reversalReason: reason,
        originalPaymentDate: payment.paymentDate
      }
    });

    await transaction.save();

    // Invalidate cache
    await this.invalidateSupplierBalanceCache(companyId, supplierId);

    return transaction;
  }

  /**
   * Get current supplier balance
   */
  static async getSupplierBalance(companyId, supplierId, { bypassCache = false } = {}) {
    const cacheKey = `ap_supplier_balance_${companyId}_${supplierId}`;
    if (!bypassCache) {
      const cached = await cacheService.get(cacheKey);
      if (cached !== null) {
        return parseFloat(cached);
      }
    }

    // Balance is the sum of posted source events, not the most recently dated
    // snapshot: backdated invoices/payments must not rewrite the current AP.
    // Historical allocation detail rows duplicated the payment decrease, so
    // exclude that legacy detail event from the authoritative balance.
    const rows = await dbClient().$queryRawUnsafe(`
      SELECT COALESCE(SUM(CASE WHEN direction = 'increase' THEN amount ELSE -amount END), 0)::double precision AS balance
        FROM ap_transaction_ledger
       WHERE company_id = $1 AND supplier_id = $2
         AND transaction_type <> 'payment_allocation'
    `, String(companyId), String(supplierId));
    const balance = Number(rows?.[0]?.balance || 0);

    // Cache for 5 minutes
    if (!bypassCache) await cacheService.set(cacheKey, balance.toString(), 300);

    return balance;
  }

  /**
   * Invalidate supplier balance cache
   */
  static async invalidateSupplierBalanceCache(companyId, supplierId) {
    const cacheKey = `ap_supplier_balance_${companyId}_${supplierId}`;
    await cacheService.del(cacheKey);
  }

  /**
   * Get transaction history for a supplier
   */
  static async getSupplierHistory(companyId, supplierId, options = {}) {
    return APTransactionLedger.getSupplierHistory(companyId, supplierId, options);
  }

  /**
   * Verify data integrity for AP
   */
  static async verifyIntegrity(companyId, options = {}) {
    const { supplierId, startDate, endDate } = options;

    // Use the model's static method
    const ledgerVerification = await APTransactionLedger.verifyIntegrity(companyId, {
      supplierId,
      startDate,
      endDate
    });

    // Additional verification: Compare ledger totals with actual supplier balances
    const discrepancies = [...(ledgerVerification.discrepancies || [])];

    // Check supplier balances
    const params = [String(companyId)];
    let supplierWhere = '';
    if (supplierId) {
      params.push(String(supplierId));
      supplierWhere = 'AND s.id = $2';
    }
    const supplierRows = await dbClient().$queryRawUnsafe(`
      SELECT s.id AS "supplierId", s.name AS "supplierName",
             COALESCE(latest.supplier_balance_after, 0)::double precision AS "ledgerBalance",
             COALESCE(grn_totals.actual_balance, 0)::double precision AS "actualBalance"
        FROM suppliers s
        LEFT JOIN LATERAL (
          SELECT supplier_balance_after
            FROM ap_transaction_ledger atl
           WHERE atl.company_id = s.company_id AND atl.supplier_id = s.id
           ORDER BY atl.transaction_date DESC, atl.created_at DESC, atl.id DESC
           LIMIT 1
        ) latest ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(balance), 0) AS actual_balance
            FROM goods_received_notes g
           WHERE g.company_id = s.company_id AND g.supplier_id = s.id AND g.balance > 0
        ) grn_totals ON TRUE
       WHERE s.company_id = $1 ${supplierWhere}`,
      ...params,
    );

    for (const supplier of supplierRows) {
      const ledgerBalance = Number(supplier.ledgerBalance || 0);
      const actualBalance = Number(supplier.actualBalance || 0);
      if (Math.abs(ledgerBalance - actualBalance) > 0.01) {
        discrepancies.push({
          type: 'supplier_balance_mismatch',
          supplierId: supplier.supplierId,
          supplierName: supplier.supplierName,
          ledgerBalance: ledgerBalance.toFixed(2),
          actualBalance: actualBalance.toFixed(2),
          difference: (ledgerBalance - actualBalance).toFixed(2)
        });
      }
    }

    return {
      verified: discrepancies.length === 0,
      discrepancyCount: discrepancies.length,
      discrepancies
    };
  }

  /**
   * Reconcile and correct discrepancies
   */
  static async reconcileAndCorrect(companyId, userId, options = {}) {
    const verification = await this.verifyIntegrity(companyId, options);

    if (verification.verified) {
      // No discrepancies found - mark all pending transactions as verified
      const updateResult = await APTransactionLedger.updateMany(
        {
          company: companyId,
          reconciliationStatus: 'pending'
        },
        {
          reconciliationStatus: 'verified',
          verifiedAt: new Date()
        }
      );
      return {
        corrected: 0,
        verified: updateResult.modifiedCount || 0,
        message: `No discrepancies found. ${updateResult.modifiedCount || 0} transactions marked as verified.`
      };
    }

    let corrected = 0;
    const corrections = [];

    // Process each discrepancy
    for (const disc of verification.discrepancies) {
      if (disc.type === 'supplier_balance_mismatch') {
        // Create adjustment transaction to reconcile
        const adjustmentAmount = parseFloat(disc.difference);
        const currentBalance = await this.getSupplierBalance(companyId, disc.supplierId);
        const newBalance = currentBalance - adjustmentAmount;

        await APTransactionLedger.create({
          company: companyId,
          supplier: disc.supplierId,
          transactionType: 'adjustment',
          transactionDate: new Date(),
          referenceNo: 'ADJ-' + Date.now(),
          description: `Reconciliation adjustment for supplier ${disc.supplierName}`,
          amount: Math.abs(adjustmentAmount),
          direction: adjustmentAmount > 0 ? 'decrease' : 'increase',
          supplierBalanceAfter: newBalance,
          sourceType: 'manual',
          sourceId: generateObjectId(),
          sourceReference: 'ADJ-' + Date.now(),
          createdBy: userId,
          reconciliationStatus: 'corrected',
          discrepancyDetails: disc
        });

        corrected++;
        corrections.push({
          supplierId: disc.supplierId,
          type: 'balance_adjustment',
          amount: adjustmentAmount
        });

        // Invalidate cache
        await this.invalidateSupplierBalanceCache(companyId, disc.supplierId);
      }
    }

    return {
      corrected,
      corrections,
      message: `${corrected} discrepancies corrected.`
    };
  }

  /**
   * Get dashboard stats
   */
  static async getDashboardStats(companyId) {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalTransactions,
      recentTransactions,
      pendingReconciliation,
      discrepancyCheck
    ] = await Promise.all([
      APTransactionLedger.countDocuments({ company: companyId }),
      APTransactionLedger.countDocuments({
        company: companyId,
        transactionDate: { $gte: thirtyDaysAgo }
      }),
      APTransactionLedger.countDocuments({
        company: companyId,
        reconciliationStatus: 'pending'
      }),
      this.verifyIntegrity(companyId)
    ]);

    // Get transaction type breakdown in PostgreSQL. The old compatibility
    // aggregate fetched the whole tenant ledger into Node before grouping.
    const typeBreakdown = await dbClient().$queryRaw`
      SELECT transaction_type AS "_id",
             COUNT(*)::int AS count,
             COALESCE(SUM(amount), 0)::double precision AS "totalAmount"
        FROM ap_transaction_ledger
       WHERE company_id = ${String(companyId)}
       GROUP BY transaction_type
       ORDER BY transaction_type`;


    // Get recent activity
    const recentActivity = await APTransactionLedger.find({ company: companyId })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('supplier', 'name code')
      .populate('grn', 'referenceNo')
      .populate('payment', 'referenceNo');

    return {
      stats: {
        totalTransactions,
        recentTransactions,
        pendingReconciliation,
        discrepancyCount: discrepancyCheck.discrepancyCount
      },
      typeBreakdown,
      recentActivity,
      integrity: discrepancyCheck
    };
  }

  /**
   * Get AP aging report with verification
   */
  static async getAgingWithVerification(companyId, options = {}) {
    const { supplierId, asOfDate } = options;
    const APService = require('./apService');

    const [agingReport, verification] = await Promise.all([
      APService.getAgingReport(companyId, { supplierId, asOfDate }),
      this.verifyIntegrity(companyId, { supplierId })
    ]);

    return {
      ...agingReport,
      verification: {
        verified: verification.verified,
        discrepancyCount: verification.discrepancyCount
      }
    };
  }
}

module.exports = APTrackingService;
