/**
 * Daily Reports Service
 * 
 * Generates daily operational reports for the Reports Hub.
 * All reports are read-only and scoped by company_id.
 * 
 * Reports:
 * 1. Daily Sales Summary
 * 2. Daily Purchases Summary
 * 3. Daily Cash Position
 * 4. Daily Stock Movement
 * 5. Daily AR Activity
 * 6. Daily AP Activity
 * 7. Daily Journal Entries Log
 * 8. Daily Tax Collected
 */

const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Purchase = require('../models/Purchase');
const GoodsReceivedNote = require('../models/GoodsReceivedNote');
const Supplier = require('../models/Supplier');
const { BankAccount, BankTransaction } = require('../models/BankAccount');
const JournalEntry = require('../models/JournalEntry');
const StockMovement = require('../models/StockMovement');
const ARReceipt = require('../models/ARReceipt');
const CreditNote = require('../models/CreditNote');
const APPayment = require('../models/APPayment');
const PurchaseReturn = require('../models/PurchaseReturn');
const Expense = require('../models/Expense');
const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));

function aggregateExpenseWithholdingTax(companyId, start, end) {
  return Expense.aggregate([
    {
      $match: {
        company: toObjectId(companyId),
        $or: [
          { expense_date: { $gte: new Date(start), $lte: new Date(end) } },
          { date: { $gte: new Date(start), $lte: new Date(end) } }
        ],
        withholdingTax: { $exists: true, $gt: 0 }
      }
    },
    { $group: { _id: null, total: { $sum: { $toDouble: '$withholdingTax' } }, count: { $sum: 1 } } }
  ]);
}

const toNumber = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === 'object') {
    if (value.$numberDecimal !== undefined) return toNumber(value.$numberDecimal);
    if (typeof value.toString === 'function') return toNumber(value.toString());
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

// Get date range for a specific day
const getDateRange = (dateStr) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) {
    throw new Error('Date parameter must be in YYYY-MM-DD format');
  }
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid date parameter');
  }
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

