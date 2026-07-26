/**
 * Weekly Reports Service
 * Provides aggregated weekly data with performance optimizations
 */

const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const SalesOrder = require('../models/SalesOrder');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const Purchase = require('../models/Purchase');
const PurchaseOrder = require('../models/PurchaseOrder');
const GoodsReceivedNote = require('../models/GoodsReceivedNote');
const ARReceipt = require('../models/ARReceipt');
const APPayment = require('../models/APPayment');
const JournalEntry = require('../models/JournalEntry');
const ChartOfAccount = require('../models/ChartOfAccount');
const Payroll = require('../models/Payroll');
const PayrollRun = require('../models/PayrollRun');
const Employee = require('../models/Employee');
const { BankAccount, BankTransaction } = require('../models/BankAccount');

const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));

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

const formatLocalDate = (date) => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const CONFIRMED_INVOICE_STATUSES = ['fully_paid', 'partially_paid', 'confirmed'];
const ACTIVE_SALES_ORDER_STATUSES = ['confirmed', 'picking', 'packed', 'delivered', 'invoiced', 'closed'];

const invoiceMatchStage = (companyId, start, end) => ({
  company: toObjectId(companyId),
  invoiceDate: { $gte: start, $lte: end },
  status: { $in: CONFIRMED_INVOICE_STATUSES },
});

const salesOrderMatchStage = (companyId, start, end) => ({
  company: toObjectId(companyId),
  orderDate: { $gte: start, $lte: end },
  status: { $in: ACTIVE_SALES_ORDER_STATUSES },
});

class WeeklyReportsService {
  /**
   * Get week range (Monday to Sunday)
   * @param {string} weekStart - Week start date (Monday) in YYYY-MM-DD format
   * @returns {Object} start and end dates
   */
  static getWeekRange(weekStart) {
    // Parse date string as local date to avoid timezone issues
    const [year, month, day] = weekStart.split('-').map(Number);
    const start = new Date(year, month - 1, day, 0, 0, 0, 0);
    
    const end = new Date(year, month - 1, day + 6, 23, 59, 59, 999);
    
    const prevStart = new Date(year, month - 1, day - 7, 0, 0, 0, 0);
    
    const prevEnd = new Date(year, month - 1, day - 1, 23, 59, 59, 999);
    
    return { start, end, prevStart, prevEnd };
  }

  /**
   * Get default week (most recently completed Monday-to-Sunday)
   */
  static getDefaultWeek() {
    const today = new Date();
    const day = today.getDay(); // 0 = Sunday, 1 = Monday
    // Days from last Monday (if today is Monday, daysFromMonday = 0)
    const daysFromMonday = day === 0 ? 6 : day - 1;
    const lastMonday = new Date(today);
    lastMonday.setDate(today.getDate() - daysFromMonday);
    return formatLocalDate(lastMonday);
  }

