const { dbClient } = require('../lib/prisma');
const APPayment = require("../models/APPayment");
const APPaymentAllocation = require("../models/APPaymentAllocation");
const GoodsReceivedNote = require("../models/GoodsReceivedNote");
const Supplier = require("../models/Supplier");
const Purchase = require("../models/Purchase");
const APTrackingService = require("./apTrackingService");
const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");

/**
 * AP Service - Handles Accounts Payable operations
 * Following the rules:
 * - All money: DECIMAL(18,2)
 * - All rates/costs: DECIMAL(18,6)
 * - API money responses: always strings
 * - Reference numbers: DB sequences, zero-padded to 5 digits per year
 * - Posted entries: immutable (corrections via reversal only)
 */

// AP accounts payable code
const AP_ACCOUNT_CODE = "2000"; // Accounts Payable (was incorrectly set to 2100 = VAT Payable)

class APService {
  /**
   * Create a new AP payment (draft status)
   */
  static async getAgingReport(companyId, options = {}) {
    const { supplierId, asOfDate } = options;
    const asOf = asOfDate ? new Date(asOfDate) : new Date();
    if (Number.isNaN(asOf.getTime())) throw new Error('Invalid asOfDate');
    const today = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
    const params = [String(companyId), today];
    const supplierClause = supplierId
      ? (() => { params.push(String(supplierId)); return `AND supplier_id = $${params.length}`; })()
      : '';

    const rows = await dbClient().$queryRawUnsafe(`
      WITH grn_balances AS (
        SELECT g.supplier_id,
               s.name AS supplier_name,
               GREATEST(g.balance - COALESCE(SUM(a.amount_allocated), 0), 0)::double precision AS balance,
               COALESCE(g.payment_due_date, g.received_date)::date AS due_date
          FROM goods_received_notes g
          JOIN suppliers s ON s.id = g.supplier_id
          LEFT JOIN ap_payment_allocations a
            ON a.grn_id = g.id AND a.company_id = g.company_id
         WHERE g.company_id = $1
           AND g.payment_status IN ('pending', 'partially_paid')
           AND g.balance > 0
           ${supplierClause}
         GROUP BY g.id, g.supplier_id, s.name, g.balance, g.payment_due_date, g.received_date
      ), purchase_balances AS (
        SELECT p.supplier_id,
               s.name AS supplier_name,
               GREATEST(
                 p.total_amount - COALESCE((
                   SELECT SUM(COALESCE((payment ->> 'amount')::numeric, 0))
                     FROM jsonb_array_elements(COALESCE(p.payments, '[]'::jsonb)) AS payment
                 ), 0),
                 0
               )::double precision AS balance,
               COALESCE(p.supplier_invoice_date, p.purchase_date)::date AS due_date
          FROM purchases p
          JOIN suppliers s ON s.id = p.supplier_id
         WHERE p.company_id = $1
           AND p.status NOT IN ('paid', 'cancelled', 'draft')
           AND p.total_amount > 0
           ${supplierClause}
      ), eligible AS (
        SELECT * FROM grn_balances WHERE balance > 0
        UNION ALL
        SELECT * FROM purchase_balances WHERE balance > 0
      )
      SELECT supplier_id AS "supplierId", supplier_name AS "supplierName",
             COALESCE(SUM(CASE WHEN due_date >= $2::date THEN balance ELSE 0 END), 0)::double precision AS current,
             COALESCE(SUM(CASE WHEN due_date BETWEEN ($2::date - INTERVAL '30 days') AND ($2::date - INTERVAL '1 day') THEN balance ELSE 0 END), 0)::double precision AS "1-30",
             COALESCE(SUM(CASE WHEN due_date BETWEEN ($2::date - INTERVAL '60 days') AND ($2::date - INTERVAL '31 days') THEN balance ELSE 0 END), 0)::double precision AS "31-60",
             COALESCE(SUM(CASE WHEN due_date BETWEEN ($2::date - INTERVAL '90 days') AND ($2::date - INTERVAL '61 days') THEN balance ELSE 0 END), 0)::double precision AS "61-90",
             COALESCE(SUM(CASE WHEN due_date < ($2::date - INTERVAL '90 days') THEN balance ELSE 0 END), 0)::double precision AS "90+"
        FROM eligible
       GROUP BY supplier_id, supplier_name
       ORDER BY SUM(balance) DESC, supplier_id`, ...params);

    const result = rows.map((row) => {
      const current = Number(row.current || 0);
      const oneToThirty = Number(row['1-30'] || 0);
      const thirtyOneToSixty = Number(row['31-60'] || 0);
      const sixtyOneToNinety = Number(row['61-90'] || 0);
      const overNinety = Number(row['90+'] || 0);
      return {
        supplier: { _id: row.supplierId, name: row.supplierName || 'Unknown' },
        current: current.toFixed(2),
        '1-30': oneToThirty.toFixed(2),
        '31-60': thirtyOneToSixty.toFixed(2),
        '61-90': sixtyOneToNinety.toFixed(2),
        '90+': overNinety.toFixed(2),
        totalBalance: (current + oneToThirty + thirtyOneToSixty + sixtyOneToNinety + overNinety).toFixed(2),
      };
    });

    return { success: true, asOfDate: today, data: result };
  }