class DailyReportsService {
  /**
   * 1. Daily Sales Summary
   * Shows total sales, invoices, cash vs credit, top products, discounts
   */
  static async getDailySalesSummary(companyId, dateStr) {
    const { start, end } = getDateRange(dateStr);
    
    // Aggregate sales data
    const salesData = await Invoice.aggregate([
      {
        $match: {
          company: toObjectId(companyId),
          invoiceDate: { $gte: new Date(start), $lte: new Date(end) },
          status: { $in: ['fully_paid', 'partially_paid', 'confirmed'] }
        }
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: { $toDouble: { $ifNull: ['$totalAmount', '$total'] } } },
          totalInvoices: { $sum: 1 },
          cashSales: {
            $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, { $toDouble: { $ifNull: ['$totalAmount', '$total'] } }, 0] }
          },
          creditSales: {
            $sum: { $cond: [{ $in: ['$paymentMethod', ['credit', 'on_account']] }, { $toDouble: { $ifNull: ['$totalAmount', '$total'] } }, 0] }
          },
          mobileMoneySales: {
            $sum: { $cond: [{ $eq: ['$paymentMethod', 'mobile_money'] }, { $toDouble: { $ifNull: ['$totalAmount', '$total'] } }, 0] }
          },
          bankTransferSales: {
            $sum: { $cond: [{ $eq: ['$paymentMethod', 'bank_transfer'] }, { $toDouble: { $ifNull: ['$totalAmount', '$total'] } }, 0] }
          },
          totalDiscount: { $sum: { $toDouble: { $ifNull: ['$discount', 0] } } },
          totalTax: { $sum: { $toDouble: { $ifNull: ['$taxAmount', 0] } } }
        }
      }
    ]);

    // Get top 5 selling products from the same confirmed invoices used by the report totals.
    const topProducts = await Invoice.aggregate([
      {
        $match: {
          company: toObjectId(companyId),
          invoiceDate: { $gte: new Date(start), $lte: new Date(end) },
          status: { $in: ['fully_paid', 'partially_paid', 'confirmed'] }
        }
      },
      { $unwind: '$lines' },
      {
        $group: {
          _id: '$lines.product',
          productName: { $first: { $ifNull: ['$lines.productName', '$lines.description'] } },
          productCode: { $first: '$lines.productCode' },
          totalQuantity: { $sum: { $toDouble: { $ifNull: ['$lines.qty', 0] } } },
          totalRevenue: { $sum: { $toDouble: { $ifNull: ['$lines.lineTotal', 0] } } }
        }
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'product'
        }
      },
      { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } }
    ]);

    const data = salesData[0] || {
      totalSales: 0,
      totalInvoices: 0,
      cashSales: 0,
      creditSales: 0,
      mobileMoneySales: 0,
      bankTransferSales: 0,
      totalDiscount: 0,
      totalTax: 0
    };

    return {
      reportName: 'Daily Sales Summary',
      date: dateStr,
      companyId,
      summary: {
        totalSales: data.totalSales,
        totalInvoices: data.totalInvoices,
        cashSales: data.cashSales,
        creditSales: data.creditSales,
        mobileMoneySales: data.mobileMoneySales,
        bankTransferSales: data.bankTransferSales,
        totalDiscount: data.totalDiscount,
        totalTax: data.totalTax,
        averageInvoiceValue: data.totalInvoices > 0 ? data.totalSales / data.totalInvoices : 0
      },
      topProducts: topProducts.map(p => ({
        productId: p._id,
        name: p.productName || p.product?.name || p.productCode || 'Unknown',
        quantity: p.totalQuantity,
        revenue: p.totalRevenue
      })),
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * 2. Daily Purchases Summary
   * Shows goods received, supplier invoices, purchase values
   */
  static async getDailyPurchasesSummary(companyId, dateStr) {
    const { start, end } = getDateRange(dateStr);
    
    // Get both direct purchases (by receivedDate) and GRN-based purchases
    const [purchaseData, grnData] = await Promise.all([
      // Direct purchases received on this date
      Purchase.aggregate([
        {
          $match: {
            company: toObjectId(companyId),
            $or: [
              { receivedDate: { $gte: new Date(start), $lte: new Date(end) } },
              { purchaseDate: { $gte: new Date(start), $lte: new Date(end) }, status: { $in: ['received', 'partial', 'paid'] } }
            ]
          }
        },
        {
          $group: {
            _id: null,
            totalPurchases: { $sum: { $toDouble: { $ifNull: ['$grandTotal', '$total'] } } },
            totalOrders: { $sum: 1 },
            totalTax: { $sum: { $toDouble: { $ifNull: ['$totalTax', 0] } } },
            totalDiscount: { $sum: { $toDouble: { $ifNull: ['$totalDiscount', 0] } } }
          }
        }
      ]),
      // GRN data - goods received on this date (only confirmed, not drafts)
      GoodsReceivedNote.aggregate([
        {
          $match: {
            company: toObjectId(companyId),
            receivedDate: { $gte: new Date(start), $lte: new Date(end) },
            status: 'confirmed'
          }
        },
        {
          $group: {
            _id: null,
            totalGRNs: { $sum: 1 },
            totalGRNAmount: { $sum: { $toDouble: '$totalAmount' } },
            totalItemsReceived: {
              $sum: {
                $sum: {
                  $map: {
                    input: { $ifNull: ['$lines', []] },
                    as: 'line',
                    in: { $toDouble: { $ifNull: ['$$line.qtyReceived', 0] } }
                  }
                }
              }
            }
          }
        }
      ])
    ]);

    // Get suppliers from GRN data (only confirmed)
    const grnSupplierData = await GoodsReceivedNote.aggregate([
      {
        $match: {
          company: toObjectId(companyId),
          receivedDate: { $gte: new Date(start), $lte: new Date(end) },
          status: 'confirmed'
        }
      },
      {
        $group: {
          _id: '$supplier',
          totalAmount: { $sum: { $toDouble: '$totalAmount' } },
          orderCount: { $sum: 1 }
        }
      }
    ]);

    // Get suppliers from direct purchases
    const purchaseSupplierData = await Purchase.aggregate([
      {
        $match: {
          company: toObjectId(companyId),
          $or: [
            { receivedDate: { $gte: new Date(start), $lte: new Date(end) } },
            { purchaseDate: { $gte: new Date(start), $lte: new Date(end) }, status: { $in: ['received', 'partial', 'paid'] } }
          ]
        }
      },
      {
        $group: {
          _id: '$supplier',
          totalAmount: { $sum: { $toDouble: { $ifNull: ['$grandTotal', '$total'] } } },
          orderCount: { $sum: 1 }
        }
      }
    ]);

    // Combine supplier data from both sources
    const supplierTotals = new Map();
    
    // Add GRN supplier data
    grnSupplierData.forEach(s => {
      if (s._id) {
        const key = s._id.toString();
        const existing = supplierTotals.get(key);
        if (existing) {
          existing.totalAmount += s.totalAmount;
          existing.orderCount += s.orderCount;
        } else {
          supplierTotals.set(key, {
            supplierId: s._id.toString(), // Store as string for consistency
            totalAmount: s.totalAmount,
            orderCount: s.orderCount
          });
        }
      }
    });
    
    // Add purchase supplier data
    purchaseSupplierData.forEach(s => {
      if (s._id) {
        const key = s._id.toString();
        const existing = supplierTotals.get(key);
        if (existing) {
          existing.totalAmount += s.totalAmount;
          existing.orderCount += s.orderCount;
        } else {
          supplierTotals.set(key, {
            supplierId: s._id.toString(), // Store as string for consistency
            totalAmount: s.totalAmount,
            orderCount: s.orderCount
          });
        }
      }
    });

    // Get supplier names
    const supplierIds = Array.from(supplierTotals.keys()).map(id => toObjectId(id));
    const suppliers = await Supplier.find({ _id: { $in: supplierIds } }, 'name');
    const supplierMap = new Map(suppliers.map(s => [s._id.toString(), s.name]));

    // Convert to array, sort by amount, and take top 5
    const topSuppliers = Array.from(supplierTotals.values())
      .sort((a, b) => b.totalAmount - a.totalAmount)
      .slice(0, 5);

    // Combine purchase and GRN data
    const pData = purchaseData[0] || {
      totalPurchases: 0,
      totalOrders: 0,
      totalTax: 0,
      totalDiscount: 0
    };

    const gData = grnData[0] || {
      totalGRNs: 0,
      totalGRNAmount: 0,
      totalItemsReceived: 0
    };

    // Add both direct purchases AND GRN amounts together
    const totalPurchases = pData.totalPurchases + gData.totalGRNAmount;
    const totalOrders = pData.totalOrders + gData.totalGRNs;

    return {
      reportName: 'Daily Purchases Summary',
      date: dateStr,
      companyId,
      summary: {
        totalPurchases,
        totalOrders,
        totalTax: pData.totalTax,
        totalDiscount: pData.totalDiscount,
        totalGRNs: gData.totalGRNs,
        totalItemsReceived: gData.totalItemsReceived,
        averageOrderValue: totalOrders > 0 ? totalPurchases / totalOrders : 0
      },
      topSuppliers: topSuppliers.map(s => ({
        supplierId: s.supplierId,
        name: supplierMap.get(s.supplierId) || 'Unknown',
        amount: s.totalAmount,
        orders: s.orderCount
      })),
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * 3. Daily Cash Position
   * Shows opening balance, receipts, payments, closing balance per account
   */
  static async getDailyCashPosition(companyId, dateStr) {
    const { start, end } = getDateRange(dateStr);
    
    // Get all bank accounts for the company
    const accounts = await BankAccount.find({ company: companyId, isActive: true });
    
    const accountPositions = await Promise.all(
      accounts.map(async (account) => {
        // Get opening balance (balance at start of day)
        const lastTransactionBefore = await BankTransaction.findOne({
          company: toObjectId(companyId),
          account: toObjectId(account._id),
          date: { $lt: new Date(start) }
        }).sort({ date: -1 });
        
        const openingBalance = lastTransactionBefore
          ? toNumber(lastTransactionBefore.balanceAfter)
          : toNumber(account.openingBalance);
        
        // Get today's transactions
        const transactions = await BankTransaction.aggregate([
          {
            $match: {
              company: toObjectId(companyId),
              account: toObjectId(account._id),
              date: { $gte: new Date(start), $lte: new Date(end) }
            }
          },
          {
            $group: {
              _id: '$type',
              total: { $sum: { $toDouble: { $ifNull: ['$amount', 0] } } },
              count: { $sum: 1 }
            }
          }
        ]);
        
        const receipts = transactions
          .filter(t => ['deposit', 'transfer_in', 'opening'].includes(t._id))
          .reduce((sum, t) => sum + toNumber(t.total), 0);
        const payments = transactions
          .filter(t => ['withdrawal', 'transfer_out', 'closing'].includes(t._id))
          .reduce((sum, t) => sum + toNumber(t.total), 0);
        const adjustments = transactions
          .filter(t => t._id === 'adjustment')
          .reduce((sum, t) => sum + toNumber(t.total), 0);
        
        const ledgerAccountId = account.ledgerAccountId || account.chartAccount || null;
        const journalEntries = ledgerAccountId ? await JournalEntry.aggregate([
          {
            $match: {
              company: toObjectId(companyId),
              status: 'posted',
              date: { $gte: new Date(start), $lte: new Date(end) },
              'lines.accountCode': ledgerAccountId
            }
          },
          { $unwind: '$lines' },
          {
            $match: {
              'lines.accountCode': ledgerAccountId
            }
          },
          {
            $group: {
              _id: null,
              totalDebit: { $sum: { $toDouble: { $ifNull: ['$lines.debit', 0] } } },
              totalCredit: { $sum: { $toDouble: { $ifNull: ['$lines.credit', 0] } } }
            }
          }
        ]) : [];
        
        const journalNet = transactions.length === 0
          ? toNumber(journalEntries[0]?.totalDebit) - toNumber(journalEntries[0]?.totalCredit)
          : 0;
        
        return {
          accountId: account._id,
          accountName: account.name,
          accountNumber: account.accountNumber,
          bankName: account.bankName,
          accountType: account.accountType,
          currency: account.currencyCode || account.currency,
          openingBalance,
          receipts,
          payments,
          journalNet,
          closingBalance: openingBalance + receipts - payments + adjustments + journalNet
        };
      })
    );
    
    const totals = accountPositions.reduce((acc, pos) => ({
      openingBalance: acc.openingBalance + pos.openingBalance,
      receipts: acc.receipts + pos.receipts,
      payments: acc.payments + pos.payments,
      closingBalance: acc.closingBalance + pos.closingBalance
    }), { openingBalance: 0, receipts: 0, payments: 0, closingBalance: 0 });

    return {
      reportName: 'Daily Cash Position',
      date: dateStr,
      companyId,
      summary: totals,
      accounts: accountPositions,
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * 4. Daily Stock Movement
   * Shows all stock-in and stock-out transactions
   */
  static async getDailyStockMovement(companyId, dateStr) {
    const { start, end } = getDateRange(dateStr);
    
    // Get all movements for the day
    const movements = await StockMovement.find({
      company: toObjectId(companyId),
      movementDate: { $gte: new Date(start), $lte: new Date(end) }
    })
    .populate('product', 'name sku')
    .populate('warehouse', 'name')
    .sort({ movementDate: 1 });
    
    // Group by type (type field is 'in'/'out', reason field has the specific reason)
    const stockIn = movements.filter(m => m.type === 'in' || ['purchase', 'return', 'transfer_in', 'initial_stock', 'audit_surplus'].includes(m.reason));
    const stockOut = movements.filter(m => m.type === 'out' || ['sale', 'damage', 'loss', 'theft', 'expired', 'transfer_out', 'audit_shortage', 'dispatch'].includes(m.reason));
    
    // Calculate totals
    const movementValue = (m) => toNumber(m.totalCost) || (toNumber(m.quantity) * toNumber(m.unitCost));
    const totalIn = stockIn.reduce((sum, m) => sum + movementValue(m), 0);
    const totalOut = stockOut.reduce((sum, m) => sum + movementValue(m), 0);
    
    // Get product running balances
    const productMovements = await StockMovement.aggregate([
      {
        $match: {
          company: toObjectId(companyId),
          movementDate: { $lte: new Date(end) }
        }
      },
      {
        $group: {
          _id: '$product',
          runningBalance: {
            $sum: {
              $cond: [
                { $eq: ['$type', 'in'] },
                { $toDouble: { $ifNull: ['$quantity', 0] } },
                { $multiply: [{ $toDouble: { $ifNull: ['$quantity', 0] } }, -1] }
              ]
            }
          }
        }
      }
    ]);
    
    const balanceMap = new Map(productMovements.map(p => [p._id?.toString(), p.runningBalance]));
    
    return {
      reportName: 'Daily Stock Movement',
      date: dateStr,
      companyId,
      summary: {
        totalMovements: movements.length,
        stockInCount: stockIn.length,
        stockOutCount: stockOut.length,
        totalInValue: totalIn,
        totalOutValue: totalOut,
        netMovement: totalIn - totalOut
      },
      movements: movements.map(m => ({
        movementId: m._id,
        productId: m.product?._id,
        productName: m.product?.name || 'Unknown',
        sku: m.product?.sku,
        warehouse: m.warehouse?.name || 'Unknown',
        type: m.type,
        reason: m.reason,
        quantity: toNumber(m.quantity),
        unitCost: toNumber(m.unitCost),
        totalValue: movementValue(m),
        reference: m.referenceNumber,
        notes: m.notes,
        runningBalance: toNumber(m.newStock) || balanceMap.get(m.product?._id?.toString()) || 0,
        date: m.movementDate
      })),
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * 5. Daily Accounts Receivable Activity
   * Shows new invoices, payments received, credit notes
   */
  static async getDailyARActivity(companyId, dateStr) {
    const { start, end } = getDateRange(dateStr);
    
    // Fetch all data in parallel with optimized projections and lean()
    const [newInvoices, paymentsReceived, creditNotes, invoiceTotals] = await Promise.all([
      // New invoices - only fetch needed fields
      Invoice.find({
        company: toObjectId(companyId),
        invoiceDate: { $gte: new Date(start), $lte: new Date(end) },
        status: { $in: ['confirmed', 'partially_paid', 'fully_paid'] }
      }, { 
        referenceNo: 1, invoiceDate: 1, totalAmount: 1, total: 1,
        status: 1, client: 1 
      })
      .populate('client', 'name')
      .lean(),
      
      // Payments received
      ARReceipt.find({
        company: toObjectId(companyId),
        receiptDate: { $gte: new Date(start), $lte: new Date(end) },
        status: 'posted'
      }, {
        referenceNo: 1, receiptDate: 1, amountReceived: 1,
        paymentMethod: 1, client: 1
      })
      .populate('client', 'name')
      .lean(),
      
      // Credit notes
      CreditNote.find({
        company: toObjectId(companyId),
        creditDate: { $gte: new Date(start), $lte: new Date(end) },
        status: { $in: ['confirmed', 'issued', 'applied', 'partially_refunded', 'refunded'] }
      }, {
        referenceNo: 1, creditNoteNumber: 1, creditDate: 1, totalAmount: 1, total: 1,
        reason: 1, status: 1, client: 1, invoice: 1
      })
      .populate('client', 'name')
      .populate('invoice', 'referenceNo')
      .lean(),
      
      // Use aggregation for totals (runs on DB server, much faster)
      Invoice.aggregate([
        { 
          $match: { 
            company: toObjectId(companyId),
            invoiceDate: { $gte: new Date(start), $lte: new Date(end) },
            status: { $in: ['confirmed', 'partially_paid', 'fully_paid'] }
          } 
        },
        { 
          $group: { 
            _id: null, 
            total: { $sum: { $toDouble: { $ifNull: ['$totalAmount', '$total'] } } } 
          } 
        }
      ])
    ]);
    
    // Calculate totals using aggregation results + fallback to reduce for other models
    const newInvoicesTotal = invoiceTotals[0]?.total || 0;
    const paymentsTotal = paymentsReceived.reduce((sum, p) => sum + toNumber(p.amountReceived), 0);
    const creditNotesTotal = creditNotes.reduce((sum, cn) => sum + (toNumber(cn.totalAmount) || toNumber(cn.total)), 0);
    
    return {
      reportName: 'Daily Accounts Receivable Activity',
      date: dateStr,
      companyId,
      summary: {
        newInvoicesCount: newInvoices.length,
        newInvoicesTotal,
        paymentsCount: paymentsReceived.length,
        paymentsTotal,
        creditNotesCount: creditNotes.length,
        creditNotesTotal,
        netARChange: newInvoicesTotal - paymentsTotal - creditNotesTotal
      },
      newInvoices: newInvoices.map(inv => ({
        invoiceId: inv._id,
        invoiceNumber: inv.referenceNo,
        clientName: inv.client?.name || 'Unknown',
        date: inv.invoiceDate,
        total: toNumber(inv.totalAmount) || toNumber(inv.total),
        status: inv.status
      })),
      paymentsReceived: paymentsReceived.map(p => ({
        receiptId: p._id,
        receiptNumber: p.referenceNo,
        clientName: p.client?.name || 'Unknown',
        invoiceNumber: '',
        date: p.receiptDate,
        amount: toNumber(p.amountReceived),
        paymentMethod: p.paymentMethod
      })),
      creditNotes: creditNotes.map(cn => ({
        creditNoteId: cn._id,
        creditNoteNumber: cn.creditNoteNumber || cn.referenceNo,
        clientName: cn.client?.name || 'Unknown',
        invoiceNumber: cn.invoice?.referenceNo || '',
        date: cn.creditDate,
        total: toNumber(cn.totalAmount) || toNumber(cn.total),
        reason: cn.reason
      })),
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * 6. Daily Accounts Payable Activity
   * Shows new bills, payments made, debit notes
   */
  static async getDailyAPActivity(companyId, dateStr) {
    const { start, end } = getDateRange(dateStr);
    
    // Fetch all data in parallel with optimized projections and lean()
    const [newBills, paymentsMade, purchaseReturns, purchaseTotals] = await Promise.all([
      // New bills (purchases) - only fetch needed fields
      Purchase.find({
        company: toObjectId(companyId),
        purchaseDate: { $gte: new Date(start), $lte: new Date(end) },
        status: { $in: ['received', 'partial', 'paid'] }
      }, {
        purchaseNumber: 1, purchaseDate: 1, grandTotal: 1, total: 1,
        status: 1, supplier: 1
      })
      .populate('supplier', 'name')
      .lean(),
      
      // Payments made
      APPayment.find({
        company: toObjectId(companyId),
        paymentDate: { $gte: new Date(start), $lte: new Date(end) },
        status: 'posted'
      }, {
        referenceNo: 1, paymentDate: 1, amountPaid: 1,
        paymentMethod: 1, supplier: 1
      })
      .populate('supplier', 'name')
      .lean(),
      
      // Purchase returns (debit notes)
      PurchaseReturn.find({
        company: toObjectId(companyId),
        returnDate: { $gte: new Date(start), $lte: new Date(end) },
        status: 'confirmed'
      }, {
        referenceNo: 1, returnDate: 1, totalAmount: 1,
        reason: 1, supplier: 1, grn: 1
      })
      .populate('supplier', 'name')
      .populate('grn', 'referenceNo')
      .lean(),
      
      // Use aggregation for purchase totals (runs on DB server)
      Purchase.aggregate([
        {
          $match: {
            company: toObjectId(companyId),
            purchaseDate: { $gte: new Date(start), $lte: new Date(end) },
            status: { $in: ['received', 'partial', 'paid'] }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: { $toDouble: { $ifNull: ['$grandTotal', '$total'] } } }
          }
        }
      ])
    ]);
    
    // Calculate totals using aggregation results + simple reduce for others
    const newBillsTotal = purchaseTotals[0]?.total || 0;
    const paymentsTotal = paymentsMade.reduce((sum, p) => sum + toNumber(p.amountPaid), 0);
    const returnsTotal = purchaseReturns.reduce((sum, pr) => sum + toNumber(pr.totalAmount), 0);
    
    return {
      reportName: 'Daily Accounts Payable Activity',
      date: dateStr,
      companyId,
      summary: {
        newBillsCount: newBills.length,
        newBillsTotal,
        paymentsCount: paymentsMade.length,
        paymentsTotal,
        returnsCount: purchaseReturns.length,
        returnsTotal,
        netAPChange: newBillsTotal - paymentsTotal - returnsTotal
      },
      newBills: newBills.map(bill => ({
        purchaseId: bill._id,
        purchaseNumber: bill.purchaseNumber,
        supplierName: bill.supplier?.name || 'Unknown',
        date: bill.purchaseDate,
        total: toNumber(bill.grandTotal) || toNumber(bill.total),
        status: bill.status
      })),
      paymentsMade: paymentsMade.map(p => ({
        paymentId: p._id,
        paymentNumber: p.referenceNo,
        supplierName: p.supplier?.name || 'Unknown',
        purchaseNumber: '',
        date: p.paymentDate,
        amount: toNumber(p.amountPaid),
        paymentMethod: p.paymentMethod
      })),
      purchaseReturns: purchaseReturns.map(pr => ({
        returnId: pr._id,
        returnNumber: pr.referenceNo,
        supplierName: pr.supplier?.name || 'Unknown',
        purchaseNumber: pr.grn?.referenceNo || '',
        date: pr.returnDate,
        total: toNumber(pr.totalAmount),
        reason: pr.reason
      })),
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * 7. Daily Journal Entries Log
   * Shows every journal entry posted that day
   */
  static async getDailyJournalEntries(companyId, dateStr) {
    const { start, end } = getDateRange(dateStr);
    
    const entries = await JournalEntry.find({
      company: toObjectId(companyId),
      date: { $gte: new Date(start), $lte: new Date(end) },
      status: 'posted'
    })
    .populate('createdBy', 'firstName lastName')
    .sort({ createdAt: 1 });
    
    return {
      reportName: 'Daily Journal Entries Log',
      date: dateStr,
      companyId,
      summary: {
        totalEntries: entries.length,
        totalDebits: entries.reduce((sum, e) => sum + e.lines.reduce((ls, l) => {
          return ls + toNumber(l.debit);
        }, 0), 0),
        totalCredits: entries.reduce((sum, e) => sum + e.lines.reduce((ls, l) => {
          return ls + toNumber(l.credit);
        }, 0), 0)
      },
      entries: entries.map(entry => ({
        entryId: entry._id,
        entryNumber: entry.entryNumber,
        date: entry.date,
        description: entry.description,
        reference: entry.reference,
        postedBy: entry.createdBy ? `${entry.createdBy.firstName} ${entry.createdBy.lastName}` : 'System',
        totalDebit: toNumber(entry.totalDebit) || entry.lines.reduce((sum, l) => sum + toNumber(l.debit), 0),
        totalCredit: toNumber(entry.totalCredit) || entry.lines.reduce((sum, l) => sum + toNumber(l.credit), 0),
        lines: entry.lines.map(line => ({
          accountCode: line.accountCode,
          accountName: line.accountName,
          debit: toNumber(line.debit),
          credit: toNumber(line.credit),
          description: line.description
        }))
      })),
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * 8. Daily Tax Collected
   * Shows output VAT from sales and withholding tax
   */
  static async getDailyTaxCollected(companyId, dateStr) {
    const { start, end } = getDateRange(dateStr);
    
    // Get tax data from invoices - use taxAmount (actual field), not taxTotal (alias)
    const [invoiceTax, creditNoteTax, invoiceWHT, purchaseWHT, expenseWHT] = await Promise.all([
      Invoice.aggregate([
        {
          $match: {
            company: toObjectId(companyId),
            invoiceDate: { $gte: new Date(start), $lte: new Date(end) },
            status: { $in: ['fully_paid', 'partially_paid', 'confirmed'] }
          }
        },
        {
          $group: {
            _id: null,
            totalTax: { $sum: { $toDouble: { $ifNull: ['$taxAmount', 0] } } },
            subtotal: { $sum: { $toDouble: { $ifNull: ['$subtotal', 0] } } },
            totalDiscount: { $sum: { $toDouble: { $ifNull: ['$totalDiscount', '$discount'] } } },
            total: { $sum: { $toDouble: { $ifNull: ['$totalAmount', '$total'] } } },
            invoiceCount: { $sum: 1 }
          }
        }
      ]),
      CreditNote.aggregate([
        {
          $match: {
            company: toObjectId(companyId),
            creditDate: { $gte: new Date(start), $lte: new Date(end) },
            status: { $in: ['confirmed', 'issued', 'applied', 'partially_refunded', 'refunded'] }
          }
        },
        {
          $group: {
            _id: null,
            totalTax: { $sum: { $toDouble: { $ifNull: ['$taxAmount', 0] } } },
            total: { $sum: { $toDouble: { $ifNull: ['$totalAmount', 0] } } },
            noteCount: { $sum: 1 }
          }
        }
      ]),
      Invoice.aggregate([
        {
          $match: {
            company: toObjectId(companyId),
            invoiceDate: { $gte: new Date(start), $lte: new Date(end) },
            status: { $in: ['fully_paid', 'partially_paid', 'confirmed'] },
            withholdingTax: { $exists: true, $gt: 0 }
          }
        },
        { $group: { _id: null, total: { $sum: { $toDouble: '$withholdingTax' } }, count: { $sum: 1 } } }
      ]),
      Purchase.aggregate([
        {
          $match: {
            company: toObjectId(companyId),
            purchaseDate: { $gte: new Date(start), $lte: new Date(end) },
            status: { $in: ['received', 'partial', 'paid'] },
            withholdingTax: { $exists: true, $gt: 0 }
          }
        },
        { $group: { _id: null, total: { $sum: { $toDouble: '$withholdingTax' } }, count: { $sum: 1 } } }
      ]),
      aggregateExpenseWithholdingTax(companyId, start, end)
    ]);
    
    // Get tax breakdown by tax code from invoice lines
    const taxBreakdown = await Invoice.aggregate([
      {
        $match: {
          company: toObjectId(companyId),
          invoiceDate: { $gte: new Date(start), $lte: new Date(end) },
          status: { $in: ['fully_paid', 'partially_paid', 'confirmed'] }
        }
      },
      { $unwind: { path: '$lines', preserveNullAndEmptyArrays: true } },
      {
        $match: {
          'lines.taxCode': { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: '$lines.taxCode',
          taxCode: { $first: '$lines.taxCode' },
          taxRate: { $first: '$lines.taxRate' },
          taxableAmount: {
            $sum: {
              $subtract: [
                { $toDouble: { $ifNull: ['$lines.lineSubtotal', 0] } },
                {
                  $multiply: [
                    { $toDouble: { $ifNull: ['$lines.lineSubtotal', 0] } },
                    { $divide: [{ $toDouble: { $ifNull: ['$lines.discountPct', 0] } }, 100] }
                  ]
                }
              ]
            }
          },
          taxAmount: {
            $sum: { $toDouble: { $ifNull: ['$lines.lineTax', 0] } }
          }
        }
      },
      { $sort: { taxRate: 1 } }
    ]);
    
    const taxData = invoiceTax[0] || { totalTax: 0, subtotal: 0, totalDiscount: 0, total: 0, invoiceCount: 0 };
    const reversalData = creditNoteTax[0] || { totalTax: 0, total: 0, noteCount: 0 };
    const taxableSales = Math.max(0, toNumber(taxData.subtotal) - toNumber(taxData.totalDiscount));
    const totalOutputVAT = Math.max(0, toNumber(taxData.totalTax) - toNumber(reversalData.totalTax));
    const withholdingTaxCollected = toNumber(invoiceWHT[0]?.total);
    const withholdingTaxPaid = toNumber(purchaseWHT[0]?.total) + toNumber(expenseWHT[0]?.total);
    
    return {
      reportName: 'Daily Tax Collected',
      date: dateStr,
      companyId,
      summary: {
        totalOutputVAT,
        grossOutputVAT: toNumber(taxData.totalTax),
        outputVATReversed: toNumber(reversalData.totalTax),
        taxableSales,
        totalSales: toNumber(taxData.total),
        exemptSales: Math.max(0, toNumber(taxData.total) - taxableSales - toNumber(taxData.totalTax)),
        withholdingTaxCollected,
        withholdingTaxPaid,
        netWithholdingTax: withholdingTaxCollected - withholdingTaxPaid,
        invoiceCount: toNumber(taxData.invoiceCount),
        creditNoteCount: toNumber(reversalData.noteCount)
      },
      taxBreakdown: taxBreakdown.map(t => ({
        taxCode: t.taxCode || 'EXEMPT',
        taxRate: t.taxRate || 0,
        taxableAmount: toNumber(t.taxableAmount),
        taxAmount: toNumber(t.taxAmount)
      })),
      withholdingBreakdown: [
        { taxType: 'Sales WHT Collected', source: 'Invoices', count: toNumber(invoiceWHT[0]?.count), amount: withholdingTaxCollected },
        { taxType: 'Purchase WHT Withheld', source: 'Purchases', count: toNumber(purchaseWHT[0]?.count), amount: toNumber(purchaseWHT[0]?.total) },
        { taxType: 'Expense WHT Withheld', source: 'Expenses', count: toNumber(expenseWHT[0]?.count), amount: toNumber(expenseWHT[0]?.total) }
      ].filter(item => item.amount > 0 || item.count > 0),
      generatedAt: new Date().toISOString()
    };
  }
}

module.exports = DailyReportsService;