  /**
   * 1. Weekly Sales Performance
   * Compare this week vs last week by value and volume
   */
  static async getWeeklySalesPerformance(companyId, weekStart) {
    const { start, end, prevStart, prevEnd } = this.getWeekRange(weekStart);
    
    // Run this week and last week queries in parallel
    const [
      thisWeekInvoices, lastWeekInvoices,
      thisWeekInvoiceItems, lastWeekInvoiceItems,
      thisWeekOrders, lastWeekOrders
    ] = await Promise.all([
      // This week invoices
      Invoice.aggregate([
        { $match: invoiceMatchStage(companyId, start, end) },
        {
          $group: {
            _id: null,
            totalSales: { $sum: { $toDouble: { $ifNull: ['$totalAmount', '$total'] } } },
            invoiceCount: { $sum: 1 }
          }
        }
      ]),
      // Last week invoices
      Invoice.aggregate([
        { $match: invoiceMatchStage(companyId, prevStart, prevEnd) },
        {
          $group: {
            _id: null,
            totalSales: { $sum: { $toDouble: { $ifNull: ['$totalAmount', '$total'] } } },
            invoiceCount: { $sum: 1 }
          }
        }
      ]),
      // Items sold this week (from invoice lines)
      Invoice.aggregate([
        { $match: invoiceMatchStage(companyId, start, end) },
        { $unwind: { path: '$lines', preserveNullAndEmptyArrays: false } },
        {
          $group: {
            _id: null,
            totalItems: { $sum: { $toDouble: { $ifNull: ['$lines.qty', 0] } } }
          }
        }
      ]),
      // Items sold last week
      Invoice.aggregate([
        { $match: invoiceMatchStage(companyId, prevStart, prevEnd) },
        { $unwind: { path: '$lines', preserveNullAndEmptyArrays: false } },
        {
          $group: {
            _id: null,
            totalItems: { $sum: { $toDouble: { $ifNull: ['$lines.qty', 0] } } }
          }
        }
      ]),
      // This week sales orders
      SalesOrder.aggregate([
        { $match: salesOrderMatchStage(companyId, start, end) },
        {
          $project: {
            _id: 1,
            totalQty: {
              $sum: {
                $map: {
                  input: { $ifNull: ['$lines', []] },
                  as: 'line',
                  in: { $toDouble: { $ifNull: ['$$line.qty', 0] } }
                }
              }
            }
          }
        },
        {
          $group: {
            _id: null,
            totalOrders: { $sum: 1 },
            totalItems: { $sum: '$totalQty' }
          }
        }
      ]),
      // Last week sales orders
      SalesOrder.aggregate([
        { $match: salesOrderMatchStage(companyId, prevStart, prevEnd) },
        {
          $project: {
            _id: 1,
            totalQty: {
              $sum: {
                $map: {
                  input: { $ifNull: ['$lines', []] },
                  as: 'line',
                  in: { $toDouble: { $ifNull: ['$$line.qty', 0] } }
                }
              }
            }
          }
        },
        {
          $group: {
            _id: null,
            totalOrders: { $sum: 1 },
            totalItems: { $sum: '$totalQty' }
          }
        }
      ])
    ]);
    
    const thisWeek = {
      sales: thisWeekInvoices[0]?.totalSales || 0,
      invoices: thisWeekInvoices[0]?.invoiceCount || 0,
      orders: thisWeekOrders[0]?.totalOrders || 0,
      items: thisWeekInvoiceItems[0]?.totalItems || 0
    };
    
    const lastWeek = {
      sales: lastWeekInvoices[0]?.totalSales || 0,
      invoices: lastWeekInvoices[0]?.invoiceCount || 0,
      orders: lastWeekOrders[0]?.totalOrders || 0,
      items: lastWeekInvoiceItems[0]?.totalItems || 0
    };
    
    // Calculate percentage changes
    const calculateChange = (current, previous) => {
      if (!previous) return current > 0 ? 100 : 0;
      return ((current - previous) / previous) * 100;
    };
    
    return {
      reportName: 'Weekly Sales Performance',
      weekStart: weekStart,
      weekEnd: formatLocalDate(end),
      thisWeek,
      lastWeek,
      changes: {
        salesPercent: calculateChange(thisWeek.sales, lastWeek.sales),
        invoicesPercent: calculateChange(thisWeek.invoices, lastWeek.invoices),
        ordersPercent: calculateChange(thisWeek.orders, lastWeek.orders),
        itemsPercent: calculateChange(thisWeek.items, lastWeek.items)
      }
    };
  }

  /**
   * 2. Weekly Inventory Reorder Report
   * Products below reorder point
   */
  static async getWeeklyInventoryReorder(companyId) {
    // Get all products and filter in JS to handle Decimal128 properly
    const allProducts = await Product.find({
      company: toObjectId(companyId),
      status: { $ne: 'discontinued' }
    }, {
      name: 1,
      sku: 1,
      currentStock: 1,
      reorderPoint: 1,
      lowStockThreshold: 1,
      reorderQuantity: 1,
      unit: 1,
      preferredSupplier: 1
    })
    .populate('preferredSupplier', 'name')
    .lean();
    
    // Filter products where currentStock < reorderPoint
    const productsNeedingReorder = allProducts.filter(p => {
      const stock = toNumber(p.currentStock);
      const reorderPoint = toNumber(p.reorderPoint) || toNumber(p.lowStockThreshold);
      return stock < reorderPoint;
    });

    // Group by urgency
    const critical = [];
    const warning = [];
    
    productsNeedingReorder.forEach(p => {
      const stock = toNumber(p.currentStock);
      const reorderPoint = toNumber(p.reorderPoint) || toNumber(p.lowStockThreshold);
      const deficit = reorderPoint - stock;
      const item = {
        productId: p._id,
        name: p.name,
        sku: p.sku,
        currentStock: stock,
        reorderPoint: reorderPoint,
        deficit: deficit,
        suggestedOrder: toNumber(p.reorderQuantity) || deficit,
        unit: p.unit,
        supplier: p.preferredSupplier?.name || 'No preferred supplier'
      };
      
      if (stock === 0) {
        critical.push(item);
      } else {
        warning.push(item);
      }
    });
    
    return {
      reportName: 'Weekly Inventory Reorder Report',
      generatedAt: new Date().toISOString(),
      summary: {
        totalProducts: productsNeedingReorder.length,
        criticalCount: critical.length,
        warningCount: warning.length
      },
      critical: critical.sort((a, b) => b.deficit - a.deficit),
      warning: warning.sort((a, b) => b.deficit - a.deficit)
    };
  }

