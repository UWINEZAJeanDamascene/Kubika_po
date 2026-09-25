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

const { dbClient } = require('../lib/prisma');
const { toIdString } = require('../utils/objectId');
const journalAgg = require('./journalAggregationService');

async function aggregateExpenseWithholdingTax(companyId, start, end) {
  const result = await dbClient().expense.aggregate({
    where: { companyId: String(companyId), expenseDate: { gte: new Date(start), lte: new Date(end) }, withholdingTax: { gt: 0 } },
    _sum: { withholdingTax: true },
    _count: { _all: true },
  });
  return [{ total: Number(result._sum?.withholdingTax || 0), count: result._count?._all || 0 }];
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
    const salesResult = await dbClient().invoice.aggregate({
      where: {
        companyId: toIdString(companyId),
        invoiceDate: { gte: new Date(start), lte: new Date(end) },
        status: { in: ['fully_paid', 'partially_paid', 'confirmed'] },
      },
      _sum: { totalAmount: true, totalDiscount: true, taxAmount: true },
      _count: { _all: true },
    });
    const salesData = [{
      totalSales: toNumber(salesResult._sum.totalAmount),
      totalInvoices: salesResult._count._all,
      cashSales: 0,
      creditSales: 0,
      mobileMoneySales: 0,
      bankTransferSales: 0,
      totalDiscount: toNumber(salesResult._sum.totalDiscount),
      totalTax: toNumber(salesResult._sum.taxAmount),
    }];

    // Get top 5 selling products from the same confirmed invoices used by the report totals.
    const topProductRows = await dbClient().invoiceLine.groupBy({
      by: ['productId', 'productName', 'productCode'],
      where: {
        companyId: toIdString(companyId),
        invoice: { invoiceDate: { gte: new Date(start), lte: new Date(end) }, status: { in: ['fully_paid', 'partially_paid', 'confirmed'] } },
      },
      _sum: { qty: true, lineTotal: true },
      orderBy: { _sum: { qty: 'desc' } },
      take: 5,
    });
    const topProducts = topProductRows.map((p) => ({
      _id: p.productId,
      productName: p.productName,
      productCode: p.productCode,
      totalQuantity: toNumber(p._sum.qty),
      totalRevenue: toNumber(p._sum.lineTotal),
    }));

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
      dbClient().purchase.aggregate({
        where: {
          companyId: toIdString(companyId),
          purchaseDate: { gte: new Date(start), lte: new Date(end) },
          status: { in: ['received', 'partial', 'paid'] },
        },
        _sum: { totalAmount: true, taxAmount: true },
        _count: { _all: true },
      }),
      // GRN data - goods received on this date (only confirmed, not drafts)
      dbClient().goodsReceivedNote.aggregate({
        where: { companyId: toIdString(companyId), receivedDate: { gte: new Date(start), lte: new Date(end) }, status: 'confirmed' },
        _sum: { totalAmount: true },
        _count: { _all: true },
      })
    ]);

    // Get suppliers from GRN data (only confirmed)
    const grnSupplierRows = await dbClient().goodsReceivedNote.groupBy({
      by: ['supplierId'],
      where: { companyId: toIdString(companyId), receivedDate: { gte: new Date(start), lte: new Date(end) }, status: 'confirmed' },
      _sum: { totalAmount: true },
      _count: { _all: true },
    });
    const grnSupplierData = grnSupplierRows.map((row) => ({
      _id: row.supplierId,
      totalAmount: toNumber(row._sum.totalAmount),
      orderCount: row._count._all,
    }));

    // Get suppliers from direct purchases
    const purchaseSupplierRows = await dbClient().purchase.groupBy({
      by: ['supplierId'],
      where: { companyId: toIdString(companyId), purchaseDate: { gte: new Date(start), lte: new Date(end) }, status: { in: ['received', 'partial', 'paid'] } },
      _sum: { totalAmount: true },
      _count: { _all: true },
    });
    const purchaseSupplierData = purchaseSupplierRows.map((row) => ({
      _id: row.supplierId,
      totalAmount: toNumber(row._sum.totalAmount),
      orderCount: row._count._all,
    }));

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
    const supplierIds = Array.from(supplierTotals.keys());
    const suppliers = supplierIds.length
      ? await dbClient().supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } })
      : [];
    const supplierMap = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));

    // Convert to array, sort by amount, and take top 5
    const topSuppliers = Array.from(supplierTotals.values())
      .sort((a, b) => b.totalAmount - a.totalAmount)
      .slice(0, 5);

    // Combine purchase and GRN data
    const pData = {
      totalPurchases: toNumber(purchaseData._sum.totalAmount),
      totalOrders: purchaseData._count._all,
      totalTax: toNumber(purchaseData._sum.taxAmount),
      totalDiscount: 0,
    };

    const gData = {
      totalGRNs: grnData._count._all,
      totalGRNAmount: toNumber(grnData._sum.totalAmount),
      totalItemsReceived: 0,
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
    const accounts = await dbClient().bankAccount.findMany({
      where: { companyId: String(companyId), isActive: true },
    });
    
    const accountPositions = await Promise.all(
      accounts.map(async (account) => {
        // Get opening balance (balance at start of day)
        const lastTransactionBefore = await dbClient().bankTransaction.findFirst({
          where: {
            companyId: String(companyId),
            bankAccountId: account.id,
            date: { lt: new Date(start) },
          },
          orderBy: { date: 'desc' },
        });
        
        const openingBalance = lastTransactionBefore
          ? toNumber(lastTransactionBefore.balanceAfter)
          : toNumber(account.openingBalance);
        
        // Get today's transactions
        const transactions = await dbClient().bankTransaction.findMany({
          where: {
            companyId: String(companyId),
            bankAccountId: account.id,
            date: { gte: new Date(start), lte: new Date(end) },
          },
          select: { type: true, amount: true },
        });
        
        const receipts = transactions
          .filter((t) => ['deposit', 'transfer_in', 'opening'].includes(t.type))
          .reduce((sum, t) => sum + toNumber(t.amount), 0);
        const payments = transactions
          .filter((t) => ['withdrawal', 'transfer_out', 'closing'].includes(t.type))
          .reduce((sum, t) => sum + toNumber(t.amount), 0);
        const adjustments = transactions
          .filter((t) => t.type === 'adjustment')
          .reduce((sum, t) => sum + toNumber(t.amount), 0);
        
        const ledgerAccountId = account.ledgerAccountId || null;
        // NUMBER CHANGE: this returned nothing before. The leading $match
        // filtered on 'lines.accountCode', a path into the lines *array*, which
        // the shim's getPath cannot walk — so every entry was discarded before
        // $unwind ran. The SQL join below is what the pipeline meant.
        const journalEntries = ledgerAccountId
          ? (await journalAgg.sumJournalLines(companyId, {
              dateFrom: new Date(start),
              dateTo: new Date(end),
              status: 'posted',
              accountCodes: [ledgerAccountId],
              groupByAccountCode: false,
            })).map((r) => ({ _id: null, totalDebit: r.debit, totalCredit: r.credit }))
          : [];
        
        const journalNet = transactions.length === 0
          ? toNumber(journalEntries[0]?.totalDebit) - toNumber(journalEntries[0]?.totalCredit)
          : 0;
        
        return {
          accountId: account.id,
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
    const movements = await dbClient().stockMovement.findMany({
      where: {
        companyId: String(companyId),
        movementDate: { gte: new Date(start), lte: new Date(end) },
      },
      include: {
        product: { select: { id: true, name: true, sku: true } },
        warehouse: { select: { name: true } },
      },
      orderBy: { movementDate: 'asc' },
    });
    
    // Group by type (type field is 'in'/'out', reason field has the specific reason)
    const stockIn = movements.filter(m => m.type === 'in' || ['purchase', 'return', 'transfer_in', 'initial_stock', 'audit_surplus'].includes(m.reason));
    const stockOut = movements.filter(m => m.type === 'out' || ['sale', 'damage', 'loss', 'theft', 'expired', 'transfer_out', 'audit_shortage', 'dispatch'].includes(m.reason));
    
    // Calculate totals
    const movementValue = (m) => toNumber(m.totalCost) || (toNumber(m.quantity) * toNumber(m.unitCost));
    const totalIn = stockIn.reduce((sum, m) => sum + movementValue(m), 0);
    const totalOut = stockOut.reduce((sum, m) => sum + movementValue(m), 0);
    
    // Get product running balances
    const productMovements = await dbClient().$queryRaw`
      SELECT product_id AS "productId",
             COALESCE(SUM(CASE WHEN type = 'in' THEN quantity ELSE -quantity END), 0)::float AS "runningBalance"
      FROM stock_movements
      WHERE company_id = ${toIdString(companyId)} AND movement_date <= ${new Date(end)}
      GROUP BY product_id
    `;

    const balanceMap = new Map(productMovements.map(p => [p.productId?.toString(), p.runningBalance]));
    
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
        movementId: m.id,
        productId: m.product?.id,
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
        runningBalance: toNumber(m.newStock) || balanceMap.get(m.product?.id?.toString()) || 0,
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
        dbClient().invoice.findMany({
          where: {
            companyId: String(companyId),
            invoiceDate: { gte: new Date(start), lte: new Date(end) },
            status: { in: ['confirmed', 'partially_paid', 'fully_paid'] },
          },
          select: {
            id: true, referenceNo: true, invoiceDate: true, totalAmount: true,
            status: true, client: { select: { name: true } },
          },
        }),
      
      // Payments received
        dbClient().aRReceipt.findMany({
          where: {
            companyId: String(companyId),
            receiptDate: { gte: new Date(start), lte: new Date(end) },
            status: 'posted',
          },
          select: {
            id: true, referenceNo: true, receiptDate: true, amountReceived: true,
            paymentMethod: true, client: { select: { name: true } },
          },
        }),
      
      // Credit notes
        dbClient().creditNote.findMany({
          where: {
            companyId: String(companyId),
            creditDate: { gte: new Date(start), lte: new Date(end) },
            status: { in: ['confirmed', 'issued', 'applied', 'partially_refunded', 'refunded'] },
          },
          select: {
            id: true, referenceNo: true, creditDate: true, totalAmount: true,
            reason: true, client: { select: { name: true } }, invoice: { select: { referenceNo: true } },
          },
        }),
      
      dbClient().invoice.aggregate({
        where: {
          companyId: toIdString(companyId),
          invoiceDate: { gte: new Date(start), lte: new Date(end) },
          status: { in: ['confirmed', 'partially_paid', 'fully_paid'] },
        },
        _sum: { totalAmount: true },
      })
    ]);
    
    // Calculate totals using aggregation results + fallback to reduce for other models
    const newInvoicesTotal = toNumber(invoiceTotals._sum.totalAmount);
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
      dbClient().purchase.findMany({
        where: {
          companyId: String(companyId),
          purchaseDate: { gte: new Date(start), lte: new Date(end) },
          status: { in: ['received', 'partial', 'paid'] },
        },
        select: {
          id: true, purchaseNumber: true, purchaseDate: true, totalAmount: true,
          status: true, supplier: { select: { name: true } },
        },
      }),
      
      // Payments made
      dbClient().aPPayment.findMany({
        where: {
          companyId: String(companyId),
          paymentDate: { gte: new Date(start), lte: new Date(end) },
          status: 'posted',
        },
        select: {
          id: true, referenceNo: true, paymentDate: true, amountPaid: true,
          paymentMethod: true, supplier: { select: { name: true } },
        },
      }),
      
      // Purchase returns (debit notes)
      dbClient().purchaseReturn.findMany({
        where: {
          companyId: String(companyId),
          returnDate: { gte: new Date(start), lte: new Date(end) },
          status: 'confirmed',
        },
        select: {
          id: true, referenceNo: true, returnDate: true, totalAmount: true,
          reason: true, supplier: { select: { name: true } }, grn: { select: { referenceNo: true } },
        },
      }),
      
      dbClient().purchase.aggregate({
        where: {
          companyId: toIdString(companyId),
          purchaseDate: { gte: new Date(start), lte: new Date(end) },
          status: { in: ['received', 'partial', 'paid'] },
        },
        _sum: { totalAmount: true },
      })
    ]);
    
    // Calculate totals using aggregation results + simple reduce for others
    const newBillsTotal = toNumber(purchaseTotals._sum.totalAmount);
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
        purchaseId: bill.id,
        purchaseNumber: bill.purchaseNumber,
        supplierName: bill.supplier?.name || 'Unknown',
        date: bill.purchaseDate,
        total: toNumber(bill.totalAmount),
        status: bill.status
      })),
      paymentsMade: paymentsMade.map(p => ({
        paymentId: p.id,
        paymentNumber: p.referenceNo,
        supplierName: p.supplier?.name || 'Unknown',
        purchaseNumber: '',
        date: p.paymentDate,
        amount: toNumber(p.amountPaid),
        paymentMethod: p.paymentMethod
      })),
      purchaseReturns: purchaseReturns.map(pr => ({
        returnId: pr.id,
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
    
    const entries = await dbClient().journalEntry.findMany({
      where: {
        companyId: String(companyId),
        date: { gte: new Date(start), lte: new Date(end) },
        status: 'posted',
      },
      include: { lines: true },
      orderBy: { createdAt: 'asc' },
    });
    const creatorIds = [...new Set(entries.map((entry) => entry.createdById).filter(Boolean))];
    const creators = creatorIds.length
      ? await dbClient().user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true } })
      : [];
    const creatorMap = new Map(creators.map((creator) => [creator.id, creator.name]));
    
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
        entryId: entry.id,
        entryNumber: entry.entryNumber,
        date: entry.date,
        description: entry.description,
        reference: entry.reference,
        postedBy: creatorMap.get(entry.createdById) || 'System',
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
      dbClient().invoice.aggregate({
        where: { companyId: String(companyId), invoiceDate: { gte: start, lte: end }, status: { in: ['fully_paid', 'partially_paid', 'confirmed'] } },
        _sum: { taxAmount: true, subtotal: true, totalDiscount: true, totalAmount: true }, _count: { _all: true },
      }),
      dbClient().creditNote.aggregate({
        where: { companyId: String(companyId), creditDate: { gte: start, lte: end }, status: { in: ['confirmed', 'issued', 'applied', 'partially_refunded', 'refunded'] } },
        _sum: { taxAmount: true, totalAmount: true }, _count: { _all: true },
      }),
      dbClient().taxTransaction.aggregate({ where: { companyId: String(companyId), taxType: 'withholding', direction: 'withheld', sourceType: { in: ['invoice', 'sale', 'sales_invoice'] }, status: 'posted', date: { gte: start, lte: end } }, _sum: { amount: true }, _count: { _all: true } }),
      dbClient().taxTransaction.aggregate({ where: { companyId: String(companyId), taxType: 'withholding', direction: 'withheld', sourceType: { in: ['purchase', 'purchase_invoice'] }, status: 'posted', date: { gte: start, lte: end } }, _sum: { amount: true }, _count: { _all: true } }),
      aggregateExpenseWithholdingTax(companyId, start, end)
    ]);
    
    // Get tax breakdown by tax code from invoice lines
    const taxBreakdown = await dbClient().$queryRaw`
      SELECT il.tax_code AS "taxCode", MIN(il.tax_rate) AS "taxRate",
             COALESCE(SUM(il.line_subtotal - il.line_subtotal * il.discount_pct / 100), 0) AS "taxableAmount",
             COALESCE(SUM(il.line_tax), 0) AS "taxAmount"
      FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
      WHERE i.company_id = ${String(companyId)} AND i.invoice_date >= ${start} AND i.invoice_date <= ${end}
        AND i.status IN ('fully_paid', 'partially_paid', 'confirmed') AND il.tax_code IS NOT NULL
      GROUP BY il.tax_code ORDER BY "taxRate"
    `;
    
    const taxData = { totalTax: invoiceTax._sum?.taxAmount, subtotal: invoiceTax._sum?.subtotal, totalDiscount: invoiceTax._sum?.totalDiscount, total: invoiceTax._sum?.totalAmount, invoiceCount: invoiceTax._count?._all };
    const reversalData = { totalTax: creditNoteTax._sum?.taxAmount, total: creditNoteTax._sum?.totalAmount, noteCount: creditNoteTax._count?._all };
    const taxableSales = Math.max(0, toNumber(taxData.subtotal) - toNumber(taxData.totalDiscount));
    const totalOutputVAT = Math.max(0, toNumber(taxData.totalTax) - toNumber(reversalData.totalTax));
    const withholdingTaxCollected = toNumber(invoiceWHT._sum?.amount);
    const withholdingTaxPaid = toNumber(purchaseWHT._sum?.amount) + toNumber(expenseWHT[0]?.total);
    
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
        { taxType: 'Sales WHT Collected', source: 'Invoices', count: toNumber(invoiceWHT._count?._all), amount: withholdingTaxCollected },
        { taxType: 'Purchase WHT Withheld', source: 'Purchases', count: toNumber(purchaseWHT._count?._all), amount: toNumber(purchaseWHT._sum?.amount) },
        { taxType: 'Expense WHT Withheld', source: 'Expenses', count: toNumber(expenseWHT[0]?.count), amount: toNumber(expenseWHT[0]?.total) }
      ].filter(item => item.amount > 0 || item.count > 0),
      generatedAt: new Date().toISOString()
    };
  }
}

module.exports = DailyReportsService;