  /**
   * Get supplier statement - full details: GRNs, payments, balance
   */
  static async getSupplierStatement(companyId, supplierId, options = {}) {
    const { startDate, endDate } = options;

    // Verify supplier
    const supplier = await Supplier.findOne({
      _id: supplierId,
      company: companyId,
    });
    if (!supplier) {
      throw new Error("Supplier not found");
    }

    // Build date filter
    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    // Get GRNs
    const grnQuery = { supplier: supplierId, company: companyId };
    if (startDate || endDate) {
      grnQuery.receivedDate = dateFilter;
    }
    const grns = await GoodsReceivedNote.find(grnQuery)
      .populate("createdBy", "name")
      .sort({ receivedDate: 1 });

    // Also include direct purchases for supplier statements
    const purchaseQuery = { supplier: supplierId, company: companyId };
    if (startDate || endDate) {
      // include purchases by receivedDate or purchaseDate
      purchaseQuery.$or = [
        { receivedDate: dateFilter },
        { purchaseDate: dateFilter },
      ];
    }
    const purchases = await Purchase.find(purchaseQuery)
      .populate("supplier", "name code")
      .sort({ purchaseDate: 1 });

    // Get payments and allocations for this supplier
    const payments = await APPayment.find({
      supplier: supplierId,
      company: companyId,
    }).sort({ paymentDate: -1 });

    const paymentIds = payments.map((p) => p._id);
    const allocations = await APPaymentAllocation.find({
      payment: { $in: paymentIds },
      company: companyId,
    }).populate("grn", "referenceNo totalAmount balance");

    // Build statement
    const statement = {
      supplier: {
        _id: supplier._id,
        name: supplier.name,
        code: supplier.code,
      },
      grns: [
        ...grns.map((grn) => ({
        id: grn._id,
        reference: grn.referenceNo,
        date: grn.receivedDate,
        dueDate: grn.paymentDueDate,
        total: parseFloat(grn.totalAmount || 0).toFixed(2),
        paid: parseFloat(grn.amountPaid || 0).toFixed(2),
        balance: parseFloat(grn.balance || 0).toFixed(2),
        status: grn.paymentStatus,
        })),
        // Append direct purchases
        ...purchases.map((p) => ({
          id: p._id,
          reference: p.purchaseNumber || p.supplierInvoiceNumber,
          date: p.receivedDate || p.purchaseDate,
          dueDate: null,
          total: parseFloat(p.grandTotal || p.roundedAmount || 0).toFixed(2),
          paid: parseFloat(p.amountPaid || 0).toFixed(2),
          balance: parseFloat(p.balance || 0).toFixed(2),
          status: p.status,
        })),
      ],
      payments: payments.map((pay) => ({
        id: pay._id,
        reference: pay.referenceNo,
        date: pay.paymentDate,
        amount: parseFloat(pay.amountPaid).toFixed(2),
        status: pay.status,
        allocations: allocations
          .filter((a) => a.payment.toString() === pay._id.toString())
          .map((a) => ({
            grnReference: a.grn?.referenceNo,
            amount: parseFloat(a.amountAllocated).toFixed(2),
          })),
      })),
    };

    // Calculate totals including both GRNs and direct purchases
    const allEntries = [
      ...grns.map((g) => ({ total: parseFloat(g.totalAmount || 0), paid: parseFloat(g.amountPaid || 0), balance: parseFloat(g.balance || 0) })),
      ...purchases.map((p) => ({ total: parseFloat(p.grandTotal || p.roundedAmount || 0), paid: parseFloat(p.amountPaid || 0), balance: parseFloat(p.balance || 0) })),
    ];

    const totalGRNs = allEntries.reduce((sum, e) => sum + (e.total || 0), 0);
    const totalPaid = allEntries.reduce((sum, e) => sum + (e.paid || 0), 0);
    const totalOutstanding = allEntries.reduce((sum, e) => sum + (e.balance || 0), 0);

    statement.summary = {
      totalGRNs: totalGRNs.toFixed(2),
      totalPaid: totalPaid.toFixed(2),
      totalOutstanding: totalOutstanding.toFixed(2),
      grnCount: allEntries.length,
    };

    return {
      success: true,
      data: statement,
    };
  }

  /**
   * Get payments with filters
   */
  
}

module.exports = APService;