  static async getWeeklySupplierPerformance(companyId, weekStart) {
    const { start, end } = this.getWeekRange(weekStart);
    
    // Get all suppliers
    const suppliers = await Supplier.find({
      company: toObjectId(companyId)
    }, { name: 1 }).lean();
    
    // Get POs raised this week
    const posRaised = await PurchaseOrder.aggregate([
      {
        $match: {
          company: toObjectId(companyId),
          orderDate: { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: '$supplier',
          count: { $sum: 1 },
          totalValue: { $sum: { $toDouble: { $ifNull: ['$totalAmount', '$total'] } } }
        }
      }
    ]);
    
    // Get GRNs received this week
    const grnsReceived = await GoodsReceivedNote.aggregate([
      {
        $match: {
          company: toObjectId(companyId),
          receivedDate: { $gte: start, $lte: end },
          status: 'confirmed'
        }
      },
      {
        $group: {
          _id: '$supplier',
          count: { $sum: 1 },
          totalValue: { $sum: { $toDouble: '$totalAmount' } }
        }
      }
    ]);
    
    // Get pending orders (not yet fully received)
    const pendingOrders = await PurchaseOrder.aggregate([
      {
        $match: {
          company: toObjectId(companyId),
          status: { $in: ['approved', 'partially_received'] }
        }
      },
      {
        $group: {
          _id: '$supplier',
          count: { $sum: 1 },
          totalValue: { $sum: { $toDouble: { $ifNull: ['$totalAmount', '$total'] } } }
        }
      }
    ]);
    
    // Get overdue deliveries (expected delivery date passed)
    const today = new Date();
    const overdueOrders = await PurchaseOrder.aggregate([
      {
        $match: {
          company: toObjectId(companyId),
          expectedDeliveryDate: { $lt: today },
          status: { $in: ['approved', 'partially_received'] }
        }
      },
      {
        $group: {
          _id: '$supplier',
          count: { $sum: 1 },
          totalValue: { $sum: { $toDouble: { $ifNull: ['$totalAmount', '$total'] } } }
        }
      }
    ]);
    
    // Combine into supplier performance data
    const performanceMap = new Map();
    
    suppliers.forEach(s => {
      performanceMap.set(s._id.toString(), {
        supplierId: s._id,
        supplierName: s.name,
        posRaised: { count: 0, value: 0 },
        deliveriesReceived: { count: 0, value: 0 },
        pendingOrders: { count: 0, value: 0 },
        overdueDeliveries: { count: 0, value: 0 }
      });
    });
    
    posRaised.forEach(p => {
      if (p._id && performanceMap.has(p._id.toString())) {
        const s = performanceMap.get(p._id.toString());
        s.posRaised = { count: p.count, value: p.totalValue };
      }
    });
    
    grnsReceived.forEach(g => {
      if (g._id && performanceMap.has(g._id.toString())) {
        const s = performanceMap.get(g._id.toString());
        s.deliveriesReceived = { count: g.count, value: g.totalValue };
      }
    });
    
    pendingOrders.forEach(p => {
      if (p._id && performanceMap.has(p._id.toString())) {
        const s = performanceMap.get(p._id.toString());
        s.pendingOrders = { count: p.count, value: p.totalValue };
      }
    });
    
    overdueOrders.forEach(o => {
      if (o._id && performanceMap.has(o._id.toString())) {
        const s = performanceMap.get(o._id.toString());
        s.overdueDeliveries = { count: o.count, value: o.totalValue };
      }
    });
    
    const supplierData = Array.from(performanceMap.values())
      .filter(s => s.posRaised.count > 0 || s.deliveriesReceived.count > 0 || s.pendingOrders.count > 0)
      .sort((a, b) => b.posRaised.value - a.posRaised.value);
    
    const result = {
      reportName: 'Weekly Supplier Performance',
      weekStart: weekStart,
      weekEnd: formatLocalDate(end),
      summary: {
        totalSuppliers: supplierData.length,
        totalPosRaised: posRaised.reduce((sum, p) => sum + p.count, 0),
        totalDeliveries: grnsReceived.reduce((sum, g) => sum + g.count, 0),
        totalPending: pendingOrders.reduce((sum, p) => sum + p.count, 0),
        totalOverdue: overdueOrders.reduce((sum, o) => sum + o.count, 0)
      },
      suppliers: supplierData
    };
    
    return result;
  }

  /**
   * 4. Weekly Receivables Aging
   * Outstanding invoices grouped by age buckets
   */
  static async getWeeklyReceivablesAging(companyId) {
    const today = new Date();
    
    // Get all outstanding invoices
    const outstandingInvoices = await Invoice.find({
      company: toObjectId(companyId),
      status: { $in: ['partially_paid', 'confirmed', 'sent'] },
      amountOutstanding: { $gt: 0 }
    }, {
      referenceNo: 1,
      invoiceDate: 1,
      dueDate: 1,
      client: 1,
      totalAmount: 1,
      total: 1,
      amountOutstanding: 1,
      amountPaid: 1
    })
    .populate('client', 'name')
    .lean();
    
    // Age buckets
    const buckets = {
      '0-7': { label: '0-7 Days', invoices: [], total: 0 },
      '8-14': { label: '8-14 Days', invoices: [], total: 0 },
      '15-21': { label: '15-21 Days', invoices: [], total: 0 },
      'over21': { label: 'Over 21 Days', invoices: [], total: 0 }
    };
    
    let totalOutstanding = 0;
    
    outstandingInvoices.forEach(inv => {
      const dueDate = new Date(inv.dueDate || inv.invoiceDate);
      const daysOverdue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
      
      const balance = toNumber(inv.amountOutstanding);
      totalOutstanding += balance;
      
      const invoiceData = {
        invoiceId: inv._id,
        invoiceNumber: inv.referenceNo,
        clientName: inv.client?.name || 'Unknown',
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        daysOverdue: daysOverdue > 0 ? daysOverdue : 0,
        totalAmount: toNumber(inv.totalAmount) || toNumber(inv.total),
        balance: balance
      };
      
      if (daysOverdue <= 7) {
        buckets['0-7'].invoices.push(invoiceData);
        buckets['0-7'].total += balance;
      } else if (daysOverdue <= 14) {
        buckets['8-14'].invoices.push(invoiceData);
        buckets['8-14'].total += balance;
      } else if (daysOverdue <= 21) {
        buckets['15-21'].invoices.push(invoiceData);
        buckets['15-21'].total += balance;
      } else {
        buckets['over21'].invoices.push(invoiceData);
        buckets['over21'].total += balance;
      }
    });
    
    return {
      reportName: 'Weekly Receivables Aging',
      generatedAt: today.toISOString(),
      summary: {
        totalOutstanding,
        totalInvoices: outstandingInvoices.length,
        bucketTotals: {
          '0-7': buckets['0-7'].total,
          '8-14': buckets['8-14'].total,
          '15-21': buckets['15-21'].total,
          'over21': buckets['over21'].total
        }
      },
      buckets
    };
  }

  /**
   * 5. Weekly Payables Aging
   * Amounts owed to suppliers grouped by age buckets
   */
  static async getWeeklyPayablesAging(companyId) {
    const today = new Date();

    const [unpaidGrns, unpaidOrders] = await Promise.all([
      GoodsReceivedNote.find({
        company: toObjectId(companyId),
        status: 'confirmed',
        balance: { $gt: 0 }
      }, {
        referenceNo: 1,
        receivedDate: 1,
        supplier: 1,
        totalAmount: 1,
        balance: 1,
        supplierInvoiceNo: 1
      })
        .populate('supplier', 'name')
        .lean(),
      PurchaseOrder.aggregate([
        {
          $match: {
            company: toObjectId(companyId),
            status: { $in: ['approved', 'partially_received', 'received'] },
            balance: { $gt: 0 }
          }
        },
        {
          $lookup: {
            from: 'suppliers',
            localField: 'supplier',
            foreignField: '_id',
            as: 'supplierDoc'
          }
        }
      ])
    ]);

    const payableItems = [
      ...unpaidGrns.map((grn) => ({
        purchaseId: grn._id,
        purchaseNumber: grn.referenceNo,
        supplierName: grn.supplier?.name || 'Unknown',
        purchaseDate: grn.receivedDate,
        dueDate: new Date(grn.receivedDate),
        totalAmount: toNumber(grn.totalAmount),
        balance: toNumber(grn.balance)
      })),
      ...unpaidOrders.map((po) => ({
        purchaseId: po._id,
        purchaseNumber: po.referenceNo || po.purchaseOrderNumber || 'PO',
        supplierName: po.supplierDoc?.[0]?.name || 'Unknown',
        purchaseDate: po.orderDate,
        dueDate: new Date(po.expectedDeliveryDate || po.orderDate),
        totalAmount: toNumber(po.totalAmount) || toNumber(po.total),
        balance: toNumber(po.balance)
      }))
    ];
    
    // Age buckets
    const buckets = {
      '0-7': { label: '0-7 Days', purchases: [], total: 0 },
      '8-14': { label: '8-14 Days', purchases: [], total: 0 },
      '15-21': { label: '15-21 Days', purchases: [], total: 0 },
      'over21': { label: 'Over 21 Days', purchases: [], total: 0 }
    };
    
    let totalPayable = 0;

    payableItems.forEach((p) => {
      const dueDate = new Date(p.dueDate || p.purchaseDate);
      const daysOverdue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));

      const balance = toNumber(p.balance);
      totalPayable += balance;

      const purchaseData = {
        purchaseId: p.purchaseId,
        purchaseNumber: p.purchaseNumber,
        supplierName: p.supplierName,
        purchaseDate: p.purchaseDate,
        dueDate,
        daysOverdue: daysOverdue > 0 ? daysOverdue : 0,
        totalAmount: toNumber(p.totalAmount),
        balance
      };
      
      if (daysOverdue <= 7) {
        buckets['0-7'].purchases.push(purchaseData);
        buckets['0-7'].total += balance;
      } else if (daysOverdue <= 14) {
        buckets['8-14'].purchases.push(purchaseData);
        buckets['8-14'].total += balance;
      } else if (daysOverdue <= 21) {
        buckets['15-21'].purchases.push(purchaseData);
        buckets['15-21'].total += balance;
      } else {
        buckets['over21'].purchases.push(purchaseData);
        buckets['over21'].total += balance;
      }
    });
    
    return {
      reportName: 'Weekly Payables Aging',
      generatedAt: today.toISOString(),
      summary: {
        totalPayable,
        totalPurchases: payableItems.length,
        bucketTotals: {
          '0-7': buckets['0-7'].total,
          '8-14': buckets['8-14'].total,
          '15-21': buckets['15-21'].total,
          'over21': buckets['over21'].total
        }
      },
      buckets
    };
  }

  /**
   * 6. Weekly Cash Flow Summary
   * Daily cash in and out across the week
   */
  static async getWeeklyCashFlow(companyId, weekStart) {
    const { start, end } = this.getWeekRange(weekStart);
    
    // Generate array of dates for the week
    const weekDates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      weekDates.push(d);
    }
    
    const bankTransactions = await BankTransaction.aggregate([
      {
        $match: {
          company: toObjectId(companyId),
          date: { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
            type: '$type'
          },
          amount: { $sum: { $toDouble: { $ifNull: ['$amount', 0] } } }
        }
      }
    ]);
    
    // Get Cash/Bank account codes
    const cashBankAccounts = await ChartOfAccount.find({
      company: toObjectId(companyId),
      $or: [
        { subtype: { $in: ['Cash', 'Bank', 'cash', 'bank'] } },
        { name: { $regex: /cash|bank/i } }
      ]
    }, { code: 1, name: 1 }).lean();
    
    const cashBankCodes = cashBankAccounts.map(a => a.code);
    
    // Fallback source: posted journal entries for cash/bank accounts if no bank transactions exist.
    const cashInJournals = cashBankCodes.length > 0 ? await JournalEntry.aggregate([
      {
        $match: {
          company: toObjectId(companyId),
          date: { $gte: start, $lte: end },
          status: 'posted'
        }
      },
      { $unwind: '$lines' },
      {
        $match: {
          'lines.accountCode': { $in: cashBankCodes },
          'lines.debit': { $gt: 0 }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          amount: { $sum: { $toDouble: '$lines.debit' } }
        }
      }
    ]) : [];
    
    const cashOutJournals = cashBankCodes.length > 0 ? await JournalEntry.aggregate([
      {
        $match: {
          company: toObjectId(companyId),
          date: { $gte: start, $lte: end },
          status: 'posted'
        }
      },
      { $unwind: '$lines' },
      {
        $match: {
          'lines.accountCode': { $in: cashBankCodes },
          'lines.credit': { $gt: 0 }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          amount: { $sum: { $toDouble: '$lines.credit' } }
        }
      }
    ]) : [];
    
    const hasBankTransactions = bankTransactions.length > 0;
    
    // Build daily summary using local dates
    const dailyFlow = weekDates.map(date => {
      // Format date as YYYY-MM-DD using local timezone
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;
      
      const bankForDate = bankTransactions.filter(c => c._id.date === dateStr);
      const bankIn = bankForDate
        .filter(c => ['deposit', 'transfer_in', 'opening'].includes(c._id.type))
        .reduce((sum, c) => sum + toNumber(c.amount), 0);
      const bankOut = bankForDate
        .filter(c => ['withdrawal', 'transfer_out', 'closing'].includes(c._id.type))
        .reduce((sum, c) => sum + toNumber(c.amount), 0);
      const journalIn = cashInJournals.find(c => c._id === dateStr)?.amount || 0;
      const journalOut = cashOutJournals.find(c => c._id === dateStr)?.amount || 0;
      const receipts = hasBankTransactions ? bankIn : journalIn;
      const cashOut = hasBankTransactions ? bankOut : journalOut;
      
      return {
        date: dateStr,
        dayName: date.toLocaleDateString('en-US', { weekday: 'short' }),
        cashIn: receipts,
        cashOut: cashOut,
        netFlow: receipts - cashOut
      };
    });
    
    const weekTotalIn = dailyFlow.reduce((sum, d) => sum + d.cashIn, 0);
    const weekTotalOut = dailyFlow.reduce((sum, d) => sum + d.cashOut, 0);
    
    const result = {
      reportName: 'Weekly Cash Flow Summary',
      weekStart,
      weekEnd: formatLocalDate(end),
      summary: {
        weekTotalIn,
        weekTotalOut,
        weekNetFlow: weekTotalIn - weekTotalOut,
        dailyFlow
      }
    };
    
    return result;
  }

  /**
   * 7. Weekly Payroll Preview
   * Shows expected payroll if in progress
   */
  static async getWeeklyPayrollPreview(companyId) {
    const today = new Date();
    const inProgressStatuses = ['draft', 'calculated', 'review', 'pending_approval'];

    const buildEmployeeRows = (records) => records.map((p) => {
      const emp = p.employee && typeof p.employee === 'object' ? p.employee : {};
      const salary = p.salary && typeof p.salary === 'object' ? p.salary : {};
      const deductions = p.deductions && typeof p.deductions === 'object' ? p.deductions : {};
      const contributions = p.contributions && typeof p.contributions === 'object' ? p.contributions : {};
      const grossPay = toNumber(salary.grossSalary ?? salary.grossPay ?? p.netPay);
      const paye = toNumber(deductions.paye);
      const rssbEmployee = toNumber(deductions.rssbEmployeePension) + toNumber(deductions.rssbEmployeeMaternity);
      const rssbEmployer = toNumber(contributions.rssbEmployerPension) + toNumber(contributions.rssbEmployerMaternity);
      const totalDeductions = toNumber(deductions.totalDeductions) || (paye + rssbEmployee);
      const netPay = toNumber(p.netPay);

      return {
        employeeId: emp.employeeId || p.employee_id || p._id,
        name: `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || 'Unknown',
        employeeNumber: emp.employeeNumber || emp.employeeId || '',
        department: emp.department || 'N/A',
        grossPay,
        paye,
        rssbEmployee,
        rssbEmployer,
        totalDeductions,
        netPay
      };
    });

    let currentPayrollRun = await PayrollRun.findOne({
      company: toObjectId(companyId),
      status: { $in: inProgressStatuses },
      pay_period_start: { $lte: today },
      pay_period_end: { $gte: today }
    })
      .sort({ pay_period_start: -1 })
      .lean();

    if (!currentPayrollRun) {
      currentPayrollRun = await PayrollRun.findOne({
        company: toObjectId(companyId),
        status: { $in: inProgressStatuses }
      })
        .sort({ updatedAt: -1 })
        .lean();
    }

    if (currentPayrollRun) {
      const payrollRecords = await Payroll.find({
        company: toObjectId(companyId),
        payroll_run_id: currentPayrollRun._id
      }).lean();

      if (payrollRecords.length > 0) {
        const employees = buildEmployeeRows(payrollRecords);
        return {
          reportName: 'Weekly Payroll Preview',
          payrollInProgress: true,
          periodStart: formatLocalDate(currentPayrollRun.pay_period_start),
          periodEnd: formatLocalDate(currentPayrollRun.pay_period_end),
          employeeCount: employees.length,
          estimatedGrossPay: employees.reduce((sum, e) => sum + e.grossPay, 0),
          summary: {
            employeeCount: employees.length,
            grossPay: employees.reduce((sum, e) => sum + e.grossPay, 0),
            paye: employees.reduce((sum, e) => sum + e.paye, 0),
            rssbEmployee: employees.reduce((sum, e) => sum + e.rssbEmployee, 0),
            rssbEmployer: employees.reduce((sum, e) => sum + e.rssbEmployer, 0),
            totalDeductions: employees.reduce((sum, e) => sum + e.totalDeductions, 0),
            netPay: employees.reduce((sum, e) => sum + e.netPay, 0)
          },
          employees
        };
      }

      return {
        reportName: 'Weekly Payroll Preview',
        payrollInProgress: true,
        periodStart: formatLocalDate(currentPayrollRun.pay_period_start),
        periodEnd: formatLocalDate(currentPayrollRun.pay_period_end),
        message: 'Payroll run in progress with no calculated employee lines yet',
        employeeCount: toNumber(currentPayrollRun.employee_count),
        estimatedGrossPay: toNumber(currentPayrollRun.total_gross)
      };
    }

    const activeEmployees = await Employee.find({
      company: toObjectId(companyId),
      status: 'active'
    }, {
      employeeId: 1,
      firstName: 1,
      lastName: 1,
      department: 1,
      currentSalary: 1
    }).lean();

    const estimatedGrossPay = activeEmployees.reduce((sum, employee) => {
      const salary = employee.currentSalary;
      if (salary && typeof salary === 'object') {
        return sum + toNumber(salary.amount ?? salary.grossSalary ?? salary.baseSalary);
      }
      return sum + toNumber(salary);
    }, 0);

    if (activeEmployees.length === 0) {
      return {
        reportName: 'Weekly Payroll Preview',
        payrollInProgress: false,
        message: 'No payroll data available',
        employeeCount: 0,
        estimatedGrossPay: 0
      };
    }

    return {
      reportName: 'Weekly Payroll Preview',
      payrollInProgress: false,
      message: 'No payroll run in progress — estimated from active employee salaries',
      employeeCount: activeEmployees.length,
      estimatedGrossPay,
      employees: activeEmployees.map((employee) => ({
        employeeId: employee.employeeId || employee._id,
        employeeNumber: employee.employeeId || '',
        name: `${employee.firstName || ''} ${employee.lastName || ''}`.trim() || 'Unknown',
        department: employee.department || 'N/A',
        grossPay: toNumber(
          employee.currentSalary && typeof employee.currentSalary === 'object'
            ? employee.currentSalary.amount ?? employee.currentSalary.grossSalary
            : employee.currentSalary
        ),
        paye: 0,
        rssbEmployee: 0,
        rssbEmployer: 0,
        totalDeductions: 0,
        netPay: 0
      }))
    };
  }
}

module.exports = WeeklyReportsService;
