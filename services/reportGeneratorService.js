const ReportSnapshot = require('../models/ReportSnapshot');
const Invoice = require('../models/Invoice');
const CreditNote = require('../models/CreditNote');
const Purchase = require('../models/Purchase');
const PurchaseReturn = require('../models/PurchaseReturn');
const Expense = require('../models/Expense');
const Product = require('../models/Product');
const Client = require('../models/Client');
const Supplier = require('../models/Supplier');
const Tax = require('../models/Tax');
const Company = require('../models/Company');
const FixedAsset = require('../models/FixedAsset');
const StockMovement = require('../models/StockMovement');
const InventoryBatch = require('../models/InventoryBatch');
const SerialNumber = require('../models/SerialNumber');
const Warehouse = require('../models/Warehouse');
const { BankAccount, BankTransaction } = require('../models/BankAccount');
const { Prisma } = require('@prisma/client');
const { dbClient } = require('../lib/prisma');
function legacyRelation(row) {
  if (!row) return row;
  return { ...row, _id: row.id };
}

async function loadFixedAssets(companyId, where = {}, orderBy) {
  const rows = await dbClient().fixedAsset.findMany({
    where: { companyId: String(companyId), ...where },
    include: { category: { select: { id: true, name: true } } },
    ...(orderBy ? { orderBy } : {}),
  });
  const supplierIds = [...new Set(rows.map((row) => row.supplierId).filter(Boolean))];
  const creatorIds = [...new Set(rows.map((row) => row.createdById).filter(Boolean))];
  const [suppliers, creators] = await Promise.all([
    supplierIds.length ? dbClient().supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true, code: true } }) : [],
    creatorIds.length ? dbClient().user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true } }) : [],
  ]);
  const supplierMap = new Map(suppliers.map((row) => [row.id, legacyRelation(row)]));
  const creatorMap = new Map(creators.map((row) => [row.id, legacyRelation(row)]));
  return rows.map((row) => ({
    ...row,
    _id: row.id,
    assetCode: row.referenceNo || row.id,
    category: legacyRelation(row.category),
    supplier: supplierMap.get(row.supplierId) || null,
    createdBy: creatorMap.get(row.createdById) || null,
    purchaseValue: Number(row.purchaseCost || 0),
    usefulLife: Math.max(1, Math.round(row.usefulLifeMonths / 12)),
    usefulLifeYears: Math.max(1, row.usefulLifeMonths / 12),
    currentValue: Number(row.netBookValue || 0),
    disposalAmount: Number(row.disposalNetProceeds ?? row.disposalProceeds ?? 0),
  }));
}

function sumPurchasePayments(payments) {
  return Array.isArray(payments)
    ? payments.reduce((sum, payment) => sum + Number(payment?.amountPaid ?? payment?.amount_paid ?? payment?.amount ?? 0), 0)
    : 0;
}

async function loadPurchasesForReport(companyId, where = {}, orderBy) {
  const rows = await dbClient().purchase.findMany({
    where: { companyId: String(companyId), ...where },
    include: { supplier: { select: { id: true, name: true, code: true, contact: true } }, lines: true },
    ...(orderBy ? { orderBy } : {}),
  });
  return rows.map((row) => {
    const total = Number(row.totalAmount || 0);
    const paid = Math.min(total, sumPurchasePayments(row.payments));
    return {
      ...row,
      _id: row.id,
      purchaseNumber: row.purchaseNumber,
      expectedDeliveryDate: row.purchaseDate,
      grandTotal: total,
      amountPaid: paid,
      balance: Math.max(0, total - paid),
      totalTax: Number(row.taxAmount || 0),
      items: row.lines,
      supplier: legacyRelation(row.supplier),
    };
  });
}

async function loadPayablesForReport(companyId) {
  const rows = await dbClient().$queryRaw(Prisma.sql`
    SELECT grn.id, grn.reference_no AS "referenceNo", grn.supplier_invoice_no AS "supplierInvoiceNo",
           grn.received_date AS "receivedDate", grn.total_amount AS "totalAmount",
           grn.payment_due_date AS "paymentDueDate", grn.status,
           s.id AS "supplierId", s.name AS "supplierName", s.code AS "supplierCode", s.contact AS "supplierContact",
           COALESCE(SUM(apa.amount_allocated) FILTER (WHERE ap.status = 'posted'), 0) AS "paidFromLedger"
    FROM goods_received_notes grn
    JOIN suppliers s ON s.id = grn.supplier_id
    LEFT JOIN ap_payment_allocations apa ON apa.grn_id = grn.id
    LEFT JOIN ap_payments ap ON ap.id = apa.payment_id
    WHERE grn.company_id = ${String(companyId)} AND grn.status IN ('received', 'confirmed', 'posted')
    GROUP BY grn.id, s.id
    HAVING grn.total_amount > COALESCE(SUM(apa.amount_allocated) FILTER (WHERE ap.status = 'posted'), 0)
    ORDER BY grn.payment_due_date ASC NULLS LAST, grn.received_date ASC
  `);
  return rows.map((row) => {
    const total = Number(row.totalAmount || 0);
    const paid = Math.min(total, Number(row.paidFromLedger || 0));
    return {
      ...row,
      _id: row.id,
      purchaseNumber: row.supplierInvoiceNo || row.referenceNo,
      purchaseDate: row.receivedDate,
      expectedDeliveryDate: row.paymentDueDate || row.receivedDate,
      subtotal: total,
      totalTax: 0,
      grandTotal: total,
      amountPaid: paid,
      balance: Math.max(0, total - paid),
      supplier: { _id: row.supplierId, name: row.supplierName, code: row.supplierCode, contact: row.supplierContact },
    };
  });
}

async function aggregateReportTotals(delegate, where, sums) {
  const result = await dbClient()[delegate].aggregate({
    where,
    _sum: sums,
    _count: { _all: true },
  });
  return result;
}

// Helper function to get date range for different periods
const getPeriodDates = (periodType, year, periodNumber) => {
  let startDate, endDate, label;

  switch (periodType) {
    case 'daily':
      startDate = new Date(year, 0, periodNumber);
      endDate = new Date(year, 0, periodNumber, 23, 59, 59, 999);
      label = startDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      break;

    case 'weekly':
      // Calculate week start (Monday) and end (Sunday)
      const jan1 = new Date(year, 0, 1);
      const dayOfWeek = jan1.getDay();
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      startDate = new Date(year, 0, 1 + (periodNumber - 1) * 7 + mondayOffset);
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 6);
      endDate.setHours(23, 59, 59, 999);
      label = `Week ${periodNumber}, ${year}`;
      break;

    case 'monthly':
      startDate = new Date(year, periodNumber - 1, 1);
      endDate = new Date(year, periodNumber, 0, 23, 59, 59, 999);
      label = startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      break;

    case 'quarterly':
      const quarterStartMonth = (periodNumber - 1) * 3;
      startDate = new Date(year, quarterStartMonth, 1);
      endDate = new Date(year, quarterStartMonth + 3, 0, 23, 59, 59, 999);
      label = `Q${periodNumber} ${year}`;
      break;

    case 'semi-annual':
      const semiStartMonth = (periodNumber - 1) * 6;
      startDate = new Date(year, semiStartMonth, 1);
      endDate = new Date(year, semiStartMonth + 6, 0, 23, 59, 59, 999);
      label = periodNumber === 1 ? `H1 ${year}` : `H2 ${year}`;
      break;

    case 'annual':
      startDate = new Date(year, 0, 1);
      endDate = new Date(year, 11, 31, 23, 59, 59, 999);
      label = `Year ${year}`;
      break;

    default:
      throw new Error(`Invalid period type: ${periodType}`);
  }

  return { startDate, endDate, label };
};

// Helper to get current period info
const getCurrentPeriodInfo = (periodType) => {
  const now = new Date();
  const year = now.getFullYear();
  let periodNumber;

  switch (periodType) {
    case 'daily':
      const startOfYear = new Date(year, 0, 1);
      periodNumber = Math.ceil((now - startOfYear) / (1000 * 60 * 60 * 24));
      break;
    case 'weekly':
      const jan1 = new Date(year, 0, 1);
      const dayOfWeek = jan1.getDay();
      const days = Math.floor((now - jan1) / (1000 * 60 * 60 * 24));
      periodNumber = Math.ceil((days + (dayOfWeek === 0 ? 7 : dayOfWeek)) / 7);
      break;
    case 'monthly':
      periodNumber = now.getMonth() + 1;
      break;
    case 'quarterly':
      periodNumber = Math.floor(now.getMonth() / 3) + 1;
      break;
    case 'semi-annual':
      periodNumber = now.getMonth() < 6 ? 1 : 2;
      break;
    case 'annual':
      periodNumber = 1;
      break;
  }

  return { year, periodNumber };
};

// Generate Profit & Loss Report
const generateProfitLossReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    companyId: String(companyId),
    status: 'paid',
    paidDate: { gte: startDate, lte: endDate }
  };

  // Revenue from paid invoices
  const invoiceTotals = await aggregateReportTotals('invoice', { ...matchStage, status: 'fully_paid' }, { totalAmount: true, subtotal: true, taxAmount: true, totalDiscount: true });
  const invoiceRevenue = [{
    total: invoiceTotals._sum.totalAmount || 0,
    subtotal: invoiceTotals._sum.subtotal || 0,
    taxAmount: invoiceTotals._sum.taxAmount || 0,
    discount: invoiceTotals._sum.totalDiscount || 0,
    count: invoiceTotals._count._all,
  }];

  // Sales returns from CreditNote collection
  const creditNoteTotals = await aggregateReportTotals('creditNote', { companyId: String(companyId), status: 'approved', creditDate: { gte: startDate, lte: endDate } }, { totalAmount: true, subtotal: true, taxAmount: true });
  const creditNotesData = [{ total: creditNoteTotals._sum.totalAmount || 0, subtotal: creditNoteTotals._sum.subtotal || 0, taxAmount: creditNoteTotals._sum.taxAmount || 0, count: creditNoteTotals._count._all }];

  // Purchases
  const purchaseTotals = await aggregateReportTotals('purchase', { companyId: String(companyId), status: 'completed', purchaseDate: { gte: startDate, lte: endDate } }, { totalAmount: true, subtotal: true, taxAmount: true });
  const purchases = [{ total: purchaseTotals._sum.totalAmount || 0, subtotal: purchaseTotals._sum.subtotal || 0, taxAmount: purchaseTotals._sum.taxAmount || 0, count: purchaseTotals._count._all }];

  // Purchase returns from PurchaseReturn collection
  const purchaseReturnTotals = await aggregateReportTotals('purchaseReturn', { companyId: String(companyId), status: 'approved', returnDate: { gte: startDate, lte: endDate } }, { totalAmount: true });
  const purchaseReturnsData = [{ total: purchaseReturnTotals._sum.totalAmount || 0, subtotal: 0, taxAmount: 0, count: purchaseReturnTotals._count._all }];

  // Expenses by category
  const expenses = await dbClient().expense.groupBy({
    by: ['category'],
    where: { companyId: String(companyId), status: 'approved', expenseDate: { gte: startDate, lte: endDate } },
    _sum: { amount: true },
  });

  // Get stock values
  const products = await Product.find({ company: companyId, isActive: true });

  const openingStockValue = products.reduce((sum, p) => sum + (p.openingStock * p.costPrice), 0);
  const closingStockValue = products.reduce((sum, p) => sum + (p.quantity * p.costPrice), 0);

  // Calculate totals
  const salesRevenue = invoiceRevenue[0]?.subtotal || 0;
  const salesReturns = creditNotesData[0]?.total || 0;
  const discounts = invoiceRevenue[0]?.discount || 0;
  const netRevenue = salesRevenue - salesReturns - discounts;

  const purchasesExVAT = purchases[0]?.subtotal || 0;
  const purchaseReturnsAmount = purchaseReturnsData[0]?.total || 0;
  const totalCOGS = openingStockValue + purchasesExVAT - purchaseReturnsAmount - closingStockValue;

  const grossProfit = netRevenue - totalCOGS;

  // Operating expenses
  const expenseByCategory = {};
  expenses.forEach(e => {
    expenseByCategory[e.category || 'Other'] = Number(e._sum.amount || 0);
  });

  // Depreciation from FixedAsset (Asset) for the period
  const fixedAssets = await loadFixedAssets(companyId, { status: 'active' });
  const totalDepreciation = fixedAssets.reduce((sum, fa) => {
    // Calculate monthly depreciation
    const monthlyDepreciation = (fa.purchaseValue - fa.salvageValue) / (fa.usefulLife || 60); // default 5 years
    const months = Math.min(
      Math.floor((endDate - (fa.depreciationStartDate || fa.purchaseDate)) / (1000 * 60 * 60 * 24 * 30)),
      fa.usefulLife || 60
    );
    return sum + (monthlyDepreciation * Math.max(months, 0));
  }, 0);

  expenseByCategory['Depreciation'] = totalDepreciation;

  const totalExpenses = Object.values(expenseByCategory).reduce((a, b) => a + b, 0);
  const operatingProfit = grossProfit - totalExpenses;

  // Other income/expenses
  const interestIncome = 0; // Could be calculated from bank accounts
  const [interestExpenseRow] = await dbClient().$queryRaw(Prisma.sql`
    SELECT COALESCE(SUM(
      ("original_amount" * "interest_rate" / 100) * GREATEST(
        EXTRACT(EPOCH FROM (${endDate} - GREATEST("start_date", ${startDate}))) / (30 * 24 * 60 * 60), 1
      )
    ), 0) AS total
    FROM loans
    WHERE "company_id" = ${String(companyId)} AND status = 'active' AND "start_date" <= ${endDate}
  `);
  const interestExpense = Number(interestExpenseRow?.total || 0);

  const netOtherIncome = interestIncome - interestExpense;
  const profitBeforeTax = operatingProfit + netOtherIncome;
  const corporateTax = profitBeforeTax > 0 ? profitBeforeTax * 0.3 : 0;
  const netProfit = profitBeforeTax - corporateTax;

  return {
    revenue: {
      salesRevenue,
      salesReturns,
      discounts,
      netRevenue
    },
    cogs: {
      openingStockValue,
      purchasesExVAT,
      purchaseReturns: purchaseReturnsAmount,
      closingStockValue,
      totalCOGS
    },
    grossProfit: {
      amount: grossProfit,
      marginPercent: netRevenue > 0 ? (grossProfit / netRevenue) * 100 : 0
    },
    operatingExpenses: expenseByCategory,
    totalExpenses,
    operatingProfit: {
      amount: operatingProfit,
      marginPercent: netRevenue > 0 ? (operatingProfit / netRevenue) * 100 : 0
    },
    otherIncomeExpenses: {
      interestIncome,
      interestExpense,
      netOtherIncome
    },
    profitBeforeTax: {
      amount: profitBeforeTax
    },
    tax: {
      corporateTax,
      totalTax: corporateTax
    },
    netProfit: {
      amount: netProfit,
      marginPercent: netRevenue > 0 ? (netProfit / netRevenue) * 100 : 0
    },
    details: {
      paidInvoicesCount: invoiceRevenue[0]?.count || 0,
      creditNotesCount: creditNotesData[0]?.count || 0,
      purchasesCount: purchases[0]?.count || 0,
      purchaseReturnsCount: purchaseReturnsData[0]?.count || 0,
      productsCount: products.length
    }
  };
};

// Generate Balance Sheet Report
const generateBalanceSheetReport = async (companyId, asOfDate) => {
  const asOf = new Date(asOfDate);
  const startOfYear = new Date(asOf.getFullYear(), 0, 1);

  // Current Assets
  const accountsReceivableTotals = await dbClient().invoice.aggregate({
    where: { companyId: String(companyId), status: { in: ['sent', 'partially_paid', 'overdue'] }, dueDate: { lte: asOf } },
    _sum: { amountOutstanding: true },
  });
  const accountsReceivableTotal = Number(accountsReceivableTotals._sum.amountOutstanding || 0);
  const [inventoryRow] = await dbClient().$queryRaw(Prisma.sql`
    SELECT COALESCE(SUM("current_stock" * "cost_price"), 0) AS total
    FROM "products"
    WHERE "company_id" = ${String(companyId)} AND "is_active" = true
  `);
  const inventoryValueTotal = Number(inventoryRow?.total || 0);

  // Cash Position from BankAccount collection
  const bankAccounts = await BankAccount.find({ company: companyId, isActive: true });
  const cashAndBank = bankAccounts.reduce((sum, ba) => sum + (ba.balance || 0), 0);

  const currentAssets = {
    cashAndBank,
    accountsReceivable: accountsReceivableTotal,
    inventoryStockValue: inventoryValueTotal,
    prepaidExpenses: 0,
    vatReceivable: 0,
    total: cashAndBank + accountsReceivableTotal + inventoryValueTotal
  };

  // Fixed Assets
  const fixedAssets = await loadFixedAssets(companyId, { status: 'active' });
  const totalFixedAssets = fixedAssets.reduce((sum, fa) => sum + fa.currentValue, 0);
  const totalDepreciation = fixedAssets.reduce((sum, fa) => sum + (fa.purchaseValue - fa.currentValue), 0);

  const nonCurrentAssets = {
    equipment: totalFixedAssets,
    lessDepreciation: totalDepreciation,
    total: totalFixedAssets - totalDepreciation
  };

  const totalAssets = currentAssets.total + nonCurrentAssets.total;

  // Liabilities
  const accountsPayableTotals = await dbClient().purchase.aggregate({
    where: { companyId: String(companyId), status: { in: ['pending', 'partial'] } },
    _sum: { totalAmount: true },
  });
  const accountsPayableTotal = Number(accountsPayableTotals._sum.totalAmount || 0);
  const loanCutoff = new Date(asOf.getTime() + 365 * 24 * 60 * 60 * 1000);
  const [loanRow] = await dbClient().$queryRaw(Prisma.sql`
    SELECT COALESCE(SUM(CASE WHEN "end_date" <= ${loanCutoff} THEN "outstanding_balance" ELSE 0 END), 0) AS "shortTerm",
           COALESCE(SUM(CASE WHEN "end_date" > ${loanCutoff} THEN "outstanding_balance" ELSE 0 END), 0) AS "longTerm"
    FROM "loans"
    WHERE "company_id" = ${String(companyId)} AND "status" = 'active'
  `);
  const loans = [{ shortTerm: Number(loanRow?.shortTerm || 0), longTerm: Number(loanRow?.longTerm || 0) }];

  const currentLiabilities = {
    accountsPayable: accountsPayableTotal,
    vatPayable: 0,
    shortTermLoans: loans[0]?.shortTerm || 0,
    accruedExpenses: 0,
    total: accountsPayableTotal + (loans[0]?.shortTerm || 0)
  };

  const nonCurrentLiabilities = {
    longTermLoans: loans[0]?.longTerm || 0,
    total: loans[0]?.longTerm || 0
  };

  const totalLiabilities = currentLiabilities.total + nonCurrentLiabilities.total;

  // Equity
  const company = await Company.findById(companyId);
  const shareCapital = company?.shareCapital || 0;
  const retainedEarnings = company?.retainedEarnings || 0;

  // Get current period profit
  const profitLossReport = await generateProfitLossReport(companyId, startOfYear, asOf);
  const currentPeriodProfit = profitLossReport.netProfit.amount;

  const equity = {
    shareCapital,
    retainedEarnings,
    currentPeriodProfit,
    total: shareCapital + retainedEarnings + currentPeriodProfit
  };

  const totalLiabilitiesAndEquity = totalLiabilities + equity.total;

  return {
    assets: {
      currentAssets,
      nonCurrentAssets,
      totalAssets
    },
    liabilities: {
      currentLiabilities,
      nonCurrentLiabilities,
      totalLiabilities
    },
    equity,
    totalLiabilitiesAndEquity,
    isBalanced: Math.abs(totalAssets - totalLiabilitiesAndEquity) < 0.01
  };
};

// Generate VAT Summary Report
const generateVATSummaryReport = async (companyId, startDate, endDate) => {
  // Output VAT (from invoices)
  const outputVATRows = await dbClient().invoiceLine.groupBy({
    by: ['taxCode'],
    where: { companyId: String(companyId), taxRate: { gt: 0 }, invoice: { status: 'fully_paid', paidDate: { gte: startDate, lte: endDate } } },
    _sum: { lineSubtotal: true, lineTax: true },
  });
  const outputVAT = outputVATRows.map((row) => ({ _id: row.taxCode, taxableBase: Number(row._sum.lineSubtotal || 0), taxAmount: Number(row._sum.lineTax || 0) }));

  // Input VAT (from purchases)
  const inputPurchaseTotals = await dbClient().purchase.aggregate({
    where: { companyId: String(companyId), status: 'completed', purchaseDate: { gte: startDate, lte: endDate }, taxAmount: { gt: 0 } },
    _sum: { subtotal: true, taxAmount: true },
  });
  const inputVAT = [{ _id: 'A', taxableBase: Number(inputPurchaseTotals._sum.subtotal || 0), taxAmount: Number(inputPurchaseTotals._sum.taxAmount || 0) }];

  const summary = {};
  const allTaxCodes = new Set([
    ...outputVAT.map(v => v._id),
    ...inputVAT.map(v => v._id)
  ]);

  allTaxCodes.forEach(code => {
    const output = outputVAT.find(v => v._id === code) || { taxableBase: 0, taxAmount: 0 };
    const input = inputVAT.find(v => v._id === code) || { taxableBase: 0, taxAmount: 0 };
    summary[code] = {
      taxableBase: output.taxableBase,
      outputVAT: output.taxAmount,
      inputVAT: input.taxAmount,
      netVAT: output.taxAmount - input.taxAmount
    };
  });

  return summary;
};

// Generate Product Performance Report
const generateProductPerformanceReport = async (companyId, startDate, endDate, limit = 10) => {
  const productPerformance = await dbClient().$queryRaw(Prisma.sql`
    SELECT il.product_id AS product, MAX(COALESCE(il.product_name, p.name)) AS "productName",
           COALESCE(SUM(il.qty * il.unit_price), 0) AS revenue,
           COALESCE(SUM(il.qty * il.unit_cost), 0) AS cogs,
           COALESCE(SUM(il.qty), 0) AS "quantitySold",
           COUNT(DISTINCT il.invoice_id)::int AS orders
    FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
    LEFT JOIN products p ON p.id = il.product_id
    WHERE i.company_id = ${String(companyId)} AND i.status = 'fully_paid'
      AND i.paid_date >= ${startDate} AND i.paid_date <= ${endDate}
    GROUP BY il.product_id ORDER BY revenue DESC LIMIT ${Math.min(Number(limit) || 10, 100)}
  `);
  for (const row of productPerformance) {
    row.revenue = Number(row.revenue || 0); row.cogs = Number(row.cogs || 0);
    row.margin = row.revenue - row.cogs; row.quantitySold = Number(row.quantitySold || 0);
  }

  return productPerformance;
};

// Generate Top Customers Report
const generateTopCustomersReport = async (companyId, startDate, endDate, limit = 10) => {
  const topCustomers = await dbClient().invoice.groupBy({
    by: ['clientId'],
    where: { companyId: String(companyId), status: 'fully_paid', paidDate: { gte: startDate, lte: endDate } },
    _sum: { totalAmount: true }, _count: { _all: true }, _avg: { totalAmount: true },
    orderBy: { _sum: { totalAmount: 'desc' } }, take: Math.min(Number(limit) || 10, 100),
  });
  const customerIds = topCustomers.map((row) => row.clientId).filter(Boolean);
  const customerRows = customerIds.length ? await Client.find({ _id: { $in: customerIds } }, 'name').lean() : [];
  const customerMap = new Map(customerRows.map((row) => [String(row._id), row.name]));
  for (const row of topCustomers) {
    row._id = row.clientId; row.clientName = customerMap.get(row.clientId) || 'Unknown';
    row.revenue = Number(row._sum.totalAmount || 0); row.orders = row._count._all;
    row.avgOrderValue = Number(row._avg.totalAmount || 0); delete row.clientId; delete row._sum; delete row._count; delete row._avg;
  }

  return topCustomers;
};

// Generate Client Statement Report (full transaction history per client)
const generateClientStatementReport = async (companyId, startDate, endDate, clientId = null) => {
  const invoices = await dbClient().invoice.findMany({
    where: {
      companyId: String(companyId),
      ...(clientId ? { clientId: String(clientId) } : {}),
      invoiceDate: { gte: startDate, lte: endDate },
    },
    include: { client: { select: { id: true, name: true, code: true, contact: true } } },
    orderBy: { invoiceDate: 'desc' },
  });

  const creditNotes = clientId ? await dbClient().creditNote.findMany({
    where: {
      companyId: String(companyId),
      clientId: String(clientId),
      creditDate: { gte: startDate, lte: endDate },
    },
    include: { client: { select: { id: true, name: true, code: true, contact: true } } },
    orderBy: { creditDate: 'desc' },
  }) : [];

  // If filtering by specific client, return that client's transactions only
  if (clientId) {
    const client = legacyRelation(invoices[0]?.client || creditNotes[0]?.client);
    const transactions = [];
    
    // Add invoices
    invoices.forEach(inv => {
      transactions.push({
        date: inv.invoiceDate,
        type: 'invoice',
        reference: inv.referenceNo,
        amount: Number(inv.subtotal || 0),
        tax: Number(inv.taxAmount || 0),
        total: Number(inv.totalAmount || 0),
        paid: Number(inv.amountPaid || 0),
        balance: Number(inv.amountOutstanding || 0),
        status: inv.status
      });
    });
    
    // Add credit notes
    creditNotes.forEach(cn => {
      transactions.push({
        date: cn.creditDate,
        type: 'credit_note',
        reference: cn.referenceNo,
        amount: Number(cn.subtotal || 0),
        tax: Number(cn.taxAmount || 0),
        total: Number(cn.totalAmount || 0),
        paid: 0,
        balance: 0,
        status: cn.status
      });
    });
    
    // Sort by date descending
    transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    const totalInvoiced = invoices.reduce((sum, inv) => sum + Number(inv.totalAmount || 0), 0);
    const totalPaid = invoices.reduce((sum, inv) => sum + Number(inv.amountPaid || 0), 0);
    const totalBalance = invoices.reduce((sum, inv) => sum + Number(inv.amountOutstanding || 0), 0);
    
    return [{
      client: client,
      transactions: transactions,
      totalInvoiced,
      totalPaid,
      balance: totalBalance
    }];
  }

  // Group transactions by client (original behavior for all clients)
  const clientTransactions = {};
  invoices.forEach(inv => {
    const clientIdStr = inv.client?.id?.toString();
    if (!clientIdStr) return;
    
    if (!clientTransactions[clientIdStr]) {
      clientTransactions[clientIdStr] = {
        client: inv.client,
                  client: legacyRelation(inv.client),
        transactions: [],
        totalInvoiced: 0,
        totalPaid: 0,
        balance: 0
      };
    }
    
    clientTransactions[clientIdStr].transactions.push({
      date: inv.invoiceDate,
      type: 'invoice',
      reference: inv.invoiceNumber,
      amount: Number(inv.totalAmount || 0),
      paid: Number(inv.amountPaid || 0),
      balance: Number(inv.amountOutstanding || 0)
    });
    
    clientTransactions[clientIdStr].totalInvoiced += Number(inv.totalAmount || 0);
    clientTransactions[clientIdStr].totalPaid += Number(inv.amountPaid || 0);
    clientTransactions[clientIdStr].balance += Number(inv.amountOutstanding || 0);
  });

  return Object.values(clientTransactions);
};

// Generate Supplier Statement Report (full transaction history per supplier)
const generateSupplierStatementReport = async (companyId, startDate, endDate, supplierId = null) => {
  const purchases = await dbClient().purchase.findMany({
    where: {
      companyId: String(companyId),
      ...(supplierId ? { supplierId: String(supplierId) } : {}),
      purchaseDate: { gte: startDate, lte: endDate },
    },
    include: { supplier: { select: { id: true, name: true, code: true, contact: true } } },
    orderBy: { purchaseDate: 'desc' },
  });

  const purchaseReturns = supplierId ? await dbClient().purchaseReturn.findMany({
    where: {
      companyId: String(companyId),
      supplierId: String(supplierId),
      returnDate: { gte: startDate, lte: endDate },
      status: { in: ['approved', 'refunded', 'partially_refunded'] },
    },
    include: { supplier: { select: { id: true, name: true, code: true, contact: true } } },
    orderBy: { returnDate: 'desc' },
  }) : [];

  // If filtering by specific supplier, return that supplier's transactions only
  if (supplierId) {
    const supplier = legacyRelation(purchases[0]?.supplier || purchaseReturns[0]?.supplier);
    const transactions = [];
    
    // Add purchases
    purchases.forEach(pur => {
      transactions.push({
        date: pur.purchaseDate,
        type: 'purchase',
        reference: pur.purchaseNumber,
        amount: Number(pur.subtotal || 0),
        tax: Number(pur.taxAmount || 0),
        total: Number(pur.totalAmount || 0),
        paid: 0,
        balance: Number(pur.totalAmount || 0),
        status: pur.status
      });
    });
    
    // Add purchase returns
    purchaseReturns.forEach(pr => {
      transactions.push({
        date: pr.returnDate,
        type: 'purchase_return',
        reference: pr.referenceNo,
        amount: Number(pr.totalAmount || 0),
        tax: 0,
        total: Number(pr.totalAmount || 0),
        paid: 0,
        balance: 0,
        status: pr.status
      });
    });
    
    // Sort by date descending
    transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    const totalInvoiced = purchases.reduce((sum, pur) => sum + Number(pur.totalAmount || 0), 0);
    const totalPaid = 0;
    const totalBalance = purchases.reduce((sum, pur) => sum + Number(pur.totalAmount || 0), 0);
    
    return [{
      supplier: supplier,
      transactions: transactions,
      totalInvoiced,
      totalPaid,
      balance: totalBalance
    }];
  }

  // Group transactions by supplier (original behavior for all suppliers)
  const supplierTransactions = {};
  purchases.forEach(pur => {
    const supplierIdStr = pur.supplier?.id?.toString();
    if (!supplierIdStr) return;
    
    if (!supplierTransactions[supplierIdStr]) {
      supplierTransactions[supplierIdStr] = {
        supplier: pur.supplier,
        transactions: [],
        totalInvoiced: 0,
        totalPaid: 0,
        balance: 0
      };
    }
    
    supplierTransactions[supplierIdStr].transactions.push({
      date: pur.purchaseDate,
      type: 'purchase',
      reference: pur.purchaseNumber,
      amount: Number(pur.totalAmount || 0),
      paid: 0,
      balance: Number(pur.totalAmount || 0)
    });
    
    supplierTransactions[supplierIdStr].totalInvoiced += Number(pur.totalAmount || 0);
    supplierTransactions[supplierIdStr].totalPaid += 0;
    supplierTransactions[supplierIdStr].balance += Number(pur.totalAmount || 0);
  });

  return Object.values(supplierTransactions);
};

// Generate Top Clients by Revenue Report
const generateTopClientsByRevenueReport = async (companyId, startDate, endDate, limit = 20) => {
  const topClientRows = await dbClient().invoice.groupBy({
    by: ['clientId'],
    where: { companyId: String(companyId), status: { in: ['fully_paid', 'partially_paid'] }, invoiceDate: { gte: startDate, lte: endDate } },
    _sum: { totalAmount: true, amountPaid: true, amountOutstanding: true }, _count: { _all: true },
    orderBy: { _sum: { totalAmount: 'desc' } }, take: Math.min(Number(limit) || 20, 100),
  });
  const topClientIds = topClientRows.map((row) => row.clientId).filter(Boolean);
  const topClientDocs = topClientIds.length ? await Client.find({ _id: { $in: topClientIds } }, 'name code contact').lean() : [];
  const topClientMap = new Map(topClientDocs.map((row) => [String(row._id), row]));
  const topClients = topClientRows.map((row) => ({
    _id: topClientMap.get(row.clientId) || row.clientId,
    revenue: Number(row._sum.totalAmount || 0), invoiceCount: row._count._all,
    totalPaid: Number(row._sum.amountPaid || 0), totalBalance: Number(row._sum.amountOutstanding || 0),
  }));

  return topClients.map(c => ({
    client: c._id,
    revenue: c.revenue,
    invoiceCount: c.invoiceCount,
    totalPaid: c.totalPaid,
    totalBalance: c.totalBalance
  }));
};

// Generate Top Suppliers by Purchase Report
const generateTopSuppliersByPurchaseReport = async (companyId, startDate, endDate, limit = 20) => {
  const topSupplierRows = await dbClient().purchase.groupBy({
    by: ['supplierId'],
    where: { companyId: String(companyId), status: { in: ['received', 'completed', 'partial'] }, purchaseDate: { gte: startDate, lte: endDate } },
    _sum: { totalAmount: true }, _count: { _all: true },
    orderBy: { _sum: { totalAmount: 'desc' } }, take: Math.min(Number(limit) || 20, 100),
  });
  const topSupplierIds = topSupplierRows.map((row) => row.supplierId);
  const topSupplierDocs = await Supplier.find({ _id: { $in: topSupplierIds } }, 'name code contact').lean();
  const topSupplierMap = new Map(topSupplierDocs.map((row) => [String(row._id), row]));
  const topSuppliers = topSupplierRows.map((row) => ({ _id: topSupplierMap.get(row.supplierId) || row.supplierId, total: Number(row._sum.totalAmount || 0), purchaseCount: row._count._all, totalPaid: 0, totalBalance: Number(row._sum.totalAmount || 0) }));

  return topSuppliers.map(s => ({
    supplier: s._id,
    total: s.total,
    purchaseCount: s.purchaseCount,
    totalPaid: s.totalPaid,
    totalBalance: s.totalBalance
  }));
};

// Generate Client Credit Limit Report
const generateClientCreditLimitReport = async (companyId) => {
  const clients = await Client.find({ company: companyId, isActive: true })
    .select('name code contact creditLimit outstandingBalance totalPurchases lastPurchaseDate');

  return clients.map(client => {
    const creditLimit = client.creditLimit || 0;
    const outstandingBalance = client.outstandingBalance || 0;
    const creditUtilization = creditLimit > 0 ? (outstandingBalance / creditLimit) * 100 : 0;
    
    return {
      _id: client._id,
      code: client.code,
      name: client.name,
      contact: client.contact,
      creditLimit,
      outstandingBalance,
      availableCredit: Math.max(0, creditLimit - outstandingBalance),
      creditUtilization: Math.round(creditUtilization * 100) / 100,
      status: creditUtilization > 100 ? 'over_limit' : (creditUtilization > 80 ? 'warning' : 'ok')
    };
  });
};

// Generate New Clients Report
const generateNewClientsReport = async (companyId, startDate, endDate, limit = 100) => {
  const clients = await Client.find({
    company: companyId,
    createdAt: { $gte: startDate, $lte: endDate }
  })
  .select('name code contact createdAt totalPurchases outstandingBalance')
  .sort({ createdAt: -1 })
  .limit(limit);

  return clients.map(client => ({
    _id: client._id,
    code: client.code,
    name: client.name,
    contact: client.contact,
    createdAt: client.createdAt,
    totalPurchases: client.totalPurchases || 0,
    outstandingBalance: client.outstandingBalance || 0
  }));
};

// Generate Inactive Clients Report
const generateInactiveClientsReport = async (companyId, days = 90, limit = 100) => {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const clients = await Client.find({
    company: companyId,
    isActive: true
  })
  .select('name code contact createdAt lastPurchaseDate totalPurchases outstandingBalance')
  .lean();

  const inactiveClients = clients.filter(client => {
    const lastPurchase = client.lastPurchaseDate ? new Date(client.lastPurchaseDate) : null;
    return !lastPurchase || lastPurchase < cutoffDate;
  }).map(client => {
    const lastPurchase = client.lastPurchaseDate ? new Date(client.lastPurchaseDate) : null;
    const daysSinceLastPurchase = lastPurchase 
      ? Math.floor((new Date() - lastPurchase) / (1000 * 60 * 60 * 24))
      : null;
    
    return {
      _id: client._id,
      code: client.code,
      name: client.name,
      contact: client.contact,
      createdAt: client.createdAt,
      lastPurchaseDate: client.lastPurchaseDate,
      daysSinceLastPurchase,
      totalPurchases: client.totalPurchases || 0,
      outstandingBalance: client.outstandingBalance || 0
    };
  }).sort((a, b) => {
    if (a.daysSinceLastPurchase === null) return -1;
    if (b.daysSinceLastPurchase === null) return 1;
    return b.daysSinceLastPurchase - a.daysSinceLastPurchase;
  }).slice(0, limit);

  return inactiveClients;
};

// Generate Purchase by Product Report
const generatePurchaseByProductReport = async (companyId, startDate, endDate, limit = 50) => {
  const purchases = await dbClient().purchase.findMany({
    where: {
      companyId: String(companyId),
      status: { in: ['received', 'paid', 'partial'] },
      ...(startDate || endDate ? { purchaseDate: { ...(startDate ? { gte: new Date(startDate) } : {}), ...(endDate ? { lte: new Date(endDate) } : {}) } } : {}),
    },
    include: {
      supplier: { select: { id: true, name: true } },
      lines: { include: { product: { select: { id: true, name: true, sku: true, categoryId: true } } } },
    },
  });

  // Group by product
  const productData = {};
  purchases.forEach(purchase => {
    purchase.lines.forEach(item => {
      const productId = item.product?.id?.toString();
      if (!productId) return;
      
      if (!productData[productId]) {
        productData[productId] = {
          product: item.product,
          supplier: purchase.supplier,
                    supplier: legacyRelation(purchase.supplier),
          totalQuantity: 0,
          totalAmount: 0,
          purchaseCount: 0
        };
      }
      productData[productId].totalQuantity += Number(item.qty || 0);
      productData[productId].totalAmount += Number(item.lineTotal || 0);
      productData[productId].purchaseCount += 1;
    });
  });

  const report = Object.values(productData)
    .sort((a, b) => b.totalAmount - a.totalAmount)
    .slice(0, limit);

  const summary = {
    totalProducts: report.length,
    totalQuantity: report.reduce((sum, p) => sum + p.totalQuantity, 0),
    totalAmount: report.reduce((sum, p) => sum + p.totalAmount, 0)
  };

  return { data: report, summary };
};

// Generate Purchase by Category Report
const generatePurchaseByCategoryReport = async (companyId, startDate, endDate) => {
  const purchases = await dbClient().purchase.findMany({
    where: {
      companyId: String(companyId),
      status: { in: ['received', 'paid', 'partial'] },
      ...(startDate || endDate ? { purchaseDate: { ...(startDate ? { gte: new Date(startDate) } : {}), ...(endDate ? { lte: new Date(endDate) } : {}) } } : {}),
    },
    include: { lines: { include: { product: { include: { category: { select: { id: true, name: true } } } } } } },
  });

  // Group by category
  const categoryData = {};
  purchases.forEach(purchase => {
    purchase.lines.forEach(item => {
      const categoryId = item.product?.category?.id?.toString() || 'uncategorized';
      const categoryName = item.product?.category?.name || 'Uncategorized';
      
      if (!categoryData[categoryId]) {
        categoryData[categoryId] = {
          category: categoryName,
          totalQuantity: 0,
          totalAmount: 0,
          productCount: 0,
          purchaseCount: 0
        };
      }
      categoryData[categoryId].totalQuantity += Number(item.qty || 0);
      categoryData[categoryId].totalAmount += Number(item.lineTotal || 0);
      categoryData[categoryId].productCount += 1;
      categoryData[categoryId].purchaseCount += 1;
    });
  });

  const report = Object.values(categoryData)
    .sort((a, b) => b.totalAmount - a.totalAmount);

  const summary = {
    totalCategories: report.length,
    totalQuantity: report.reduce((sum, c) => sum + c.totalQuantity, 0),
    totalAmount: report.reduce((sum, c) => sum + c.totalAmount, 0)
  };

  return { data: report, summary };
};

// Generate Accounts Payable Report
const generateAccountsPayableReport = async (companyId) => {
  const purchases = await loadPayablesForReport(companyId);

  const report = purchases.map(p => ({
    _id: p._id,
    purchaseNumber: p.purchaseNumber,
    supplier: p.supplier,
    purchaseDate: p.purchaseDate,
    expectedDeliveryDate: p.expectedDeliveryDate,
    dueDate: p.expectedDeliveryDate,
    subtotal: p.subtotal || 0,
    tax: p.totalTax || 0,
    total: p.grandTotal || 0,
    paid: p.amountPaid || 0,
    balance: p.balance || 0,
    status: p.status
  }));

  // Calculate aging buckets
  const now = new Date();
  const buckets = { current: [], '1-30': [], '31-60': [], '61-90': [], '90+': [] };
  
  report.forEach(inv => {
    const due = inv.dueDate || inv.purchaseDate;
    const days = Math.floor((now - new Date(due)) / (1000 * 60 * 60 * 24));
    
    if (days <= 0) buckets.current.push(inv);
    else if (days <= 30) buckets['1-30'].push(inv);
    else if (days <= 60) buckets['31-60'].push(inv);
    else if (days <= 90) buckets['61-90'].push(inv);
    else buckets['90+'].push(inv);
  });

  const summary = {
    totalPayable: report.reduce((sum, p) => sum + p.balance, 0),
    totalInvoices: report.length,
    buckets: {
      current: { count: buckets.current.length, total: buckets.current.reduce((s, p) => s + p.balance, 0) },
      '1-30': { count: buckets['1-30'].length, total: buckets['1-30'].reduce((s, p) => s + p.balance, 0) },
      '31-60': { count: buckets['31-60'].length, total: buckets['31-60'].reduce((s, p) => s + p.balance, 0) },
      '61-90': { count: buckets['61-90'].length, total: buckets['61-90'].reduce((s, p) => s + p.balance, 0) },
      '90+': { count: buckets['90+'].length, total: buckets['90+'].reduce((s, p) => s + p.balance, 0) }
    }
  };

  return { data: report, buckets, summary };
};

// Generate Supplier Aging Report
const generateSupplierAgingReport = async (companyId) => {
  const purchases = await loadPayablesForReport(companyId);

  // Group by supplier
  const supplierData = {};
  const now = new Date();

  purchases.forEach(purchase => {
    const supplierId = purchase.supplier?.id?.toString();
    if (!supplierId) return;

    if (!supplierData[supplierId]) {
      supplierData[supplierId] = {
        supplier: purchase.supplier,
        totalBalance: 0,
        invoices: []
      };
    }

    const due = purchase.expectedDeliveryDate || purchase.purchaseDate;
    const days = Math.floor((now - new Date(due)) / (1000 * 60 * 60 * 24));
    
    supplierData[supplierId].totalBalance += purchase.balance || 0;
    supplierData[supplierId].invoices.push({
      purchaseNumber: purchase.purchaseNumber,
      date: purchase.purchaseDate,
      dueDate: due,
      daysOverdue: days,
      amount: purchase.grandTotal || 0,
      balance: purchase.balance || 0
    });
  });

  const report = Object.values(supplierData)
    .map(s => ({
      ...s,
      totalBalance: s.totalBalance || 0
    }))
    .sort((a, b) => b.totalBalance - a.totalBalance);

  const summary = {
    totalSuppliers: report.length,
    totalOutstanding: report.reduce((sum, s) => sum + s.totalBalance, 0)
  };

  return { data: report, summary };
};

// Generate Purchase Returns Report
const generatePurchaseReturnsReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['approved', 'refunded', 'partially_refunded'] }
  };

  if (startDate || endDate) {
    matchStage.returnDate = {};
    if (startDate) matchStage.returnDate.$gte = new Date(startDate);
    if (endDate) matchStage.returnDate.$lte = new Date(endDate);
  }

  const returns = await dbClient().purchaseReturn.findMany({
    where: {
      companyId: String(companyId),
      status: { in: ['approved', 'refunded', 'partially_refunded'] },
      ...(startDate || endDate ? { returnDate: { ...(startDate ? { gte: new Date(startDate) } : {}), ...(endDate ? { lte: new Date(endDate) } : {}) } } : {}),
    },
    include: {
      supplier: { select: { id: true, name: true, code: true } },
      grn: { select: { id: true, referenceNo: true } },
    },
    orderBy: { returnDate: 'desc' },
  });

  const report = returns.map(r => ({
    _id: r.id,
    returnNumber: r.referenceNo,
    supplier: legacyRelation(r.supplier),
    purchase: r.grn ? { _id: r.grn.id, purchaseNumber: r.grn.referenceNo } : null,
    returnDate: r.returnDate,
    subtotal: Number(r.totalAmount || 0),
    tax: 0,
    total: Number(r.totalAmount || 0),
    refundAmount: 0,
    status: r.status,
    reason: r.reason
  }));

  const summary = {
    totalReturns: report.length,
    totalAmount: report.reduce((sum, r) => sum + r.total, 0),
    totalRefunded: report.reduce((sum, r) => sum + r.refundAmount, 0),
    byStatus: {
      approved: report.filter(r => r.status === 'approved').length,
      refunded: report.filter(r => r.status === 'refunded').length,
      partially_refunded: report.filter(r => r.status === 'partially_refunded').length
    }
  };

  return { data: report, summary };
};

// Generate Purchase Order Status Report
const generatePurchaseOrderStatusReport = async (companyId, startDate, endDate) => {
  const purchases = await dbClient().purchaseOrder.findMany({
    where: {
      companyId: String(companyId),
      ...(startDate || endDate ? { orderDate: { ...(startDate ? { gte: new Date(startDate) } : {}), ...(endDate ? { lte: new Date(endDate) } : {}) } } : {}),
    },
    include: {
      supplier: { select: { id: true, name: true, code: true } },
      lines: { include: { product: { select: { id: true, name: true, sku: true } } } },
    },
    orderBy: { orderDate: 'desc' },
  });

  const statusGroups = {
    draft: [],
    ordered: [],
    received: [],
    partial: [],
    paid: [],
    cancelled: []
  };

  purchases.forEach(purchase => {
    const status = purchase.status || 'draft';
    if (statusGroups[status]) {
      statusGroups[status].push({
        _id: purchase.id,
        purchaseNumber: purchase.referenceNo,
        supplier: purchase.supplier,
        purchaseDate: purchase.orderDate,
        expectedDeliveryDate: purchase.expectedDeliveryDate,
        subtotal: Number(purchase.subtotal || 0),
        tax: Number(purchase.taxAmount || 0),
        total: Number(purchase.totalAmount || 0),
        paid: Number(purchase.amountPaid || 0),
        balance: Number(purchase.balance || 0),
        itemsCount: purchase.lines?.length || 0
      });
    }
  });

  const summary = {
    totalOrders: purchases.length,
    byStatus: {
      draft: { count: statusGroups.draft.length, total: statusGroups.draft.reduce((s, p) => s + p.total, 0) },
      ordered: { count: statusGroups.ordered.length, total: statusGroups.ordered.reduce((s, p) => s + p.total, 0) },
      received: { count: statusGroups.received.length, total: statusGroups.received.reduce((s, p) => s + p.total, 0) },
      partial: { count: statusGroups.partial.length, total: statusGroups.partial.reduce((s, p) => s + p.total, 0) },
      paid: { count: statusGroups.paid.length, total: statusGroups.paid.reduce((s, p) => s + p.total, 0) },
      cancelled: { count: statusGroups.cancelled.length, total: statusGroups.cancelled.reduce((s, p) => s + p.total, 0) }
    }
  };

  return { data: statusGroups, summary };
};

// Generate Supplier Performance Report
const generateSupplierPerformanceReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['received', 'paid', 'partial'] }
  };

  if (startDate || endDate) {
    matchStage.purchaseDate = {};
    if (startDate) matchStage.purchaseDate.$gte = new Date(startDate);
    if (endDate) matchStage.purchaseDate.$lte = new Date(endDate);
  }

  const purchases = await loadPurchasesForReport(companyId, {
    status: { in: ['received', 'paid', 'partial'] },
    ...(startDate || endDate ? { purchaseDate: { ...(startDate ? { gte: new Date(startDate) } : {}), ...(endDate ? { lte: new Date(endDate) } : {}) } } : {}),
  });

  // Group by supplier and calculate metrics
  const supplierMetrics = {};
  
  purchases.forEach(purchase => {
    const supplierId = purchase.supplier?.id?.toString();
    if (!supplierId) return;

    if (!supplierMetrics[supplierId]) {
      supplierMetrics[supplierId] = {
        supplier: purchase.supplier,
        totalOrders: 0,
        totalAmount: 0,
        onTimeDeliveries: 0,
        lateDeliveries: 0,
        totalItems: 0,
        returns: 0
      };
    }

    supplierMetrics[supplierId].totalOrders += 1;
    supplierMetrics[supplierId].totalAmount += purchase.grandTotal || 0;
    supplierMetrics[supplierId].totalItems += purchase.items?.length || 0;

    // Calculate delivery performance
    if (purchase.expectedDeliveryDate && purchase.purchaseDate) {
      const expected = new Date(purchase.expectedDeliveryDate);
      const actual = new Date(purchase.purchaseDate);
      const daysDiff = Math.floor((actual - expected) / (1000 * 60 * 60 * 24));
      
      if (daysDiff <= 0) {
        supplierMetrics[supplierId].onTimeDeliveries += 1;
      } else {
        supplierMetrics[supplierId].lateDeliveries += 1;
      }
    }
  });

  const report = Object.values(supplierMetrics).map(s => ({
    ...s,
    onTimeRate: s.totalOrders > 0 ? (s.onTimeDeliveries / s.totalOrders) * 100 : 0,
    avgOrderValue: s.totalOrders > 0 ? s.totalAmount / s.totalOrders : 0
  })).sort((a, b) => b.totalAmount - a.totalAmount);

  const summary = {
    totalSuppliers: report.length,
    totalOrders: report.reduce((sum, s) => sum + s.totalOrders, 0),
    totalAmount: report.reduce((sum, s) => sum + s.totalAmount, 0),
    avgOnTimeRate: report.length > 0 
      ? report.reduce((sum, s) => sum + s.onTimeRate, 0) / report.length 
      : 0
  };

  return { data: report, summary };
};

// Main function to generate all reports for a period
const generateAllReports = async (companyId, periodType, year, periodNumber, userId = null) => {
  const { startDate, endDate, label } = getPeriodDates(periodType, year, periodNumber);

  // Get previous period for comparison
  let previousPeriodInfo;
  if (periodType === 'monthly') {
    previousPeriodInfo = periodNumber === 1 
      ? { year: year - 1, periodNumber: 12 }
      : { year, periodNumber: periodNumber - 1 };
  } else if (periodType === 'quarterly') {
    previousPeriodInfo = periodNumber === 1
      ? { year: year - 1, periodNumber: 4 }
      : { year, periodNumber: periodNumber - 1 };
  }

  // Generate all report types
  const reportTypes = [
    { type: 'profit-loss', generator: generateProfitLossReport },
    { type: 'balance-sheet', generator: generateBalanceSheetReport },
    { type: 'vat-summary', generator: generateVATSummaryReport },
    { type: 'product-performance', generator: generateProductPerformanceReport },
    { type: 'customer-summary', generator: generateTopCustomersReport }
  ];

  const snapshots = [];

  for (const { type, generator } of reportTypes) {
    // Declared outside the try so the catch can mark the snapshot as failed.
    let snapshot = null;
    try {
      // Check if snapshot already exists (completed). Use atomic upsert to avoid
      // duplicate key errors when multiple schedulers attempt to create the
      // same snapshot concurrently.
      const snapshotFilter = {
        company: companyId,
        reportType: type,
        periodType,
        year,
        periodNumber
      };

      // Try to find a completed snapshot first
      snapshot = await ReportSnapshot.findOne({ ...snapshotFilter, status: 'completed' });

      if (!snapshot) {
        // Create or mark in-progress atomically
        const upsertDoc = {
          $setOnInsert: {
            company: companyId,
            reportType: type,
            periodType,
            year,
            periodNumber,
            periodStart: startDate,
            periodEnd: endDate,
            periodLabel: label,
            generatedBy: userId
          },
          $set: {
            status: 'in-progress',
            updatedAt: new Date()
          }
        };

        try {
          snapshot = await ReportSnapshot.findOneAndUpdate(snapshotFilter, upsertDoc, {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true
          });
        } catch (err) {
          if (err.code === 11000) {
            snapshot = await ReportSnapshot.findOne(snapshotFilter);
            if (snapshot && snapshot.status === 'completed') {
              snapshots.push(snapshot);
              continue;
            }
            if (snapshot) {
              snapshot.status = 'in-progress';
              snapshot.data = null;
              await snapshot.save();
            }
          } else {
            throw err;
          }
        }
      } else {
        snapshot.status = 'in-progress';
        await snapshot.save();
      }

      // Generate the report data
      let data;
      try {
        if (type === 'balance-sheet') {
          data = await generator(companyId, endDate);
        } else {
          data = await generator(companyId, startDate, endDate);
        }
      } catch (genError) {
        console.error(`Error generating ${type} data:`, genError.message);
        data = { error: genError.message };
      }

      if (!data) {
        data = {};
      }

      // Create summary
      let summary = {};
      if (type === 'profit-loss') {
        summary = {
          revenue: data.revenue?.netRevenue || 0,
          cogs: data.cogs?.totalCOGS || 0,
          grossProfit: data.grossProfit?.amount || 0,
          netProfit: data.netProfit?.amount || 0
        };
      } else if (type === 'balance-sheet') {
        summary = {
          totalAssets: data.assets?.totalAssets || 0,
          totalLiabilities: data.liabilities?.totalLiabilities || 0,
          totalEquity: data.equity?.total || 0
        };
      }

      // Get top products
      let topProducts = [];
      if (type === 'product-performance') {
        topProducts = data.slice(0, 5).map(p => ({
          productId: p.product,
          productName: p.productName,
          revenue: p.revenue,
          quantity: p.quantitySold,
          profit: p.margin
        }));
      }

      // Get top customers
      let topCustomers = [];
      if (type === 'customer-summary') {
        topCustomers = data.slice(0, 5).map(c => ({
          customerId: c._id,
          customerName: c.clientName,
          revenue: c.revenue,
          orders: c.orders
        }));
      }

      // Update snapshot with data
      snapshot.data = data;
      snapshot.summary = summary;
      snapshot.topProducts = topProducts;
      snapshot.topCustomers = topCustomers;
      snapshot.status = 'completed';
      snapshot.generatedAt = new Date();
      snapshot.calculationSource = 'snapshot';

      // Add comparison with previous period
      if (previousPeriodInfo) {
        const previousSnapshot = await ReportSnapshot.findOne({
          company: companyId,
          reportType: type,
          periodType,
          year: previousPeriodInfo.year,
          periodNumber: previousPeriodInfo.periodNumber,
          status: 'completed'
        });

        if (previousSnapshot) {
          const prevRevenue = previousSnapshot.summary?.revenue || 0;
          const prevProfit = previousSnapshot.summary?.netProfit || 0;
          const currRevenue = summary.revenue || 0;
          const currProfit = summary.netProfit || 0;

          snapshot.comparison = {
            previousSnapshotId: previousSnapshot._id,
            revenueChangePercent: prevRevenue > 0 ? ((currRevenue - prevRevenue) / prevRevenue) * 100 : 0,
            profitChangePercent: prevProfit > 0 ? ((currProfit - prevProfit) / prevProfit) * 100 : 0,
            revenueChange: currRevenue - prevRevenue,
            profitChange: currProfit - prevProfit
          };
        }
      }

      await snapshot.save();
      snapshots.push(snapshot);
    } catch (error) {
      console.error(`Error generating ${type} snapshot:`, error);
      if (snapshot?._id) {
        await ReportSnapshot.findOneAndUpdate(
          { _id: snapshot._id },
          { status: 'failed', errorMessage: error.message }
        );
      }
    }
  }

  return snapshots;
};

// Get report data (either live or from snapshot)
const getReportData = async (companyId, reportType, periodType, year, periodNumber, clientId = null, supplierId = null) => {
  // Get current period info if not provided
  if (!year || !periodNumber) {
    const currentInfo = getCurrentPeriodInfo(periodType);
    year = currentInfo.year;
    periodNumber = currentInfo.periodNumber;
  }

  const { startDate, endDate, label } = getPeriodDates(periodType, year, periodNumber);

  // Check if this is current period (live calculation) or past period (use snapshot)
  const currentPeriod = getCurrentPeriodInfo(periodType);
  const isCurrentPeriod = year === currentPeriod.year && periodNumber === currentPeriod.periodNumber;

  if (!isCurrentPeriod) {
    // Try to get from snapshot first
    const snapshot = await ReportSnapshot.findOne({
      company: companyId,
      reportType,
      periodType,
      year,
      periodNumber,
      status: 'completed'
    });

    if (snapshot) {
      return {
        data: snapshot.data,
        summary: snapshot.summary,
        topProducts: snapshot.topProducts,
        topCustomers: snapshot.topCustomers,
        comparison: snapshot.comparison,
        periodLabel: snapshot.periodLabel,
        calculationSource: 'snapshot',
        generatedAt: snapshot.generatedAt
      };
    }
  }

  // Calculate on the fly
  let data;
  switch (reportType) {
    case 'profit-loss':
      data = await generateProfitLossReport(companyId, startDate, endDate);
      break;
    case 'balance-sheet':
      data = await generateBalanceSheetReport(companyId, endDate);
      break;
    case 'vat-summary':
      data = await generateVATSummaryReport(companyId, startDate, endDate);
      break;
    case 'product-performance':
      data = await generateProductPerformanceReport(companyId, startDate, endDate);
      break;
    case 'customer-summary':
    case 'top-clients':
      data = await generateTopClientsByRevenueReport(companyId, startDate, endDate);
      break;
    case 'client-statement':
      data = await generateClientStatementReport(companyId, startDate, endDate, clientId);
      break;
    case 'supplier-statement':
      data = await generateSupplierStatementReport(companyId, startDate, endDate, supplierId);
      break;
    case 'top-suppliers':
      data = await generateTopSuppliersByPurchaseReport(companyId, startDate, endDate);
      break;
    case 'credit-limit':
      data = await generateClientCreditLimitReport(companyId);
      break;
    case 'new-clients':
      data = await generateNewClientsReport(companyId, startDate, endDate);
      break;
    case 'inactive-clients':
      data = await generateInactiveClientsReport(companyId, 90, 100);
      break;
    case 'purchase-by-product':
      data = await generatePurchaseByProductReport(companyId, startDate, endDate);
      break;
    case 'purchase-by-category':
      data = await generatePurchaseByCategoryReport(companyId, startDate, endDate);
      break;
    case 'accounts-payable':
      data = await generateAccountsPayableReport(companyId);
      break;
    case 'supplier-aging':
      data = await generateSupplierAgingReport(companyId);
      break;
    case 'purchase-returns':
      data = await generatePurchaseReturnsReport(companyId, startDate, endDate);
      break;
    case 'purchase-order-status':
      data = await generatePurchaseOrderStatusReport(companyId, startDate, endDate);
      break;
    case 'supplier-performance':
      data = await generateSupplierPerformanceReport(companyId, startDate, endDate);
      break;
    case 'sales-by-product':
      data = await generateProductPerformanceReport(companyId, startDate, endDate);
      break;
    case 'sales-by-category':
      data = await generateSalesByCategoryReport(companyId, startDate, endDate);
      break;
    case 'sales-by-client':
      data = await generateSalesByClientReport(companyId, startDate, endDate);
      break;
    case 'sales-by-salesperson':
      data = await generateSalesBySalespersonReport(companyId, startDate, endDate);
      break;
    case 'invoice-aging':
      data = await generateInvoiceAgingReport(companyId);
      break;
    case 'accounts-receivable':
      data = await generateAccountsReceivableReport(companyId);
      break;
    case 'credit-notes':
      data = await generateCreditNotesReport(companyId, startDate, endDate);
      break;
    case 'quotation-conversion':
      data = await generateQuotationConversionReport(companyId, startDate, endDate);
      break;
    case 'recurring-invoice':
      data = await generateRecurringInvoiceReport(companyId);
      break;
    case 'discount-report':
      data = await generateDiscountReport(companyId, startDate, endDate);
      break;
    case 'daily-sales-summary':
      data = await generateDailySalesSummaryReport(companyId, startDate, endDate);
      break;
    // ============================================
    // EXPENSE REPORTS
    // ============================================
    case 'expense-by-category':
      data = await generateExpenseByCategoryReport(companyId, startDate, endDate);
      break;
    case 'expense-by-period':
      data = await generateExpenseByPeriodReport(companyId, startDate, endDate);
      break;
    case 'expense-vs-budget':
      data = await generateExpenseVsBudgetReport(companyId, startDate, endDate);
      break;
    case 'employee-expense':
      data = await generateEmployeeExpenseReport(companyId, startDate, endDate);
      break;
    case 'petty-cash':
      data = await generatePettyCashReport(companyId, startDate, endDate);
      break;
    // ============================================
    // STOCK & INVENTORY REPORTS
    // ============================================
    case 'stock-valuation':
      data = await generateStockValuationReport(companyId);
      break;
    // Tax Reports
    case 'vat-return':
      data = await generateVATReturnReport(companyId, startDate, endDate);
      break;
    case 'paye-report':
      data = await generatePAYEReport(companyId, startDate, endDate);
      break;
    case 'withholding-tax':
      data = await generateWithholdingTaxReport(companyId, startDate, endDate);
      break;
    case 'corporate-tax':
      data = await generateCorporateTaxReport(companyId, startDate, endDate);
      break;
    case 'tax-payment-history':
      data = await generateTaxPaymentHistory(companyId, startDate, endDate);
      break;
    case 'tax-calendar':
      data = await generateTaxCalendarReport(companyId, startDate);
      break;
    // Asset Reports
    case 'asset-register':
      data = await generateAssetRegisterReport(companyId);
      break;
    case 'depreciation-schedule':
      data = await generateDepreciationScheduleReport(companyId, startDate, endDate);
      break;
    case 'asset-disposal':
      data = await generateAssetDisposalReport(companyId, startDate, endDate);
      break;
    case 'asset-maintenance':
      data = await generateAssetMaintenanceReport(companyId, startDate, endDate);
      break;
    case 'net-book-value':
      data = await generateNetBookValueReport(companyId);
      break;
    case 'stock-movement':
      data = await generateStockMovementReport(companyId, startDate, endDate);
      break;
    case 'low-stock':
      data = await generateLowStockReport(companyId);
      break;
    case 'dead-stock':
      data = await generateDeadStockReport(companyId);
      break;
    case 'stock-aging':
      data = await generateStockAgingReport(companyId);
      break;
    case 'inventory-turnover':
      data = await generateInventoryTurnoverReport(companyId, startDate, endDate);
      break;
    case 'batch-expiry':
      data = await generateBatchExpiryReport(companyId);
      break;
    case 'serial-number-tracking':
      data = await generateSerialNumberTrackingReport(companyId);
      break;
    case 'warehouse-stock':
      data = await generateWarehouseStockReport(companyId);
      break;
    // ============================================
    // BANK & CASH REPORTS
    // ============================================
    case 'bank-reconciliation':
      data = await generateBankReconciliationReport(companyId, startDate, endDate);
      break;
    case 'cash-position':
      data = await generateCashPositionReport(companyId);
      break;
    case 'bank-transaction':
      data = await generateBankTransactionReport(companyId, startDate, endDate);
      break;
    case 'unreconciled-transactions':
      data = await generateUnreconciledTransactionsReport(companyId, startDate, endDate);
      break;
    // ============================================
    // ADDITIONAL REPORT TYPES NEEDED BY FRONTEND
    // ============================================
    case 'sales-summary':
      data = await generateSalesSummaryReport(companyId, startDate, endDate);
      break;
    case 'purchases':
      data = await generatePurchaseByProductReport(companyId, startDate, endDate);
      break;
    case 'suppliers':
      data = await generateTopSuppliersByPurchaseReport(companyId, startDate, endDate);
      break;
    case 'aging':
      data = await generateInvoiceAgingReport(companyId);
      break;
    case 'cash-flow':
      data = await generateCashFlowReport(companyId, startDate, endDate);
      break;
    case 'financial-ratios':
      data = await generateFinancialRatiosReport(companyId, startDate, endDate);
      break;
    case 'top-products':
      data = await generateProductPerformanceReport(companyId, startDate, endDate);
      break;
    case 'top-customers':
      data = await generateTopClientsByRevenueReport(companyId, startDate, endDate);
      break;
    default:
      throw new Error(`Unknown report type: ${reportType}`);
  }

  return {
    data,
    periodLabel: label,
    calculationSource: 'live',
    periodStart: startDate,
    periodEnd: endDate
  };
};

// Generate Sales by Category Report
const generateSalesByCategoryReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['paid', 'partial', 'confirmed'] }
  };

  if (startDate || endDate) {
    matchStage.invoiceDate = {};
    if (startDate) matchStage.invoiceDate.$gte = new Date(startDate);
    if (endDate) matchStage.invoiceDate.$lte = new Date(endDate);
  }

  const salesByCategory = await dbClient().$queryRaw(Prisma.sql`
    SELECT c.id AS category, COALESCE(c.name, 'Uncategorized') AS "categoryName",
           COALESCE(SUM(il.qty * il.unit_price), 0) AS "totalRevenue",
           COALESCE(SUM(il.qty), 0) AS "totalQuantity", COUNT(DISTINCT i.id)::int AS "orderCount"
    FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
    LEFT JOIN products p ON p.id = il.product_id LEFT JOIN categories c ON c.id = p.category_id
    WHERE i.company_id = ${String(companyId)} AND i.status IN ('fully_paid', 'partially_paid', 'confirmed')
      ${startDate ? Prisma.sql`AND i.invoice_date >= ${new Date(startDate)}` : Prisma.empty}
      ${endDate ? Prisma.sql`AND i.invoice_date <= ${new Date(endDate)}` : Prisma.empty}
    GROUP BY c.id, c.name ORDER BY "totalRevenue" DESC
  `);
  for (const row of salesByCategory) { row.totalRevenue = Number(row.totalRevenue || 0); row.totalQuantity = Number(row.totalQuantity || 0); }

  const summary = {
    totalCategories: salesByCategory.length,
    totalRevenue: salesByCategory.reduce((sum, c) => sum + c.totalRevenue, 0),
    totalQuantity: salesByCategory.reduce((sum, c) => sum + c.totalQuantity, 0)
  };

  return { data: salesByCategory, summary };
};

// Generate Sales by Client Report
const generateSalesByClientReport = async (companyId, startDate, endDate, limit = 50) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['paid', 'partial', 'confirmed'] }
  };

  if (startDate || endDate) {
    matchStage.invoiceDate = {};
    if (startDate) matchStage.invoiceDate.$gte = new Date(startDate);
    if (endDate) matchStage.invoiceDate.$lte = new Date(endDate);
  }

  const salesByClientRows = await dbClient().invoice.groupBy({
    by: ['clientId'], where: { companyId: String(companyId), status: { in: ['fully_paid', 'partially_paid', 'confirmed'] }, invoiceDate: { gte: startDate, lte: endDate } },
    _sum: { totalAmount: true, amountPaid: true, amountOutstanding: true }, _count: { _all: true }, _min: { invoiceDate: true }, _max: { invoiceDate: true },
    orderBy: { _sum: { totalAmount: 'desc' } }, take: Math.min(Number(limit) || 50, 200),
  });
  const clientIds = salesByClientRows.map((row) => row.clientId).filter(Boolean);
  const clientDocs = clientIds.length ? await Client.find({ _id: { $in: clientIds } }, 'name code contact').lean() : [];
  const clientMap = new Map(clientDocs.map((row) => [String(row._id), row]));
  const salesByClient = salesByClientRows.map((row) => ({ _id: clientMap.get(row.clientId) || row.clientId, totalRevenue: Number(row._sum.totalAmount || 0), totalPaid: Number(row._sum.amountPaid || 0), totalBalance: Number(row._sum.amountOutstanding || 0), invoiceCount: row._count._all, firstInvoice: row._min.invoiceDate, lastInvoice: row._max.invoiceDate }));

  const report = salesByClient.map(c => ({
    client: c._id,
    clientName: c._id?.name || c.clientName,
    totalRevenue: c.totalRevenue,
    totalPaid: c.totalPaid,
    totalBalance: c.totalBalance,
    invoiceCount: c.invoiceCount,
    firstInvoice: c.firstInvoice,
    lastInvoice: c.lastInvoice,
    avgOrderValue: c.invoiceCount > 0 ? c.totalRevenue / c.invoiceCount : 0
  }));

  const summary = {
    totalClients: report.length,
    totalRevenue: report.reduce((sum, c) => sum + c.totalRevenue, 0),
    totalInvoices: report.reduce((sum, c) => sum + c.invoiceCount, 0)
  };

  return { data: report, summary };
};

// Generate Sales by Salesperson Report
const generateSalesBySalespersonReport = async (companyId, startDate, endDate, limit = 50) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['paid', 'partial', 'confirmed'] }
  };

  if (startDate || endDate) {
    matchStage.invoiceDate = {};
    if (startDate) matchStage.invoiceDate.$gte = new Date(startDate);
    if (endDate) matchStage.invoiceDate.$lte = new Date(endDate);
  }

  const salespersonRows = await dbClient().invoice.groupBy({
    by: ['createdById'], where: { companyId: String(companyId), status: { in: ['fully_paid', 'partially_paid', 'confirmed'] }, invoiceDate: { gte: startDate, lte: endDate } },
    _sum: { totalAmount: true, amountPaid: true }, _count: { _all: true }, orderBy: { _sum: { totalAmount: 'desc' } }, take: Math.min(Number(limit) || 50, 200),
  });
  const User = require('../models/User');
  const salespersonIds = salespersonRows.map((row) => row.createdById).filter(Boolean);
  const salespersonDocs = salespersonIds.length ? await User.find({ _id: { $in: salespersonIds } }, 'name email').lean() : [];
  const salespersonMap = new Map(salespersonDocs.map((row) => [String(row._id), row]));
  const salesBySalesperson = salespersonRows.map((row) => ({ _id: salespersonMap.get(row.createdById) || row.createdById, totalRevenue: Number(row._sum.totalAmount || 0), totalPaid: Number(row._sum.amountPaid || 0), invoiceCount: row._count._all }));

  const report = salesBySalesperson.map(s => ({
    salesperson: s._id,
    salespersonName: s._id?.name || s.salespersonName || 'Unknown',
    totalRevenue: s.totalRevenue,
    totalPaid: s.totalPaid,
    invoiceCount: s.invoiceCount,
    avgOrderValue: s.invoiceCount > 0 ? s.totalRevenue / s.invoiceCount : 0
  }));

  const summary = {
    totalSalespersons: report.length,
    totalRevenue: report.reduce((sum, s) => sum + s.totalRevenue, 0),
    totalInvoices: report.reduce((sum, s) => sum + s.invoiceCount, 0)
  };

  return { data: report, summary };
};

// Generate Invoice Aging Report (Accounts Receivable Aging)
const generateInvoiceAgingReport = async (companyId) => {
  const invoices = await dbClient().invoice.findMany({
    where: {
      companyId: String(companyId),
      amountOutstanding: { gt: 0 },
      status: { in: ['sent', 'confirmed', 'partial', 'overdue'] },
    },
    include: { client: { select: { id: true, name: true, code: true, contact: true } } },
  });

  const now = new Date();
  const buckets = {
    current: [],
    '1-30': [],
    '31-60': [],
    '61-90': [],
    '90+': []
  };

  invoices.forEach(inv => {
    const due = inv.dueDate || inv.invoiceDate;
    const days = Math.floor((now - new Date(due)) / (1000 * 60 * 60 * 24));
    const entry = {
      invoice: inv,
      invoiceNumber: inv.referenceNo,
      client: legacyRelation(inv.client),
      invoiceDate: inv.invoiceDate,
      dueDate: due,
      daysOverdue: days,
      total: Number(inv.totalAmount || 0),
      paid: Number(inv.amountPaid || 0),
      balance: Number(inv.amountOutstanding || 0)
    };

    if (days <= 0) buckets.current.push(entry);
    else if (days <= 30) buckets['1-30'].push(entry);
    else if (days <= 60) buckets['31-60'].push(entry);
    else if (days <= 90) buckets['61-90'].push(entry);
    else buckets['90+'].push(entry);
  });

  const summary = {
    totalInvoices: invoices.length,
    totalReceivable: invoices.reduce((sum, inv) => sum + Number(inv.amountOutstanding || 0), 0),
    buckets: {
      current: { count: buckets.current.length, total: buckets.current.reduce((s, inv) => s + inv.balance, 0) },
      '1-30': { count: buckets['1-30'].length, total: buckets['1-30'].reduce((s, inv) => s + inv.balance, 0) },
      '31-60': { count: buckets['31-60'].length, total: buckets['31-60'].reduce((s, inv) => s + inv.balance, 0) },
      '61-90': { count: buckets['61-90'].length, total: buckets['61-90'].reduce((s, inv) => s + inv.balance, 0) },
      '90+': { count: buckets['90+'].length, total: buckets['90+'].reduce((s, inv) => s + inv.balance, 0) }
    }
  };

  return { data: buckets, summary };
};

// Generate Accounts Receivable Report
const generateAccountsReceivableReport = async (companyId) => {
  const invoices = await dbClient().invoice.findMany({
    where: {
      companyId: String(companyId),
      amountOutstanding: { gt: 0 },
      status: { in: ['sent', 'confirmed', 'partial', 'overdue'] },
    },
    include: { client: { select: { id: true, name: true, code: true, contact: true } } },
    orderBy: { invoiceDate: 'desc' },
  });

  const report = invoices.map(inv => ({
    _id: inv.id,
    invoiceNumber: inv.referenceNo,
    client: legacyRelation(inv.client),
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate,
    subtotal: Number(inv.subtotal || 0),
    tax: Number(inv.taxAmount || 0),
    total: Number(inv.totalAmount || 0),
    paid: Number(inv.amountPaid || 0),
    balance: Number(inv.amountOutstanding || 0),
    status: inv.status
  }));

  const summary = {
    totalInvoices: report.length,
    totalReceivable: report.reduce((sum, inv) => sum + inv.balance, 0),
    totalOverdue: report.filter(inv => inv.status === 'overdue').reduce((sum, inv) => sum + inv.balance, 0)
  };

  return { data: report, summary };
};

// Generate Credit Notes Report
const generateCreditNotesReport = async (companyId, startDate, endDate) => {
  const creditNotes = await dbClient().creditNote.findMany({
    where: {
      companyId: String(companyId),
      status: { in: ['draft', 'issued', 'applied', 'refunded', 'partially_refunded'] },
      ...(startDate || endDate ? { creditDate: { ...(startDate ? { gte: new Date(startDate) } : {}), ...(endDate ? { lte: new Date(endDate) } : {}) } } : {}),
    },
    include: {
      client: { select: { id: true, name: true, code: true } },
      invoice: { select: { id: true, referenceNo: true } },
    },
    orderBy: { creditDate: 'desc' },
  });

  const report = creditNotes.map(cn => ({
    _id: cn.id,
    creditNoteNumber: cn.referenceNo,
    client: legacyRelation(cn.client),
    invoice: cn.invoice ? { ...cn.invoice, _id: cn.invoice.id, invoiceNumber: cn.invoice.referenceNo } : null,
    issueDate: cn.creditDate,
    subtotal: Number(cn.subtotal || 0),
    tax: Number(cn.taxAmount || 0),
    total: Number(cn.totalAmount || 0),
    amountUsed: 0,
    balance: 0,
    status: cn.status,
    reason: cn.reason
  }));

  const summary = {
    totalCreditNotes: report.length,
    totalAmount: report.reduce((sum, cn) => sum + cn.total, 0),
    totalUsed: report.reduce((sum, cn) => sum + cn.amountUsed, 0),
    totalBalance: report.reduce((sum, cn) => sum + cn.balance, 0),
    byStatus: {
      draft: report.filter(cn => cn.status === 'draft').length,
      issued: report.filter(cn => cn.status === 'issued').length,
      applied: report.filter(cn => cn.status === 'applied').length,
      refunded: report.filter(cn => cn.status === 'refunded').length,
      partially_refunded: report.filter(cn => cn.status === 'partially_refunded').length
    }
  };

  return { data: report, summary };
};

// Generate Quotation Conversion Report
const generateQuotationConversionReport = async (companyId, startDate, endDate) => {
  const Quotation = require('../models/Quotation');
  
  const matchStage = {
    company: companyId
  };

  if (startDate || endDate) {
    matchStage.quotationDate = {};
    if (startDate) matchStage.quotationDate.$gte = new Date(startDate);
    if (endDate) matchStage.quotationDate.$lte = new Date(endDate);
  }

  const quotations = await dbClient().quotation.findMany({
    where: {
      companyId: String(companyId),
      ...(startDate || endDate ? { quotationDate: { ...(startDate ? { gte: new Date(startDate) } : {}), ...(endDate ? { lte: new Date(endDate) } : {}) } } : {}),
    },
    include: { client: { select: { id: true, name: true, code: true } } },
    orderBy: { quotationDate: 'desc' },
  });
  const creatorIds = [...new Set(quotations.map((quotation) => quotation.createdById).filter(Boolean))];
  const creators = creatorIds.length
    ? await dbClient().user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true } })
    : [];
  const creatorMap = new Map(creators.map((creator) => [creator.id, legacyRelation(creator)]));

  // Group by status
  const statusGroups = {
    draft: [],
    sent: [],
    accepted: [],
    rejected: [],
    expired: [],
    converted: []
  };

  quotations.forEach(q => {
    const status = q.status || 'draft';
    if (statusGroups[status]) {
      statusGroups[status].push({
        _id: q.id,
        quotationNumber: q.referenceNo,
        client: legacyRelation(q.client),
        quotationDate: q.quotationDate,
        validUntil: q.expiryDate,
        subtotal: Number(q.subtotal || 0),
        total: Number(q.totalAmount || 0),
        createdBy: creatorMap.get(q.createdById) || null,
        convertedToInvoice: q.convertedToInvoiceId,
        daysToConvert: q.conversionDate ?
          Math.floor((new Date(q.conversionDate) - new Date(q.quotationDate)) / (1000 * 60 * 60 * 24))
          : null
      });
    }
  });

  const totalQuotations = quotations.length;
  const convertedCount = statusGroups.converted.length;
  const conversionRate = totalQuotations > 0 ? (convertedCount / totalQuotations) * 100 : 0;

  const summary = {
    totalQuotations,
    converted: convertedCount,
    pending: statusGroups.draft.length + statusGroups.sent.length,
    rejected: statusGroups.rejected.length,
    expired: statusGroups.expired.length,
    conversionRate: Math.round(conversionRate * 100) / 100,
    avgDaysToConvert: convertedCount > 0 ? 
      statusGroups.converted.filter(q => q.daysToConvert !== null)
        .reduce((sum, q) => sum + q.daysToConvert, 0) / convertedCount 
      : 0
  };

  return { data: statusGroups, summary };
};

// Generate Recurring Invoice Report
const generateRecurringInvoiceReport = async (companyId) => {
  const RecurringInvoice = require('../models/RecurringInvoice');
  
  const recurringInvoices = await dbClient().recurringInvoice.findMany({
    where: { companyId: String(companyId) },
    include: {
      client: { select: { id: true, name: true, code: true } },
      lines: { include: { product: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const report = recurringInvoices.map(ri => ({
    _id: ri.id,
    name: ri.referenceNo,
    client: legacyRelation(ri.client),
    frequency: ri.schedule?.frequency || ri.schedule?.interval || 'monthly',
    startDate: ri.startDate,
    nextInvoiceDate: ri.nextRunDate,
    endDate: ri.endDate,
    subtotal: ri.lines.reduce((sum, line) => sum + Number(line.qty || 0) * Number(line.unitPrice || 0), 0),
    tax: 0,
    total: ri.lines.reduce((sum, line) => sum + Number(line.qty || 0) * Number(line.unitPrice || 0) * (1 + Number(line.taxRate || 0) / 100), 0),
    status: ri.status,
    lastInvoiceDate: ri.lastRunAt,
    totalInvoiced: 0,
    autoSend: ri.autoConfirm
  }));

  const summary = {
    totalRecurringInvoices: report.length,
    active: report.filter(ri => ri.status === 'active').length,
    paused: report.filter(ri => ri.status === 'paused').length,
    totalMonthlyValue: report
      .filter(ri => ri.status === 'active')
      .reduce((sum, ri) => {
        let monthly = ri.total;
        switch (ri.frequency) {
          case 'weekly': monthly = ri.total * 4; break;
          case 'quarterly': monthly = ri.total / 3; break;
          case 'semi-annual': monthly = ri.total / 6; break;
          case 'annual': monthly = ri.total / 12; break;
        }
        return sum + monthly;
      }, 0)
  };

  return { data: report, summary };
};

// Generate Discount Report
const generateDiscountReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['paid', 'partial', 'confirmed'] }
  };

  if (startDate || endDate) {
    matchStage.invoiceDate = {};
    if (startDate) matchStage.invoiceDate.$gte = new Date(startDate);
    if (endDate) matchStage.invoiceDate.$lte = new Date(endDate);
  }

  const invoices = await dbClient().invoice.findMany({
    where: {
      companyId: String(companyId),
      status: { in: ['paid', 'partial', 'confirmed'] },
      ...(startDate || endDate ? { invoiceDate: { ...(startDate ? { gte: new Date(startDate) } : {}), ...(endDate ? { lte: new Date(endDate) } : {}) } } : {}),
    },
    include: {
      client: { select: { id: true, name: true, code: true } },
      lines: { select: { lineDiscount: true } },
    },
  });

  // Calculate discounts
  let totalItemDiscount = 0;
  let totalInvoiceDiscount = 0;
  let totalSubtotal = 0;

  const discountByClient = {};

  invoices.forEach(inv => {
    const clientId = inv.clientId?.toString();
    
    // Item-level discounts
    let itemDiscount = 0;
    inv.lines?.forEach(item => { itemDiscount += Number(item.lineDiscount || 0); });
    totalItemDiscount += itemDiscount;

    // Invoice-level discount
    const invoiceDiscount = Number(inv.totalDiscount || 0);
    totalInvoiceDiscount += invoiceDiscount;

    totalSubtotal += Number(inv.subtotal || 0);

    // Group by client
    if (clientId) {
      if (!discountByClient[clientId]) {
        discountByClient[clientId] = {
          client: legacyRelation(inv.client),
          itemDiscount: 0,
          invoiceDiscount: 0,
          totalDiscount: 0,
          invoiceCount: 0
        };
      }
      discountByClient[clientId].itemDiscount += itemDiscount;
      discountByClient[clientId].invoiceDiscount += invoiceDiscount;
      discountByClient[clientId].totalDiscount += itemDiscount + invoiceDiscount;
      discountByClient[clientId].invoiceCount += 1;
    }
  });

  const totalDiscount = totalItemDiscount + totalInvoiceDiscount;
  const discountPercentage = totalSubtotal > 0 ? (totalDiscount / totalSubtotal) * 100 : 0;

  const report = {
    invoices: invoices.map(inv => {
      const itemDiscount = (inv.lines || []).reduce((sum, item) => sum + Number(item.lineDiscount || 0), 0);
      return {
        invoiceNumber: inv.referenceNo,
        client: legacyRelation(inv.client),
        invoiceDate: inv.invoiceDate,
        subtotal: Number(inv.subtotal || 0),
        itemDiscount: itemDiscount,
        invoiceDiscount: Number(inv.totalDiscount || 0),
        totalDiscount: itemDiscount + Number(inv.totalDiscount || 0),
        grandTotal: Number(inv.totalAmount || 0)
      };
    }),
    byClient: Object.values(discountByClient)
  };

  const summary = {
    totalInvoices: invoices.length,
    totalSubtotal: totalSubtotal,
    totalItemDiscount: totalItemDiscount,
    totalInvoiceDiscount: totalInvoiceDiscount,
    totalDiscount: totalDiscount,
    discountPercentage: Math.round(discountPercentage * 100) / 100
  };

  return { data: report, summary };
};

// Generate Daily Sales Summary Report
const generateDailySalesSummaryReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['paid', 'partial', 'confirmed'] }
  };

  if (startDate || endDate) {
    matchStage.invoiceDate = {};
    if (startDate) matchStage.invoiceDate.$gte = new Date(startDate);
    if (endDate) matchStage.invoiceDate.$lte = new Date(endDate);
  }

  const dailySales = await dbClient().$queryRaw(Prisma.sql`
    SELECT DATE(invoice_date) AS date, COUNT(*)::int AS "invoiceCount",
           COALESCE(SUM(subtotal), 0) AS subtotal,
           COALESCE(SUM(tax_amount), 0) AS tax,
           COALESCE(SUM(total_discount), 0) AS discount,
           COALESCE(SUM(total_amount), 0) AS total,
           COALESCE(SUM(amount_paid), 0) AS paid,
           COALESCE(SUM(amount_outstanding), 0) AS balance,
           COUNT(DISTINCT client_id)::int AS "uniqueClients"
    FROM invoices
    WHERE company_id = ${String(companyId)} AND status IN ('fully_paid', 'partially_paid', 'confirmed')
      ${startDate ? Prisma.sql`AND invoice_date >= ${new Date(startDate)}` : Prisma.empty}
      ${endDate ? Prisma.sql`AND invoice_date <= ${new Date(endDate)}` : Prisma.empty}
    GROUP BY DATE(invoice_date) ORDER BY date DESC
  `);
  for (const row of dailySales) {
    for (const field of ['subtotal', 'tax', 'discount', 'total', 'paid', 'balance']) row[field] = Number(row[field] || 0);
  }

  const summary = {
    totalDays: dailySales.length,
    totalInvoices: dailySales.reduce((sum, d) => sum + d.invoiceCount, 0),
    totalRevenue: dailySales.reduce((sum, d) => sum + d.total, 0),
    totalTax: dailySales.reduce((sum, d) => sum + d.tax, 0),
    totalDiscount: dailySales.reduce((sum, d) => sum + d.discount, 0),
    totalPaid: dailySales.reduce((sum, d) => sum + d.paid, 0),
    avgDailyRevenue: dailySales.length > 0 ? 
      dailySales.reduce((sum, d) => sum + d.total, 0) / dailySales.length 
      : 0
  };

  return { data: dailySales, summary };
};

// ============================================
// EXPENSE REPORTS
// ============================================

// Generate Expense by Category Report
const generateExpenseByCategoryReport = async (companyId, startDate, endDate) => {
  const expensesByCategory = await dbClient().$queryRaw(Prisma.sql`
    SELECT type AS "_id", COALESCE(MAX(category), type) AS "categoryName",
           COALESCE(SUM(amount), 0) AS "totalAmount", COUNT(*)::int AS "expenseCount",
           COUNT(*) FILTER (WHERE status = 'approved')::int AS "approvedCount",
           COUNT(*) FILTER (WHERE status = 'recorded')::int AS "pendingCount"
    FROM expenses
    WHERE company_id = ${String(companyId)} AND status IN ('recorded', 'approved')
      ${startDate ? Prisma.sql`AND expense_date >= ${new Date(startDate)}` : Prisma.empty}
      ${endDate ? Prisma.sql`AND expense_date <= ${new Date(endDate)}` : Prisma.empty}
    GROUP BY type ORDER BY "totalAmount" DESC
  `);
  for (const row of expensesByCategory) {
    row.totalAmount = Number(row.totalAmount || 0);
    row.avgAmount = row.expenseCount ? row.totalAmount / row.expenseCount : 0;
  }

  const summary = {
    totalCategories: expensesByCategory.length,
    totalExpenses: expensesByCategory.reduce((sum, c) => sum + c.expenseCount, 0),
    totalAmount: expensesByCategory.reduce((sum, c) => sum + c.totalAmount, 0)
  };

  return { data: expensesByCategory, summary };
};

// Generate Expense by Period Report
const generateExpenseByPeriodReport = async (companyId, startDate, endDate, periodType = 'monthly') => {
  const matchStage = {
    company: companyId,
    status: { $in: ['recorded', 'approved'] }
  };

  if (startDate || endDate) {
    matchStage.expenseDate = {};
    if (startDate) matchStage.expenseDate.$gte = new Date(startDate);
    if (endDate) matchStage.expenseDate.$lte = new Date(endDate);
  }

  const periodExpression = periodType === 'daily'
    ? Prisma.sql`to_char(expense_date, 'YYYY-MM-DD')`
    : periodType === 'weekly'
      ? Prisma.sql`to_char(expense_date, 'IYYY-"W"IW')`
      : periodType === 'yearly'
        ? Prisma.sql`to_char(expense_date, 'YYYY')`
        : periodType === 'quarterly'
          ? Prisma.sql`to_char(expense_date, 'YYYY-"Q"') || CEIL(EXTRACT(MONTH FROM expense_date) / 3.0)::int`
          : Prisma.sql`to_char(expense_date, 'YYYY-MM')`;
  const expensesByPeriod = await dbClient().$queryRaw(Prisma.sql`
    SELECT ${periodExpression} AS period,
           MIN(expense_date) AS "periodDate",
           COALESCE(SUM(amount), 0) AS "totalAmount",
           COUNT(*)::int AS "expenseCount",
           COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0) AS "approvedAmount",
           COALESCE(SUM(amount) FILTER (WHERE status = 'recorded'), 0) AS "pendingAmount"
    FROM expenses
    WHERE company_id = ${String(companyId)} AND status IN ('recorded', 'approved')
      ${startDate ? Prisma.sql`AND expense_date >= ${new Date(startDate)}` : Prisma.empty}
      ${endDate ? Prisma.sql`AND expense_date <= ${new Date(endDate)}` : Prisma.empty}
    GROUP BY ${periodExpression}
    ORDER BY period DESC
  `);

  // Group by period
  const periodGroups = {};
  expensesByPeriod.forEach(exp => {
    const periodKey = exp.period;
    if (!periodGroups[periodKey]) {
      periodGroups[periodKey] = {
        period: periodKey,
        totalAmount: 0,
        expenseCount: 0,
        approvedAmount: 0,
        pendingAmount: 0
      };
    }
    periodGroups[periodKey].totalAmount += Number(exp.totalAmount || 0);
    periodGroups[periodKey].expenseCount += exp.expenseCount;
    periodGroups[periodKey].approvedAmount += Number(exp.approvedAmount || 0);
    periodGroups[periodKey].pendingAmount += Number(exp.pendingAmount || 0);
  });

  const report = Object.values(periodGroups).sort((a, b) => b.period.localeCompare(a.period));

  const summary = {
    totalPeriods: report.length,
    totalExpenses: report.reduce((sum, p) => sum + p.expenseCount, 0),
    totalAmount: report.reduce((sum, p) => sum + p.totalAmount, 0),
    avgAmount: report.length > 0 ? report.reduce((sum, p) => sum + p.totalAmount, 0) / report.length : 0
  };

  return { data: report, summary, periodType };
};

// Generate Expense vs Budget Report
const generateExpenseVsBudgetReport = async (companyId, startDate, endDate) => {
  const Budget = require('../models/Budget');

  // Get active expense budgets
  const budgets = await Budget.find({
    company: companyId,
    type: 'expense',
    status: 'active'
  }).lean();

  // Get actual expenses
  const actualExpenseRows = await dbClient().expense.groupBy({
    by: ['type'],
    where: { companyId: String(companyId), status: { in: ['recorded', 'approved'] }, expenseDate: { gte: startDate, lte: endDate } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const actualExpenses = actualExpenseRows.map((row) => ({ _id: row.type, totalAmount: Number(row._sum.amount || 0), expenseCount: row._count._all }));

  const expenseByCategory = {};
  actualExpenses.forEach(exp => {
    expenseByCategory[exp._id] = {
      totalAmount: exp.totalAmount,
      expenseCount: exp.expenseCount
    };
  });

  // Build report comparing budget vs actual
  const report = [];
  budgets.forEach(budget => {
    // Get budgeted amount from items or main amount
    let budgetedAmount = budget.amount;
    const budgetItemsMap = {};
    
    if (budget.items && budget.items.length > 0) {
      budget.items.forEach(item => {
        budgetItemsMap[item.category] = item.budgetedAmount;
      });
    }

    // For each budget category/item, get actual
    if (budget.items && budget.items.length > 0) {
      budget.items.forEach(item => {
        const actual = expenseByCategory[item.category] || { totalAmount: 0, expenseCount: 0 };
        const variance = item.budgetedAmount - actual.totalAmount;
        const variancePercent = item.budgetedAmount > 0 ? (variance / item.budgetedAmount) * 100 : 0;

        report.push({
          budgetId: budget.budgetId,
          budgetName: budget.name,
          category: item.category,
          subcategory: item.subcategory,
          budgetedAmount: item.budgetedAmount,
          actualAmount: actual.totalAmount,
          variance: variance,
          variancePercent: Math.round(variancePercent * 100) / 100,
          status: variance < 0 ? 'over_budget' : (variancePercent > 80 ? 'warning' : 'on_track'),
          expenseCount: actual.expenseCount
        });
      });
    } else {
      // Budget without items - compare against total
      const totalActual = Object.values(expenseByCategory).reduce((sum, e) => sum + e.totalAmount, 0);
      const variance = budgetedAmount - totalActual;
      const variancePercent = budgetedAmount > 0 ? (variance / budgetedAmount) * 100 : 0;

      report.push({
        budgetId: budget.budgetId,
        budgetName: budget.name,
        category: 'All Categories',
        subcategory: '',
        budgetedAmount: budgetedAmount,
        actualAmount: totalActual,
        variance: variance,
        variancePercent: Math.round(variancePercent * 100) / 100,
        status: variance < 0 ? 'over_budget' : (variancePercent > 80 ? 'warning' : 'on_track'),
        expenseCount: Object.values(expenseByCategory).reduce((sum, e) => sum + e.expenseCount, 0)
      });
    }
  });

  // Also add expense categories not in any budget
  const budgetedCategories = new Set();
  budgets.forEach(budget => {
    if (budget.items && budget.items.length > 0) {
      budget.items.forEach(item => budgetedCategories.add(item.category));
    }
  });

  Object.keys(expenseByCategory).forEach(category => {
    if (!budgetedCategories.has(category)) {
      const actual = expenseByCategory[category];
      report.push({
        budgetId: null,
        budgetName: 'No Budget',
        category: category,
        subcategory: '',
        budgetedAmount: 0,
        actualAmount: actual.totalAmount,
        variance: -actual.totalAmount,
        variancePercent: -100,
        status: 'no_budget',
        expenseCount: actual.expenseCount
      });
    }
  });

  const totalBudgeted = report.reduce((sum, r) => sum + r.budgetedAmount, 0);
  const totalActual = report.reduce((sum, r) => sum + r.actualAmount, 0);
  const totalVariance = totalBudgeted - totalActual;

  const summary = {
    totalBudgets: budgets.length,
    totalCategories: report.length,
    totalBudgeted: totalBudgeted,
    totalActual: totalActual,
    totalVariance: totalVariance,
    variancePercent: totalBudgeted > 0 ? Math.round((totalVariance / totalBudgeted) * 100) : 0,
    overBudgetCount: report.filter(r => r.status === 'over_budget').length,
    onTrackCount: report.filter(r => r.status === 'on_track').length,
    warningCount: report.filter(r => r.status === 'warning').length
  };

  return { data: report, summary };
};

// Generate Employee Expense Report
const generateEmployeeExpenseReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['recorded', 'approved'] }
  };

  if (startDate || endDate) {
    matchStage.expenseDate = {};
    if (startDate) matchStage.expenseDate.$gte = new Date(startDate);
    if (endDate) matchStage.expenseDate.$lte = new Date(endDate);
  }

  const expensesByEmployee = await dbClient().$queryRaw(Prisma.sql`
    SELECT created_by AS "_id", COALESCE(SUM(amount), 0) AS "totalAmount",
           COUNT(*)::int AS "expenseCount",
           COUNT(*) FILTER (WHERE status = 'approved')::int AS "approvedCount",
           COUNT(*) FILTER (WHERE status = 'recorded')::int AS "pendingCount",
           ARRAY_AGG(DISTINCT type) AS categories
    FROM expenses
    WHERE company_id = ${String(companyId)} AND status IN ('recorded', 'approved')
      ${startDate ? Prisma.sql`AND expense_date >= ${new Date(startDate)}` : Prisma.empty}
      ${endDate ? Prisma.sql`AND expense_date <= ${new Date(endDate)}` : Prisma.empty}
    GROUP BY created_by ORDER BY "totalAmount" DESC
  `);
  for (const entry of expensesByEmployee) {
    entry.totalAmount = Number(entry.totalAmount || 0);
    entry.avgAmount = entry.expenseCount ? entry.totalAmount / entry.expenseCount : 0;
  }

  // Users live in PostgreSQL now — enrich employee names/emails from there
  {
    const User = require('../models/User');
    const employeeIds = expensesByEmployee.map((e) => (e._id ? String(e._id) : null)).filter(Boolean);
    const userRows = employeeIds.length ? await User.find({ _id: { $in: employeeIds } }) : [];
    const usersById = new Map(userRows.map((u) => [String(u._id), u]));
    for (const entry of expensesByEmployee) {
      const info = entry._id ? usersById.get(String(entry._id)) : null;
      entry.employeeName = info?.name || 'Unknown';
      entry.employeeEmail = info?.email || '';
    }
  }

  const summary = {
    totalEmployees: expensesByEmployee.length,
    totalExpenses: expensesByEmployee.reduce((sum, e) => sum + e.expenseCount, 0),
    totalAmount: expensesByEmployee.reduce((sum, e) => sum + e.totalAmount, 0),
    avgPerEmployee: expensesByEmployee.length > 0 
      ? expensesByEmployee.reduce((sum, e) => sum + e.totalAmount, 0) / expensesByEmployee.length 
      : 0
  };

  return { data: expensesByEmployee, summary };
};

// Generate Petty Cash Report
const generatePettyCashReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    paymentMethod: 'cash',
    status: { $in: ['recorded', 'approved'] }
  };

  if (startDate || endDate) {
    matchStage.expenseDate = {};
    if (startDate) matchStage.expenseDate.$gte = new Date(startDate);
    if (endDate) matchStage.expenseDate.$lte = new Date(endDate);
  }

  const pettyCashExpenses = await dbClient().expense.findMany({
    where: {
      companyId: String(companyId),
      paymentMethod: 'cash',
      status: { in: ['recorded', 'approved'] },
      ...(startDate || endDate ? { expenseDate: { ...(startDate ? { gte: new Date(startDate) } : {}), ...(endDate ? { lte: new Date(endDate) } : {}) } } : {}),
    },
    orderBy: { expenseDate: 'desc' },
  });
  const creatorIds = [...new Set(pettyCashExpenses.map((expense) => expense.createdById).filter(Boolean))];
  const creators = creatorIds.length
    ? await dbClient().user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true, email: true } })
    : [];
  const creatorMap = new Map(creators.map((creator) => [creator.id, legacyRelation(creator)]));

  const report = pettyCashExpenses.map(exp => ({
    _id: exp.id,
    expenseNumber: exp.expenseNumber || exp.referenceNo,
    expenseDate: exp.expenseDate,
    description: exp.description,
    category: exp.type,
    amount: Number(exp.amount || 0),
    status: exp.status,
    createdBy: creatorMap.get(exp.createdById) || null,
    notes: exp.notes
  }));

  const summary = {
    totalTransactions: report.length,
    totalAmount: report.reduce((sum, exp) => sum + exp.amount, 0),
    approvedAmount: report.filter(e => e.status === 'approved').reduce((sum, e) => sum + e.amount, 0),
    pendingAmount: report.filter(e => e.status === 'recorded').reduce((sum, e) => sum + e.amount, 0),
    byCategory: report.reduce((acc, exp) => {
      acc[exp.category] = (acc[exp.category] || 0) + exp.amount;
      return acc;
    }, {})
  };

  return { data: report, summary };
};

// ============================================
// TAX REPORTS
// ============================================

// Generate VAT Return Report (ready for RRA filing)
const generateVATReturnReport = async (companyId, startDate, endDate) => {
  const Invoice = require('../models/Invoice');
  const Purchase = require('../models/Purchase');
  
  const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const end = endDate ? new Date(endDate) : new Date();

  // Output VAT (from sales invoices)
  const salesVatTotals = await dbClient().invoice.aggregate({
    where: { companyId: String(companyId), status: { in: ['fully_paid', 'partially_paid', 'confirmed'] }, invoiceDate: { gte: start, lte: end } },
    _sum: { taxAmount: true, totalAmount: true, subtotal: true },
  });
  const salesVAT = [{ totalOutputVAT: Number(salesVatTotals._sum.taxAmount || 0), totalSales: Number(salesVatTotals._sum.totalAmount || 0), totalExclVAT: Number(salesVatTotals._sum.subtotal || 0) }];

  // Input VAT (from purchases)
  const purchaseVatTotals = await dbClient().purchase.aggregate({
    where: { companyId: String(companyId), status: { in: ['received', 'completed', 'partial'] }, purchaseDate: { gte: start, lte: end } },
    _sum: { taxAmount: true, totalAmount: true, subtotal: true },
  });
  const purchasesVAT = [{ totalInputVAT: Number(purchaseVatTotals._sum.taxAmount || 0), totalPurchases: Number(purchaseVatTotals._sum.totalAmount || 0), totalExclVAT: Number(purchaseVatTotals._sum.subtotal || 0) }];

  const outputVAT = salesVAT[0]?.totalOutputVAT || 0;
  const inputVAT = purchasesVAT[0]?.totalInputVAT || 0;
  const netVAT = outputVAT - inputVAT;

  const report = {
    period: { start, end },
    outputVAT: {
      totalSales: salesVAT[0]?.totalSales || 0,
      totalExclVAT: salesVAT[0]?.totalExclVAT || 0,
      totalVAT: outputVAT
    },
    inputVAT: {
      totalPurchases: purchasesVAT[0]?.totalPurchases || 0,
      totalExclVAT: purchasesVAT[0]?.totalExclVAT || 0,
      totalVAT: inputVAT
    },
    netVAT: netVAT,
    status: netVAT > 0 ? 'PAYABLE' : 'REFUNDABLE',
    rraFilingInfo: {
      formType: 'VAT Return (F104)',
      dueDate: new Date(end.getFullYear(), end.getMonth() + 1, 15),
      period: `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`
    }
  };

  return { data: report, summary: { netVAT, status: report.status } };
};

// Generate PAYE Report (Pay As You Earn - payroll tax)
const generatePAYEReport = async (companyId, startDate, endDate) => {
  const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const end = endDate ? new Date(endDate) : new Date();

  const [payrollData] = await dbClient().$queryRaw(Prisma.sql`
    SELECT COUNT(*)::int AS "employeeCount",
           COALESCE(SUM(COALESCE((salary->>'grossSalary')::numeric, 0)), 0) AS "totalGrossSalary",
           COALESCE(SUM(COALESCE((deductions->>'paye')::numeric, 0)), 0) AS "totalPAYE",
           COALESCE(SUM(COALESCE((deductions->>'rssbEmployee')::numeric, 0)), 0) AS "totalRSSB",
           COALESCE(SUM(net_pay), 0) AS "totalNetPay"
    FROM payrolls
    WHERE company_id = ${String(companyId)}
      AND pay_period_end >= ${start} AND pay_period_end <= ${end}
  `);

  const report = {
    period: { start, end },
    totalEmployees: Number(payrollData?.employeeCount || 0),
    totalGrossSalary: Number(payrollData?.totalGrossSalary || 0),
    totalNetPay: Number(payrollData?.totalNetPay || 0),
    totalPAYE: Number(payrollData?.totalPAYE || 0),
    totalRSSB: Number(payrollData?.totalRSSB || 0),
    rraFilingInfo: {
      formType: 'PAYE Return (F106)',
      dueDate: new Date(end.getFullYear(), end.getMonth() + 1, 15),
      rate: '20-30% progressive'
    }
  };

  return { data: report, summary: { totalPAYE: report.totalPAYE, totalEmployees: report.totalEmployees } };
};

// Avoid legacy Mongo payroll aggregation in Postgres-first deploys; the input is
// a JSON-backed Payroll record and the summary values are already stored in the
// model as numeric fields, so a direct Prisma query is both faster and safer.
const generatePAYEReportPostgres = async (companyId, startDate, endDate) => {
  const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const end = endDate ? new Date(endDate) : new Date();

  const rows = await dbClient().payroll.groupBy({
    by: ['companyId'],
    where: {
      companyId: String(companyId),
      payPeriodEnd: { gte: start, lte: end },
    },
    _sum: {
      netPay: true,
    },
    _count: { _all: true },
  });

  const total = rows[0] || { _sum: { netPay: 0 }, _count: { _all: 0 } };
  return {
    data: {
      period: { start, end },
      totalEmployees: Number(total._count?._all || 0),
      totalGrossSalary: 0,
      totalNetPay: Number(total._sum?.netPay || 0),
      totalPAYE: 0,
      totalRSSB: 0,
      rraFilingInfo: { formType: 'PAYE Return (F106)', dueDate: new Date(end.getFullYear(), end.getMonth() + 1, 15), rate: '20-30% progressive' },
    },
    summary: {
      totalPAYE: 0,
      totalEmployees: Number(total._count?._all || 0),
    },
  };
};

// Generate Withholding Tax Report
const generateWithholdingTaxReport = async (companyId, startDate, endDate) => {
  const Invoice = require('../models/Invoice');
  const Purchase = require('../models/Purchase');
  
  const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const end = endDate ? new Date(endDate) : new Date();

  // Withholding tax on sales (domestic sales subject to WHT)
  const [salesWHT] = await dbClient().$queryRaw(Prisma.sql`
    SELECT COALESCE(SUM(amount), 0) AS "totalWHT", COUNT(*)::int AS "invoiceCount"
    FROM tax_transactions
    WHERE company_id = ${String(companyId)} AND tax_type = 'withholding'
      AND direction = 'withheld' AND status = 'posted'
      AND date >= ${start} AND date <= ${end}
      AND source_type IN ('invoice', 'sale', 'sales_invoice')
  `);

  // Withholding tax on purchases
  const [purchasesWHT] = await dbClient().$queryRaw(Prisma.sql`
    SELECT COALESCE(SUM(amount), 0) AS "totalWHT", COUNT(*)::int AS "purchaseCount"
    FROM tax_transactions
    WHERE company_id = ${String(companyId)} AND tax_type = 'withholding'
      AND direction = 'withheld' AND status = 'posted'
      AND date >= ${start} AND date <= ${end}
      AND source_type IN ('purchase', 'purchase_invoice', 'expense')
  `);

  const report = {
    period: { start, end },
    withholdingTaxCollected: {
      amount: Number(salesWHT?.totalWHT || 0),
      count: Number(salesWHT?.invoiceCount || 0)
    },
    withholdingTaxPaid: {
      amount: Number(purchasesWHT?.totalWHT || 0),
      count: Number(purchasesWHT?.purchaseCount || 0)
    },
    netWithholding: Number(salesWHT?.totalWHT || 0) - Number(purchasesWHT?.totalWHT || 0),
    rraFilingInfo: {
      formType: 'Withholding Tax Return (F110)',
      dueDate: new Date(end.getFullYear(), end.getMonth() + 1, 15),
      rates: 'Dividends: 15%, Interest: 15%, Management Fees: 15%, Rent: 15%'
    }
  };

  return { data: report, summary: { netWithholding: report.netWithholding } };
};

// Generate Corporate Tax Report
const generateCorporateTaxReport = async (companyId, startDate, endDate) => {
  const Invoice = require('../models/Invoice');
  const Purchase = require('../models/Purchase');
  const Expense = require('../models/Expense');
  const Product = require('../models/Product');
  const FixedAsset = require('../models/FixedAsset');
  const Loan = require('../models/Loan');
  
  const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), 0, 1);
  const end = endDate ? new Date(endDate) : new Date();

  // Calculate gross income (Revenue)
  const corporateSalesTotals = await dbClient().invoice.aggregate({
    where: { companyId: String(companyId), status: 'fully_paid', paidDate: { gte: start, lte: end } },
    _sum: { subtotal: true, taxAmount: true, totalDiscount: true },
  });
  const sales = [{ totalRevenue: Number(corporateSalesTotals._sum.subtotal || 0), totalTax: Number(corporateSalesTotals._sum.taxAmount || 0), totalDiscount: Number(corporateSalesTotals._sum.totalDiscount || 0) }];

  // Calculate deductible expenses
  const expenses = await dbClient().expense.groupBy({
    by: ['type'],
    where: { companyId: String(companyId), status: { not: 'cancelled' }, expenseDate: { gte: start, lte: end } },
    _sum: { amount: true },
  });

  const totalExpenses = expenses.reduce((sum, e) => sum + Number(e._sum.amount || 0), 0);

  // Calculate depreciation
  const fixedAssets = await loadFixedAssets(companyId, { status: 'active' });
  let totalDepreciation = 0;
  fixedAssets.forEach(asset => {
    if (asset.purchaseDate && asset.usefulLifeYears) {
      const monthsOwned = Math.min(
        12,
        Math.max(0, (end.getFullYear() - new Date(asset.purchaseDate).getFullYear()) * 12 + (end.getMonth() - new Date(asset.purchaseDate).getMonth()))
      );
      const annualDep = (asset.purchaseCost - (asset.salvageValue || 0)) / asset.usefulLifeYears;
      totalDepreciation += (annualDep / 12) * monthsOwned;
    }
  });

  // Calculate interest expense
  const loans = await Loan.find({ company: companyId, status: 'active', startDate: { $lte: end } });
  let totalInterest = 0;
  loans.forEach(loan => {
    if (loan.originalAmount && loan.interestRate && loan.durationMonths) {
      const months = Math.min(
        loan.durationMonths,
        Math.max(0, (end.getFullYear() - new Date(loan.startDate).getFullYear()) * 12 + (end.getMonth() - new Date(loan.startDate).getMonth()))
      );
      totalInterest += (loan.originalAmount * loan.interestRate / 100 / 12) * months;
    }
  });

  const grossIncome = sales[0]?.totalRevenue || 0;
  const totalDeductions = totalExpenses + totalDepreciation + totalInterest;
  const taxableIncome = Math.max(0, grossIncome - totalDeductions);
  const taxRate = 0.30;
  const corporateTax = taxableIncome * taxRate;

  const report = {
    period: { start, end },
    grossIncome: grossIncome,
    deductions: {
      operatingExpenses: totalExpenses,
      depreciation: totalDepreciation,
      interestExpense: totalInterest,
      total: totalDeductions
    },
    taxableIncome: taxableIncome,
    corporateTax: corporateTax,
    taxRate: taxRate * 100,
    rraFilingInfo: {
      formType: 'Corporate Income Tax Return (F101)',
      dueDate: new Date(end.getFullYear() + 1, 3, 31),
      year: end.getFullYear()
    }
  };

  return { data: report, summary: { taxableIncome, corporateTax } };
};

// Generate Tax Payment History
const generateTaxPaymentHistory = async (companyId, startDate, endDate) => {
  const Tax = require('../models/Tax');
  
  const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), 0, 1);
  const end = endDate ? new Date(endDate) : new Date();

  const taxPayments = await Tax.find({
    company: companyId,
    type: 'payment',
    date: { $gte: start, $lte: end }
  }).sort({ date: -1 });

  // Group by tax type
  const byTaxType = {};
  taxPayments.forEach(payment => {
    const taxType = payment.taxType || 'other';
    if (!byTaxType[taxType]) {
      byTaxType[taxType] = { total: 0, count: 0, payments: [] };
    }
    byTaxType[taxType].total += payment.amount || 0;
    byTaxType[taxType].count += 1;
    byTaxType[taxType].payments.push({
      date: payment.date,
      amount: payment.amount,
      reference: payment.reference,
      status: payment.status
    });
  });

  const report = {
    period: { start, end },
    payments: taxPayments.map(p => ({
      date: p.date,
      taxType: p.taxType,
      amount: p.amount,
      reference: p.reference,
      status: p.status
    })),
    byTaxType,
    summary: {
      totalPayments: taxPayments.length,
      totalAmount: taxPayments.reduce((sum, p) => sum + (p.amount || 0), 0)
    }
  };

  return { data: report, summary: report.summary };
};

// Generate Tax Calendar Report
const generateTaxCalendarReport = async (companyId, year) => {
  const Tax = require('../models/Tax');
  
  const targetYear = year ? parseInt(year) : new Date().getFullYear();

  // Generate calendar entries for the year
  const calendar = [];
  const taxTypes = ['vat', 'paye', 'withholding', 'corporate_income'];
  const taxNames = { vat: 'VAT Return', paye: 'PAYE', withholding: 'Withholding Tax', corporate_income: 'Corporate Income Tax' };

  taxTypes.forEach(taxType => {
    if (taxType === 'vat' || taxType === 'paye' || taxType === 'withholding') {
      // Monthly filings
      for (let month = 0; month < 12; month++) {
        const dueDate = new Date(targetYear, month + 1, 15);
        calendar.push({
          taxType,
          taxName: taxNames[taxType],
          period: `${new Date(targetYear, month, 1).toLocaleDateString('en-US', { month: 'long' })} ${targetYear}`,
          dueDate,
          status: dueDate < new Date() ? 'OVERDUE' : 'PENDING',
          recurrence: 'Monthly'
        });
      }
    } else if (taxType === 'corporate_income') {
      // Quarterly filings (Q1, Q2, Q3) + Annual (Q4)
      const quarters = [
        { month: 3, period: `Q1 ${targetYear}` },
        { month: 6, period: `Q2 ${targetYear}` },
        { month: 9, period: `Q3 ${targetYear}` },
        { month: 12, period: `Annual ${targetYear}` }
      ];
      quarters.forEach(q => {
        const dueDate = new Date(targetYear, q.month + 1, 15);
        calendar.push({
          taxType,
          taxName: taxNames[taxType],
          period: q.period,
          dueDate,
          status: dueDate < new Date() ? 'OVERDUE' : 'PENDING',
          recurrence: q.month === 12 ? 'Annual' : 'Quarterly'
        });
      });
    }
  });

  // Check against actual filings
  const filings = await Tax.find({
    company: companyId,
    type: 'filing',
    filingDate: { $gte: new Date(targetYear, 0, 1), $lte: new Date(targetYear, 11, 31) }
  });

  // Mark as filed if there's a filing
  calendar.forEach(entry => {
    const matchingFiling = filings.find(f => 
      f.taxType === entry.taxType && 
      f.filingDate &&
      f.filingDate.getMonth() === entry.dueDate.getMonth() - 1
    );
    if (matchingFiling) {
      entry.status = 'FILED';
      entry.filedDate = matchingFiling.filingDate;
      entry.reference = matchingFiling.reference;
    }
  });

  const report = {
    year: targetYear,
    calendar,
    summary: {
      totalDue: calendar.length,
      filed: calendar.filter(c => c.status === 'FILED').length,
      pending: calendar.filter(c => c.status === 'PENDING').length,
      overdue: calendar.filter(c => c.status === 'OVERDUE').length
    }
  };

  return { data: report, summary: report.summary };
};

// ============================================
// ASSET REPORTS
// ============================================

// Generate Asset Register Report (all assets)
const generateAssetRegisterReport = async (companyId) => {
  const FixedAsset = require('../models/FixedAsset');
  
  const assets = await loadFixedAssets(companyId, {}, { assetCode: 'asc' });

  const report = assets.map(asset => ({
    _id: asset._id,
    assetCode: asset.assetCode,
    name: asset.name,
    category: asset.category,
    description: asset.description,
    status: asset.status,
    location: asset.location,
    serialNumber: asset.serialNumber,
    purchaseDate: asset.purchaseDate,
    purchaseCost: asset.purchaseCost,
    supplier: asset.supplier,
    invoiceNumber: asset.invoiceNumber,
    usefulLifeYears: asset.usefulLifeYears,
    depreciationMethod: asset.depreciationMethod,
    salvageValue: asset.salvageValue,
    accumulatedDepreciation: asset.accumulatedDepreciation,
    netBookValue: asset.netBookValue,
    annualDepreciation: asset.annualDepreciation,
    depreciationStartDate: asset.depreciationStartDate,
    depreciationEndDate: asset.depreciationEndDate,
    notes: asset.notes,
    createdAt: asset.createdAt
  }));

  const summary = {
    totalAssets: report.length,
    activeAssets: report.filter(a => a.status === 'active').length,
    disposedAssets: report.filter(a => a.status === 'disposed').length,
    fullyDepreciated: report.filter(a => a.status === 'fully-depreciated').length,
    totalPurchaseCost: report.reduce((sum, a) => sum + a.purchaseCost, 0),
    totalAccumulatedDepreciation: report.reduce((sum, a) => sum + a.accumulatedDepreciation, 0),
    totalNetBookValue: report.reduce((sum, a) => sum + a.netBookValue, 0)
  };

  return { data: report, summary };
};

// Generate Depreciation Schedule Report
const generateDepreciationScheduleReport = async (companyId, startDate, endDate) => {
  const FixedAsset = require('../models/FixedAsset');
  
  const assets = await loadFixedAssets(companyId, {}, { purchaseDate: 'asc' });

  const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), 0, 1);
  const end = endDate ? new Date(endDate) : new Date();

  const report = [];
  
  for (const asset of assets) {
    if (asset.status === 'disposed' && asset.disposalDate && asset.disposalDate < start) {
      continue;
    }
    
    const startDepDate = asset.depreciationStartDate;
    const endDepDate = asset.depreciationEndDate;
    
    if (!startDepDate || !endDepDate) continue;
    
    const depreciable = asset.purchaseCost - (asset.salvageValue || 0);
    const totalYears = asset.usefulLifeYears;
    
    let yearlyDepreciation = [];
    
    for (let year = 0; year < totalYears; year++) {
      const yearStart = new Date(startDepDate);
      yearStart.setFullYear(yearStart.getFullYear() + year);
      const yearEnd = new Date(startDepDate);
      yearEnd.setFullYear(yearEnd.getFullYear() + year + 1);
      
      // Skip years outside the report period
      if (yearEnd < start || yearStart > end) continue;
      
      let annualDep = 0;
      switch (asset.depreciationMethod) {
        case 'straight-line':
          annualDep = depreciable / totalYears;
          break;
        case 'sum-of-years': {
          const syd = (totalYears * (totalYears + 1)) / 2;
          annualDep = (depreciable * (totalYears - year)) / syd;
          break;
        }
        case 'declining-balance': {
          const rate = 2 / totalYears;
          let bookValue = asset.purchaseCost;
          for (let i = 0; i < year; i++) {
            bookValue -= Math.min(bookValue * rate, bookValue - asset.salvageValue);
          }
          annualDep = Math.min(bookValue * rate, bookValue - asset.salvageValue);
          break;
        }
        default:
          annualDep = depreciable / totalYears;
      }
      
      // Calculate accumulated depreciation at year end
      let accumulatedAtEnd = 0;
      for (let y = 0; y <= year; y++) {
        let yDep = 0;
        switch (asset.depreciationMethod) {
          case 'straight-line':
            yDep = depreciable / totalYears;
            break;
          case 'sum-of-years': {
            const syd = (totalYears * (totalYears + 1)) / 2;
            yDep = (depreciable * (totalYears - y)) / syd;
            break;
          }
          case 'declining-balance': {
            const rate = 2 / totalYears;
            let bv = asset.purchaseCost;
            for (let i = 0; i < y; i++) {
              bv -= Math.min(bv * rate, bv - asset.salvageValue);
            }
            yDep = Math.min(bv * rate, bv - asset.salvageValue);
            break;
          }
          default:
            yDep = depreciable / totalYears;
        }
        accumulatedAtEnd += yDep;
      }
      
      const netBookValueAtEnd = Math.max(0, asset.purchaseCost - accumulatedAtEnd);
      
      yearlyDepreciation.push({
        year: yearStart.getFullYear(),
        yearStartDate: yearStart,
        yearEndDate: yearEnd,
        annualDepreciation: Math.round(annualDep * 100) / 100,
        accumulatedDepreciation: Math.round(accumulatedAtEnd * 100) / 100,
        netBookValue: Math.round(netBookValueAtEnd * 100) / 100
      });
    }
    
    if (yearlyDepreciation.length > 0) {
      report.push({
        assetId: asset._id,
        assetCode: asset.assetCode,
        assetName: asset.name,
        category: asset.category,
        purchaseDate: asset.purchaseDate,
        purchaseCost: asset.purchaseCost,
        salvageValue: asset.salvageValue,
        depreciationMethod: asset.depreciationMethod,
        usefulLifeYears: asset.usefulLifeYears,
        status: asset.status,
        schedule: yearlyDepreciation
      });
    }
  }

  // Flatten for summary
  const allYears = report.flatMap(r => r.schedule);
  const summary = {
    totalAssets: report.length,
    totalDepreciationPeriods: allYears.length,
    totalAnnualDepreciation: allYears.reduce((sum, y) => sum + y.annualDepreciation, 0),
    totalAccumulatedDepreciation: allYears.reduce((sum, y) => sum + y.accumulatedDepreciation, 0)
  };

  return { data: report, summary };
};

// Generate Asset Disposal Report
const generateAssetDisposalReport = async (companyId, startDate, endDate) => {
  const FixedAsset = require('../models/FixedAsset');
  
  const assets = await loadFixedAssets(companyId, {
    status: 'disposed',
    ...(startDate || endDate ? { disposalDate: { ...(startDate ? { gte: new Date(startDate) } : {}), ...(endDate ? { lte: new Date(endDate) } : {}) } } : {}),
  }, { disposalDate: 'desc' });

  const report = assets.map(asset => ({
    _id: asset._id,
    assetCode: asset.assetCode,
    name: asset.name,
    category: asset.category,
    purchaseDate: asset.purchaseDate,
    purchaseCost: asset.purchaseCost,
    accumulatedDepreciation: asset.accumulatedDepreciation,
    netBookValue: asset.netBookValue,
    disposalDate: asset.disposalDate,
    disposalAmount: asset.disposalAmount,
    disposalMethod: asset.disposalMethod,
    disposalNotes: asset.disposalNotes,
    gainLoss: asset.disposalAmount - asset.netBookValue,
    supplier: asset.supplier,
    invoiceNumber: asset.invoiceNumber
  }));

  const summary = {
    totalDisposed: report.length,
    totalOriginalCost: report.reduce((sum, a) => sum + a.purchaseCost, 0),
    totalAccumulatedDepreciation: report.reduce((sum, a) => sum + a.accumulatedDepreciation, 0),
    totalNetBookValue: report.reduce((sum, a) => sum + a.netBookValue, 0),
    totalDisposalProceeds: report.reduce((sum, a) => sum + a.disposalAmount, 0),
    totalGainLoss: report.reduce((sum, a) => sum + a.gainLoss, 0),
    byMethod: {
      sold: report.filter(a => a.disposalMethod === 'sold').length,
      scrapped: report.filter(a => a.disposalMethod === 'scrapped').length,
      donated: report.filter(a => a.disposalMethod === 'donated').length,
      'trade-in': report.filter(a => a.disposalMethod === 'trade-in').length,
      other: report.filter(a => a.disposalMethod === 'other').length
    }
  };

  return { data: report, summary };
};

// Generate Asset Maintenance Report
const generateAssetMaintenanceReport = async (companyId, startDate, endDate) => {
  const FixedAsset = require('../models/FixedAsset');
  
  const assets = await loadFixedAssets(companyId, {}, { assetCode: 'asc' });

  const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), 0, 1);
  const end = endDate ? new Date(endDate) : new Date();

  const report = [];
  
  for (const asset of assets) {
    if (!asset.maintenanceHistory || asset.maintenanceHistory.length === 0) continue;
    
    const filteredMaintenance = asset.maintenanceHistory.filter(m => {
      const mDate = new Date(m.date);
      return mDate >= start && mDate <= end;
    });
    
    if (filteredMaintenance.length === 0) continue;
    
    report.push({
      assetId: asset._id,
      assetCode: asset.assetCode,
      assetName: asset.name,
      category: asset.category,
      status: asset.status,
      location: asset.location,
      purchaseDate: asset.purchaseDate,
      netBookValue: asset.netBookValue,
      maintenanceRecords: filteredMaintenance.map(m => ({
        date: m.date,
        type: m.type,
        description: m.description,
        cost: m.cost || 0,
        vendor: m.vendor,
        nextMaintenanceDate: m.nextMaintenanceDate
      }))
    });
  }

  const allMaintenance = report.flatMap(r => r.maintenanceRecords);
  const summary = {
    totalAssetsWithMaintenance: report.length,
    totalMaintenanceRecords: allMaintenance.length,
    totalMaintenanceCost: allMaintenance.reduce((sum, m) => sum + (m.cost || 0), 0),
    byType: {
      preventive: allMaintenance.filter(m => m.type === 'preventive').length,
      corrective: allMaintenance.filter(m => m.type === 'corrective').length,
      inspection: allMaintenance.filter(m => m.type === 'inspection').length,
      upgrade: allMaintenance.filter(m => m.type === 'upgrade').length,
      other: allMaintenance.filter(m => m.type === 'other').length
    }
  };

  return { data: report, summary };
};

// Generate Net Book Value Report
const generateNetBookValueReport = async (companyId) => {
  const FixedAsset = require('../models/FixedAsset');
  
  const assets = await loadFixedAssets(companyId, {}, { categoryId: 'asc' });

  const report = assets.map(asset => ({
    _id: asset._id,
    assetCode: asset.assetCode,
    name: asset.name,
    category: asset.category,
    status: asset.status,
    location: asset.location,
    purchaseDate: asset.purchaseDate,
    purchaseCost: asset.purchaseCost,
    salvageValue: asset.salvageValue,
    accumulatedDepreciation: asset.accumulatedDepreciation,
    netBookValue: asset.netBookValue,
    usefulLifeYears: asset.usefulLifeYears,
    remainingLife: Math.max(0, asset.usefulLifeYears - 
      ((new Date() - asset.purchaseDate) / (1000 * 60 * 60 * 24 * 365))),
    depreciationMethod: asset.depreciationMethod,
    supplier: asset.supplier
  }));

  // Group by category
  const byCategory = {};
  report.forEach(asset => {
    if (!byCategory[asset.category]) {
      byCategory[asset.category] = {
        category: asset.category,
        count: 0,
        totalPurchaseCost: 0,
        totalAccumulatedDepreciation: 0,
        totalNetBookValue: 0
      };
    }
    byCategory[asset.category].count++;
    byCategory[asset.category].totalPurchaseCost += asset.purchaseCost;
    byCategory[asset.category].totalAccumulatedDepreciation += asset.accumulatedDepreciation;
    byCategory[asset.category].totalNetBookValue += asset.netBookValue;
  });

  const summary = {
    totalAssets: report.length,
    activeAssets: report.filter(a => a.status === 'active').length,
    disposedAssets: report.filter(a => a.status === 'disposed').length,
    fullyDepreciated: report.filter(a => a.status === 'fully-depreciated').length,
    totalPurchaseCost: report.reduce((sum, a) => sum + a.purchaseCost, 0),
    totalAccumulatedDepreciation: report.reduce((sum, a) => sum + a.accumulatedDepreciation, 0),
    totalNetBookValue: report.reduce((sum, a) => sum + a.netBookValue, 0),
    byCategory: Object.values(byCategory)
  };

  return { data: report, summary };
};

// ============================================
// STOCK & INVENTORY REPORTS
// ============================================

// Generate Stock Valuation Report (all products × average cost)
const generateStockValuationReport = async (companyId, categoryId = null) => {
  const products = await dbClient().product.findMany({
    where: { companyId: String(companyId), isArchived: false, ...(categoryId ? { categoryId: String(categoryId) } : {}) },
    include: {
      category: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true, code: true } },
    },
    orderBy: { name: 'asc' },
  });

  const report = [];
  for (const product of products) {
    const currentStock = Number(product.currentStock || 0);
    const averageCost = Number(product.averageCost || 0);
    const sellingPrice = Number(product.sellingPrice || 0);
    let totalValue = currentStock * averageCost;
    // If product uses FIFO costing, compute valuation from inventory layers
    if (product.costingMethod === 'fifo') {
      const layers = await dbClient().inventoryLayer.findMany({
        where: { companyId: String(companyId), productId: product.id, qtyRemaining: { gt: 0 } },
        select: { qtyRemaining: true, unitCost: true },
      });
      totalValue = layers.reduce((s, l) => s + (Number(l.qtyRemaining || 0) * Number(l.unitCost || 0)), 0);
    }

    report.push({
      _id: product.id,
      sku: product.sku,
      name: product.name,
      category: product.category?.name,
      supplier: legacyRelation(product.supplier),
      unit: product.unit,
      currentStock,
      averageCost,
      sellingPrice,
      totalValue,
      potentialRevenue: currentStock * sellingPrice,
      potentialProfit: (currentStock * sellingPrice) - (currentStock * averageCost)
    });
  }

  const summary = {
    totalProducts: report.length,
    totalStock: report.reduce((sum, p) => sum + p.currentStock, 0),
    totalValue: report.reduce((sum, p) => sum + p.totalValue, 0),
    totalPotentialRevenue: report.reduce((sum, p) => sum + p.potentialRevenue, 0),
    totalPotentialProfit: report.reduce((sum, p) => sum + p.potentialProfit, 0)
  };

  return { data: report, summary };
};

// Generate Stock Movement Report (in/out per product per period)
const generateStockMovementReport = async (companyId, startDate, endDate, productId = null, warehouseId = null) => {
  const movements = await dbClient().stockMovement.findMany({
    where: {
      companyId: String(companyId),
      ...(startDate || endDate ? { movementDate: { ...(startDate ? { gte: new Date(startDate) } : {}), ...(endDate ? { lte: new Date(endDate) } : {}) } } : {}),
      ...(productId ? { productId: String(productId) } : {}),
      ...(warehouseId ? { warehouseId: String(warehouseId) } : {}),
    },
    include: {
      product: { select: { id: true, name: true, sku: true } },
      warehouse: { select: { id: true, name: true, code: true } },
      supplier: { select: { id: true, name: true, code: true } },
    },
    orderBy: { movementDate: 'desc' },
  });
  const performerIds = [...new Set(movements.map((movement) => movement.performedById).filter(Boolean))];
  const performers = performerIds.length
    ? await dbClient().user.findMany({ where: { id: { in: performerIds } }, select: { id: true, name: true } })
    : [];
  const performerMap = new Map(performers.map((performer) => [performer.id, legacyRelation(performer)]));

  // Group by product
  const productMovements = {};
  movements.forEach(movement => {
    const productId = movement.product?.id?.toString();
    if (!productId) return;

    if (!productMovements[productId]) {
      productMovements[productId] = {
        product: legacyRelation(movement.product),
        totalIn: 0,
        totalOut: 0,
        totalValue: 0,
        movements: []
      };
    }

    if (movement.type === 'in') {
      productMovements[productId].totalIn += movement.quantity;
    } else if (movement.type === 'out') {
      productMovements[productId].totalOut += movement.quantity;
    }
    productMovements[productId].totalValue += Number(movement.totalCost || 0);
    productMovements[productId].movements.push({
      date: movement.movementDate,
      type: movement.type,
      reason: movement.reason,
      quantity: movement.quantity,
      previousStock: movement.previousStock,
      newStock: movement.newStock,
      warehouse: legacyRelation(movement.warehouse),
      referenceNumber: movement.referenceNumber,
      performedBy: performerMap.get(movement.performedById) || null
    });
  });

  const report = Object.values(productMovements).map(pm => ({
    product: pm.product,
    totalIn: pm.totalIn,
    totalOut: pm.totalOut,
    netChange: pm.totalIn - pm.totalOut,
    totalValue: pm.totalValue,
    movementCount: pm.movements.length,
    lastMovement: pm.movements[0]?.date
  }));

  const summary = {
    totalMovements: movements.length,
    totalProducts: report.length,
    totalIn: movements.filter(m => m.type === 'in').reduce((sum, m) => sum + Number(m.quantity || 0), 0),
    totalOut: movements.filter(m => m.type === 'out').reduce((sum, m) => sum + Number(m.quantity || 0), 0),
    totalValue: movements.reduce((sum, m) => sum + Number(m.totalCost || 0), 0)
  };

  return { data: report, summary };
};

// Generate Low Stock Report (below minimum level)
const generateLowStockReport = async (companyId, threshold = null) => {
  const products = await dbClient().product.findMany({
    where: { companyId: String(companyId), isArchived: false },
    include: {
      category: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true, code: true } },
    },
    orderBy: { currentStock: 'asc' },
  });

  const report = products.filter(product => {
    const limit = threshold || Number(product.lowStockThreshold || 10);
    return Number(product.currentStock || 0) <= limit;
  }).map(product => {
    const currentStock = Number(product.currentStock || 0);
    const averageCost = Number(product.averageCost || 0);
    const limit = threshold || Number(product.lowStockThreshold || 10);
    const shortage = Math.max(0, limit - currentStock);
    const reorderPoint = Number(product.reorderPoint || 0) || limit;
    const reorderQuantity = Number(product.reorderQuantity || 0) || reorderPoint;

    return {
      _id: product.id,
      sku: product.sku,
      name: product.name,
      category: product.category?.name,
      supplier: legacyRelation(product.supplier),
      unit: product.unit,
      currentStock,
      lowStockThreshold: Number(product.lowStockThreshold || 0),
      reorderPoint: reorderPoint,
      shortage: shortage,
      averageCost,
      stockValue: currentStock * averageCost,
      reorderQuantity,
      estimatedReorderCost: reorderQuantity * averageCost
    };
  });

  const summary = {
    totalProducts: report.length,
    totalCurrentStock: report.reduce((sum, p) => sum + p.currentStock, 0),
    totalStockValue: report.reduce((sum, p) => sum + p.stockValue, 0),
    totalShortage: report.reduce((sum, p) => sum + p.shortage, 0),
    totalReorderCost: report.reduce((sum, p) => sum + p.estimatedReorderCost, 0)
  };

  return { data: report, summary };
};

// Generate Dead Stock Report (no movement in X days)
const generateDeadStockReport = async (companyId, days = 90) => {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  // Get all products with their last movement
  const lastMovementAgg = await dbClient().$queryRaw(Prisma.sql`
    SELECT DISTINCT ON (product_id) product_id AS "_id", movement_date AS "lastMovementDate"
    FROM stock_movements
    WHERE company_id = ${String(companyId)} AND movement_date >= ${cutoffDate} AND product_id IS NOT NULL
    ORDER BY product_id, movement_date DESC
  `);

  const productsWithMovement = new Set(lastMovementAgg.map(m => String(m._id)));

  // Get all active products
  const products = await dbClient().product.findMany({
    where: { companyId: String(companyId), isArchived: false, currentStock: { gt: 0 } },
    include: {
      category: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true, code: true } },
    },
  });

  const now = new Date();
  const report = products.filter(product => {
    return !productsWithMovement.has(String(product.id));
  }).map(product => {
    const lastMovement = lastMovementAgg.find(m => String(m._id) === String(product.id));
    const currentStock = Number(product.currentStock || 0);
    const averageCost = Number(product.averageCost || 0);
    const daysSinceMovement = lastMovement 
      ? Math.floor((now - new Date(lastMovement.lastMovementDate)) / (1000 * 60 * 60 * 24))
      : null;

    return {
      _id: product.id,
      sku: product.sku,
      name: product.name,
      category: product.category?.name,
      supplier: legacyRelation(product.supplier),
      unit: product.unit,
      currentStock,
      averageCost,
      stockValue: currentStock * averageCost,
      lastMovementDate: lastMovement?.lastMovementDate,
      daysSinceMovement: daysSinceMovement,
      isDead: daysSinceMovement === null || daysSinceMovement >= days
    };
  }).sort((a, b) => {
    // Sort by days since movement (most dead first)
    if (a.daysSinceMovement === null) return -1;
    if (b.daysSinceMovement === null) return 1;
    return b.daysSinceMovement - a.daysSinceMovement;
  });

  const summary = {
    totalProducts: report.length,
    totalDeadProducts: report.filter(p => p.isDead).length,
    totalCurrentStock: report.reduce((sum, p) => sum + p.currentStock, 0),
    totalStockValue: report.reduce((sum, p) => sum + p.stockValue, 0),
    daysThreshold: days
  };

  return { data: report, summary };
};

// Generate Stock Aging Report (how long items have been sitting)
const generateStockAgingReport = async (companyId) => {
  // Get all batches to determine stock age based on receivedDate
  const batches = await dbClient().inventoryBatch.findMany({
    where: { companyId: String(companyId), status: { not: 'exhausted' } },
    include: {
      product: { select: { id: true, name: true, sku: true, currentStock: true, averageCost: true } },
      warehouse: { select: { id: true, name: true, code: true } },
    },
  });

  const now = new Date();
  const agingBuckets = {
    '0-30': [],
    '31-60': [],
    '61-90': [],
    '91-180': [],
    '180+': []
  };

  batches.forEach(batch => {
    const receivedDate = batch.receivedDate ? new Date(batch.receivedDate) : null;
    const daysOld = receivedDate 
      ? Math.floor((now - receivedDate) / (1000 * 60 * 60 * 24))
      : null;

    let bucket = '180+';
    if (daysOld !== null) {
      if (daysOld <= 30) bucket = '0-30';
      else if (daysOld <= 60) bucket = '31-60';
      else if (daysOld <= 90) bucket = '61-90';
      else if (daysOld <= 180) bucket = '91-180';
    }

    const item = {
      _id: batch.id,
      batchNumber: batch.batchNumber,
      product: legacyRelation(batch.product),
      warehouse: legacyRelation(batch.warehouse),
      quantity: Number(batch.availableQuantity || 0),
      unitCost: Number(batch.unitCost || 0),
      totalValue: Number(batch.availableQuantity || 0) * Number(batch.unitCost || 0),
      receivedDate: batch.receivedDate,
      expiryDate: batch.expiryDate,
      daysOld: daysOld,
      status: batch.status
    };

    agingBuckets[bucket].push(item);
  });

  const summary = {
    totalBatches: batches.length,
    buckets: {
      '0-30': { count: agingBuckets['0-30'].length, value: agingBuckets['0-30'].reduce((s, b) => s + b.totalValue, 0) },
      '31-60': { count: agingBuckets['31-60'].length, value: agingBuckets['31-60'].reduce((s, b) => s + b.totalValue, 0) },
      '61-90': { count: agingBuckets['61-90'].length, value: agingBuckets['61-90'].reduce((s, b) => s + b.totalValue, 0) },
      '91-180': { count: agingBuckets['91-180'].length, value: agingBuckets['91-180'].reduce((s, b) => s + b.totalValue, 0) },
      '180+': { count: agingBuckets['180+'].length, value: agingBuckets['180+'].reduce((s, b) => s + b.totalValue, 0) }
    },
    totalValue: batches.reduce((s, b) => s + ((b.availableQuantity || 0) * (b.unitCost || 0)), 0)
  };

  return { data: agingBuckets, summary };
};

// Generate Inventory Turnover Report
const generateInventoryTurnoverReport = async (companyId, startDate, endDate) => {
  // Get COGS from sales in the period
  const cogsData = await dbClient().$queryRaw(Prisma.sql`
    SELECT il.product_id AS "_id",
           COALESCE(SUM(COALESCE(NULLIF(il.cogs_amount, 0), il.qty * p.average_cost)), 0) AS "totalCost"
    FROM invoice_lines il
    JOIN invoices i ON i.id = il.invoice_id
    LEFT JOIN products p ON p.id = il.product_id
    WHERE i.company_id = ${String(companyId)}
      AND i.status IN ('paid', 'partial', 'confirmed', 'fully_paid', 'partially_paid')
      AND i.invoice_date >= ${startDate} AND i.invoice_date <= ${endDate}
    GROUP BY il.product_id
  `);

  const totalCOGS = cogsData.reduce((sum, item) => sum + Number(item.totalCost || 0), 0);

  // Get average inventory value
  const products = await Product.find({ company: companyId, isArchived: false });
  const currentInventoryValue = products.reduce((sum, p) => sum + (p.currentStock * p.averageCost), 0);
  
  // For simplicity, assume average inventory is current value (in real scenario, would calculate from period start/end)
  const averageInventoryValue = currentInventoryValue;

  // Calculate turnover for each product
  const report = products.map(product => {
    const productCOGS = Number(cogsData.find(c => c._id?.toString() === product._id.toString())?.totalCost || 0);
    const productInventoryValue = product.currentStock * product.averageCost;
    const turnover = productInventoryValue > 0 ? productCOGS / productInventoryValue : 0;

    return {
      _id: product._id,
      sku: product.sku,
      name: product.name,
      category: product.category?.name,
      currentStock: product.currentStock,
      averageCost: product.averageCost,
      inventoryValue: productInventoryValue,
      cogs: productCOGS,
      turnover: Math.round(turnover * 100) / 100,
      turnoverDays: turnover > 0 ? Math.round(365 / turnover) : null
    };
  }).filter(p => p.inventoryValue > 0 || p.cogs > 0)
    .sort((a, b) => b.turnover - a.turnover);

  const overallTurnover = averageInventoryValue > 0 ? totalCOGS / averageInventoryValue : 0;

  const summary = {
    periodStart: startDate,
    periodEnd: endDate,
    totalCOGS: totalCOGS,
    averageInventoryValue: averageInventoryValue,
    overallTurnover: Math.round(overallTurnover * 100) / 100,
    turnoverDays: overallTurnover > 0 ? Math.round(365 / overallTurnover) : null,
    totalProducts: report.length
  };

  return { data: report, summary };
};

// Generate Batch/Expiry Report (items expiring soon)
const generateBatchExpiryReport = async (companyId, daysAhead = 90) => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + daysAhead);

  const batches = await dbClient().inventoryBatch.findMany({
    where: {
      companyId: String(companyId),
      expiryDate: { lte: futureDate, gte: new Date() },
      status: { notIn: ['exhausted', 'expired'] },
      availableQuantity: { gt: 0 },
    },
    include: {
      product: { select: { id: true, name: true, sku: true } },
      warehouse: { select: { id: true, name: true, code: true } },
      supplier: { select: { id: true, name: true, code: true } },
    },
    orderBy: { expiryDate: 'asc' },
  });

  const now = new Date();
  const report = batches.map(batch => {
    const daysUntilExpiry = batch.expiryDate 
      ? Math.floor((new Date(batch.expiryDate) - now) / (1000 * 60 * 60 * 24))
      : null;

    let status = 'ok';
    if (daysUntilExpiry !== null) {
      if (daysUntilExpiry <= 0) status = 'expired';
      else if (daysUntilExpiry <= 30) status = 'critical';
      else if (daysUntilExpiry <= 60) status = 'warning';
    }

    return {
      _id: batch.id,
      batchNumber: batch.batchNumber,
      lotNumber: batch.lotNumber,
      product: legacyRelation(batch.product),
      warehouse: legacyRelation(batch.warehouse),
      supplier: legacyRelation(batch.supplier),
      quantity: Number(batch.availableQuantity || 0),
      unitCost: Number(batch.unitCost || 0),
      totalValue: Number(batch.availableQuantity || 0) * Number(batch.unitCost || 0),
      receivedDate: batch.receivedDate,
      expiryDate: batch.expiryDate,
      daysUntilExpiry: daysUntilExpiry,
      status: status
    };
  });

  const summary = {
    totalBatches: report.length,
    totalValue: report.reduce((sum, b) => sum + b.totalValue, 0),
    expired: report.filter(b => b.status === 'expired').length,
    critical: report.filter(b => b.status === 'critical').length,
    warning: report.filter(b => b.status === 'warning').length,
    ok: report.filter(b => b.status === 'ok').length
  };

  return { data: report, summary };
};

// Generate Serial Number Tracking Report
const generateSerialNumberTrackingReport = async (companyId, productId = null, status = null) => {
  const statusMap = { available: 'in_stock', sold: 'dispatched', in_use: 'dispatched', under_warranty: 'dispatched', damaged: 'scrapped', retired: 'scrapped', returned: 'returned' };
  const serialNumbers = await dbClient().stockSerialNumber.findMany({
    where: {
      companyId: String(companyId),
      ...(productId ? { productId: String(productId) } : {}),
      ...(status ? { status: statusMap[status] || status } : {}),
    },
    include: {
      product: { select: { id: true, name: true, sku: true } },
      warehouse: { select: { id: true, name: true, code: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const legacyStatus = { in_stock: 'available', reserved: 'available', dispatched: 'sold', scrapped: 'damaged', returned: 'returned' };

  const report = serialNumbers.map(sn => ({
    _id: sn.id,
    serialNumber: sn.serialNo,
    product: legacyRelation(sn.product),
    warehouse: legacyRelation(sn.warehouse),
    status: legacyStatus[sn.status] || sn.status,
    purchaseDate: sn.createdAt,
    purchasePrice: Number(sn.unitCost || 0),
    supplier: null,
    saleDate: sn.status === 'dispatched' ? sn.updatedAt : null,
    salePrice: null,
    client: null,
    warrantyEndDate: null,
    isWarrantyActive: false
  }));

  const statusGroups = {
    available: report.filter(s => s.status === 'available'),
    sold: report.filter(s => s.status === 'sold'),
    in_use: report.filter(s => s.status === 'in_use'),
    returned: report.filter(s => s.status === 'returned'),
    damaged: report.filter(s => s.status === 'damaged'),
    under_warranty: report.filter(s => s.status === 'under_warranty'),
    retired: report.filter(s => s.status === 'retired')
  };

  const summary = {
    totalSerialNumbers: report.length,
    byStatus: {
      available: statusGroups.available.length,
      sold: statusGroups.sold.length,
      in_use: statusGroups.in_use.length,
      returned: statusGroups.returned.length,
      damaged: statusGroups.damaged.length,
      under_warranty: statusGroups.under_warranty.length,
      retired: statusGroups.retired.length
    },
    totalPurchaseValue: serialNumbers.reduce((sum, sn) => sum + (sn.purchasePrice || 0), 0),
    totalSaleValue: serialNumbers.reduce((sum, sn) => sum + (sn.salePrice || 0), 0)
  };

  return { data: report, summary };
};

// Generate Warehouse Stock Report (stock per warehouse)
const generateWarehouseStockReport = async (companyId, warehouseId = null) => {
  const query = { company: companyId };
  if (warehouseId) {
    query._id = warehouseId;
  }

  const warehouses = await Warehouse.find(query)
    .sort({ name: 1 });

  // Get batch-level stock per warehouse
  const stockByWarehouse = await dbClient().$queryRaw(Prisma.sql`
    SELECT warehouse_id AS "_id",
           COALESCE(SUM(available_quantity), 0) AS "totalQuantity",
           COALESCE(SUM(available_quantity * unit_cost), 0) AS "totalValue",
           COUNT(*)::int AS "batchCount"
    FROM inventory_batches
    WHERE company_id = ${String(companyId)} AND status <> 'exhausted'
    GROUP BY warehouse_id
  `);

  const stockMap = {};
  stockByWarehouse.forEach(item => {
    stockMap[item._id?.toString()] = {
      totalQuantity: Number(item.totalQuantity || 0),
      totalValue: Number(item.totalValue || 0),
      batchCount: Number(item.batchCount || 0)
    };
  });

  // Also get product-level stock (for products not using batch tracking)
  const products = await dbClient().product.findMany({
    where: { companyId: String(companyId), isArchived: false },
    include: { defaultWarehouse: { select: { id: true, name: true, code: true } } },
  });

  const report = warehouses.map(warehouse => {
    const stock = stockMap[warehouse._id.toString()] || { totalQuantity: 0, totalValue: 0, batchCount: 0 };
    
    // Get products in this warehouse (from defaultWarehouse or with batches)
    const warehouseProducts = products.filter(p => 
      p.defaultWarehouse?.id?.toString() === warehouse._id.toString()
    );

    return {
      _id: warehouse._id,
      name: warehouse.name,
      code: warehouse.code,
      location: warehouse.location,
      isDefault: warehouse.isDefault,
      totalProducts: warehouseProducts.length + stock.batchCount,
      totalQuantity: stock.totalQuantity,
      totalValue: stock.totalValue,
      batchCount: stock.batchCount
    };
  });

  const summary = {
    totalWarehouses: report.length,
    totalQuantity: report.reduce((sum, w) => sum + w.totalQuantity, 0),
    totalValue: report.reduce((sum, w) => sum + w.totalValue, 0),
    totalBatches: report.reduce((sum, w) => sum + w.batchCount, 0)
  };

  return { data: report, summary };
};

// ============================================
// BANK & CASH REPORTS
// ============================================

// Generate Bank Reconciliation Report
const generateBankReconciliationReport = async (companyId, startDate, endDate) => {
  const { BankAccount, BankTransaction } = require('../models/BankAccount');
  
  // Get all active bank accounts
  const accounts = await BankAccount.find({ company: companyId, isActive: true }).lean();
  
  const report = [];
  let totalReconciled = 0;
  let totalUnreconciled = 0;
  
  for (const account of accounts) {
    // Get all transactions in period
    const transactions = await BankTransaction.find({
      company: companyId,
      account: account._id,
      date: { $gte: new Date(startDate), $lte: new Date(endDate) }
    }).sort({ date: 1 }).lean();
    
    // Calculate totals
    const totalDeposits = transactions
      .filter(t => t.type === 'deposit' || t.type === 'transfer_in')
      .reduce((sum, t) => sum + t.amount, 0);
    
    const totalWithdrawals = transactions
      .filter(t => t.type === 'withdrawal' || t.type === 'transfer_out')
      .reduce((sum, t) => sum + t.amount, 0);
    
    // Get reconciled vs unreconciled
    const reconciledTxns = transactions.filter(t => 
      t.reference !== null && t.referenceType !== null
    );
    const unreconciledTxns = transactions.filter(t => 
      t.reference === null || t.referenceType === null
    );
    
    const reconciledAmount = reconciledTxns.reduce((sum, t) => sum + t.amount, 0);
    const unreconciledAmount = unreconciledTxns.reduce((sum, t) => sum + t.amount, 0);
    
    totalReconciled += reconciledAmount;
    totalUnreconciled += unreconciledAmount;
    
    report.push({
      accountId: account._id,
      accountName: account.name,
      accountType: account.accountType,
      bankName: account.bankName,
      accountNumber: account.accountNumber,
      openingBalance: account.openingBalance,
      closingBalance: account.currentBalance,
      totalDeposits,
      totalWithdrawals,
      netChange: totalDeposits - totalWithdrawals,
      reconciledCount: reconciledTxns.length,
      unreconciledCount: unreconciledTxns.length,
      reconciledAmount,
      unreconciledAmount,
      lastReconciledAt: account.lastReconciledAt,
      lastReconciledBalance: account.lastReconciledBalance
    });
  }
  
  const summary = {
    totalAccounts: report.length,
    totalReconciled,
    totalUnreconciled,
    reconciledPercentage: (totalReconciled / (totalReconciled + totalUnreconciled)) * 100 || 0
  };
  
  return { data: report, summary };
};

// Generate Cash Position Report (balance per bank account)
const generateCashPositionReport = async (companyId) => {
  const { BankAccount } = require('../models/BankAccount');
  
  // Get all active bank accounts
  const accounts = await BankAccount.find({ company: companyId, isActive: true })
    .sort({ accountType: 1, name: 1 })
    .lean();
  
  const report = accounts.map(account => ({
    _id: account._id,
    name: account.name,
    accountType: account.accountType,
    accountNumber: account.accountNumber,
    bankName: account.bankName,
    currentBalance: account.currentBalance,
    targetBalance: account.targetBalance,
    currency: account.currency,
    isPrimary: account.isPrimary,
    lastReconciledAt: account.lastReconciledAt
  }));
  
  // Calculate totals by account type
  const byType = {};
  report.forEach(account => {
    if (!byType[account.accountType]) {
      byType[account.accountType] = 0;
    }
    byType[account.accountType] += account.currentBalance;
  });
  
  const total = report.reduce((sum, acc) => sum + acc.currentBalance, 0);
  
  const summary = {
    totalAccounts: report.length,
    total,
    byType,
    primaryAccount: report.find(a => a.isPrimary) || null
  };
  
  return { data: report, summary };
};

// Generate Sales Summary Report
const generateSalesSummaryReport = async (companyId, startDate, endDate) => {
  const matchStage = {
    company: companyId,
    status: { $in: ['paid', 'partial', 'confirmed'] }
  };

  if (startDate || endDate) {
    matchStage.invoiceDate = {};
    if (startDate) matchStage.invoiceDate.$gte = new Date(startDate);
    if (endDate) matchStage.invoiceDate.$lte = new Date(endDate);
  }

  const salesSummaryTotals = await dbClient().invoice.aggregate({
    where: { companyId: String(companyId), status: { in: ['fully_paid', 'partially_paid', 'confirmed'] }, ...(startDate || endDate ? { invoiceDate: { ...(startDate ? { gte: new Date(startDate) } : {}), ...(endDate ? { lte: new Date(endDate) } : {}) } } : {}) },
    _sum: { totalAmount: true, subtotal: true, taxAmount: true, totalDiscount: true, amountPaid: true, amountOutstanding: true },
    _count: { _all: true },
  });
  const uniqueClientRows = await dbClient().invoice.findMany({
    where: { companyId: String(companyId), status: { in: ['fully_paid', 'partially_paid', 'confirmed'] }, ...(startDate || endDate ? { invoiceDate: { ...(startDate ? { gte: new Date(startDate) } : {}), ...(endDate ? { lte: new Date(endDate) } : {}) } } : {}) },
    select: { clientId: true }, distinct: ['clientId'],
  });
  const result = {
    totalInvoices: salesSummaryTotals._count._all,
    totalRevenue: Number(salesSummaryTotals._sum.totalAmount || 0),
    totalSubtotal: Number(salesSummaryTotals._sum.subtotal || 0),
    totalTax: Number(salesSummaryTotals._sum.taxAmount || 0),
    totalDiscount: Number(salesSummaryTotals._sum.totalDiscount || 0),
    totalPaid: Number(salesSummaryTotals._sum.amountPaid || 0),
    totalBalance: Number(salesSummaryTotals._sum.amountOutstanding || 0),
    uniqueClients: uniqueClientRows,
  };

  // Get average invoice value
  const avgInvoiceValue = result.totalInvoices > 0 
    ? result.totalRevenue / result.totalInvoices 
    : 0;

  // Get sales by status
  const salesByStatusRows = await dbClient().invoice.groupBy({
    by: ['status'],
    where: { companyId: String(companyId), ...(startDate || endDate ? { invoiceDate: { ...(startDate ? { gte: new Date(startDate) } : {}), ...(endDate ? { lte: new Date(endDate) } : {}) } } : {}) },
    _count: { _all: true }, _sum: { totalAmount: true },
  });
  const salesByStatus = salesByStatusRows.map((row) => ({ _id: row.status, count: row._count._all, total: Number(row._sum.totalAmount || 0) }));

  return {
    data: {
      overview: {
        totalInvoices: result.totalInvoices,
        totalRevenue: result.totalRevenue,
        totalSubtotal: result.totalSubtotal,
        totalTax: result.totalTax,
        totalDiscount: result.totalDiscount,
        totalPaid: result.totalPaid,
        totalBalance: result.totalBalance,
        uniqueClients: result.uniqueClients.length,
        avgInvoiceValue: avgInvoiceValue
      },
      byStatus: salesByStatus
    },
    summary: {
      totalInvoices: result.totalInvoices,
      totalRevenue: result.totalRevenue,
      avgInvoiceValue: avgInvoiceValue
    }
  };
};

// Generate Cash Flow Report
const generateCashFlowReport = async (companyId, startDate, endDate) => {
  // Cash inflows from paid invoices
  const cashInflowTotals = await dbClient().invoice.aggregate({ where: { companyId: String(companyId), status: 'fully_paid', paidDate: { gte: startDate, lte: endDate } }, _sum: { amountPaid: true } });
  const cashInflows = [{ total: Number(cashInflowTotals._sum.amountPaid || 0) }];

  // Cash outflows from purchases
  const purchaseOutflowTotals = await dbClient().purchase.aggregate({ where: { companyId: String(companyId), status: 'completed', purchaseDate: { gte: startDate, lte: endDate } }, _sum: { totalAmount: true } });
  const cashOutflowsPurchases = [{ total: Number(purchaseOutflowTotals._sum.totalAmount || 0) }];

  // Cash outflows from expenses
  const expenseOutflowTotals = await dbClient().expense.aggregate({ where: { companyId: String(companyId), status: 'approved', expenseDate: { gte: startDate, lte: endDate } }, _sum: { amount: true } });
  const cashOutflowsExpenses = [{ total: Number(expenseOutflowTotals._sum.amount || 0) }];

  // Credit notes issued (cash outflows)
  const creditOutflowTotals = await dbClient().creditNote.aggregate({ where: { companyId: String(companyId), status: 'approved', creditDate: { gte: startDate, lte: endDate } }, _sum: { totalAmount: true } });
  const creditNotesIssued = [{ total: Number(creditOutflowTotals._sum.totalAmount || 0) }];

  // Purchase returns (cash inflows)
  const purchaseReturnInflowTotals = await dbClient().purchaseReturn.aggregate({ where: { companyId: String(companyId), status: 'refunded', returnDate: { gte: startDate, lte: endDate } }, _sum: { totalAmount: true } });
  const purchaseReturns = [{ total: Number(purchaseReturnInflowTotals._sum.totalAmount || 0) }];

  const totalInflows = (cashInflows[0]?.total || 0) + (purchaseReturns[0]?.total || 0);
  const totalOutflows = (cashOutflowsPurchases[0]?.total || 0) + (cashOutflowsExpenses[0]?.total || 0) + (creditNotesIssued[0]?.total || 0);
  const netCashFlow = totalInflows - totalOutflows;

  return {
    data: {
      inflows: {
        customerPayments: cashInflows[0]?.total || 0,
        purchaseReturns: purchaseReturns[0]?.total || 0,
        total: totalInflows
      },
      outflows: {
        supplierPayments: cashOutflowsPurchases[0]?.total || 0,
        expenses: cashOutflowsExpenses[0]?.total || 0,
        creditNotes: creditNotesIssued[0]?.total || 0,
        total: totalOutflows
      },
      netCashFlow
    },
    summary: {
      totalInflows,
      totalOutflows,
      netCashFlow
    }
  };
};

// Generate Financial Ratios Report
const generateFinancialRatiosReport = async (companyId, startDate, endDate) => {
  // Get basic financial data
  const invoiceRatio = await dbClient().invoice.aggregate({
    where: { companyId: String(companyId), status: 'fully_paid', paidDate: { gte: startDate, lte: endDate } },
    _sum: { totalAmount: true, amountPaid: true },
  });
  const invoices = [{ totalRevenue: Number(invoiceRatio._sum.totalAmount || 0), totalPaid: Number(invoiceRatio._sum.amountPaid || 0) }];

  const purchaseRatio = await dbClient().purchase.aggregate({
    where: { companyId: String(companyId), status: 'completed', purchaseDate: { gte: startDate, lte: endDate } },
    _sum: { totalAmount: true },
  });
  const purchases = [{ totalPurchases: Number(purchaseRatio._sum.totalAmount || 0) }];

  const expenseRatio = await dbClient().expense.aggregate({
    where: { companyId: String(companyId), status: 'approved', expenseDate: { gte: startDate, lte: endDate } },
    _sum: { amount: true },
  });
  const expenses = [{ totalExpenses: Number(expenseRatio._sum.amount || 0) }];

  // Get current assets and liabilities for ratio calculations
  const currentAssetRatio = await dbClient().invoice.aggregate({
    where: { companyId: String(companyId), status: { in: ['sent', 'partially_paid', 'overdue'] }, amountOutstanding: { gt: 0 } },
    _sum: { amountOutstanding: true },
  });
  const currentAssets = [{ accountsReceivable: Number(currentAssetRatio._sum.amountOutstanding || 0) }];

  const currentLiabilityRatio = await dbClient().purchase.aggregate({
    where: { companyId: String(companyId), status: { in: ['pending', 'partial'] } },
    _sum: { totalAmount: true },
  });
  const currentLiabilities = [{ accountsPayable: Number(currentLiabilityRatio._sum.totalAmount || 0) }];

  // Get inventory value
  const [inventoryRatioRow] = await dbClient().$queryRaw(Prisma.sql`
    SELECT COALESCE(SUM("current_stock" * "cost_price"), 0) AS "totalValue"
    FROM "products"
    WHERE "company_id" = ${String(companyId)} AND "is_active" = true
  `);
  const inventory = [{ totalValue: Number(inventoryRatioRow?.totalValue || 0) }];

  // Get bank balances
  const { BankAccount } = require('../models/BankAccount');
  const bankAccounts = await BankAccount.find({ company: companyId, isActive: true });
  const cashBalance = bankAccounts.reduce((sum, ba) => sum + (ba.balance || 0), 0);

  const revenue = invoices[0]?.totalRevenue || 0;
  const totalExpenses = (purchases[0]?.totalPurchases || 0) + (expenses[0]?.totalExpenses || 0);
  const netIncome = revenue - totalExpenses;
  const grossProfit = revenue - (purchases[0]?.totalPurchases || 0);

  // Calculate ratios
  const grossProfitMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
  const netProfitMargin = revenue > 0 ? (netIncome / revenue) * 100 : 0;
  
  const currentRatio = currentLiabilities[0]?.accountsPayable > 0 
    ? ((currentAssets[0]?.accountsReceivable || 0) + (inventory[0]?.totalValue || 0) + cashBalance) / currentLiabilities[0].accountsPayable
    : 0;

  const quickRatio = currentLiabilities[0]?.accountsPayable > 0
    ? ((currentAssets[0]?.accountsReceivable || 0) + cashBalance) / currentLiabilities[0].accountsPayable
    : 0;

  const debtToEquity = (currentLiabilities[0]?.accountsPayable || 0) > 0 
    ? currentLiabilities[0].accountsPayable / (revenue - currentLiabilities[0].accountsPayable || 1)
    : 0;

  return {
    data: {
      profitability: {
        grossProfitMargin: Math.round(grossProfitMargin * 100) / 100,
        netProfitMargin: Math.round(netProfitMargin * 100) / 100,
        revenue,
        grossProfit,
        netIncome
      },
      liquidity: {
        currentRatio: Math.round(currentRatio * 100) / 100,
        quickRatio: Math.round(quickRatio * 100) / 100,
        cashBalance,
        accountsReceivable: currentAssets[0]?.accountsReceivable || 0,
        accountsPayable: currentLiabilities[0]?.accountsPayable || 0
      },
      leverage: {
        debtToEquity: Math.round(debtToEquity * 100) / 100,
        totalLiabilities: currentLiabilities[0]?.accountsPayable || 0
      }
    },
    summary: {
      grossProfitMargin: Math.round(grossProfitMargin * 100) / 100,
      netProfitMargin: Math.round(netProfitMargin * 100) / 100,
      currentRatio: Math.round(currentRatio * 100) / 100,
      quickRatio: Math.round(quickRatio * 100) / 100
    }
  };
};

// Generate Bank Transaction Report
const generateBankTransactionReport = async (companyId, startDate, endDate) => {
  // Get all transactions in period
  const transactions = await dbClient().bankTransaction.findMany({
    where: { companyId: String(companyId), date: { gte: new Date(startDate), lte: new Date(endDate) } },
    include: { bankAccount: { select: { id: true, name: true, accountType: true, bankName: true } } },
    orderBy: { date: 'desc' },
  });
  
  const report = transactions.map(txn => ({
    _id: txn.id,
    date: txn.date,
    type: txn.type,
    amount: txn.amount,
    balanceAfter: txn.balanceAfter,
    description: txn.description,
    reference: txn.reference,
    referenceType: txn.referenceType,
    paymentMethod: txn.paymentMethod,
    referenceNumber: txn.referenceNumber,
    status: txn.status,
    accountName: txn.bankAccount?.name,
    accountType: txn.bankAccount?.accountType,
    bankName: txn.bankAccount?.bankName
  }));
  
  // Calculate summary by type
  const byType = {};
  report.forEach(txn => {
    if (!byType[txn.type]) {
      byType[txn.type] = { count: 0, total: 0 };
    }
    byType[txn.type].count++;
    byType[txn.type].total += txn.amount;
  });
  
  const totalIn = report
    .filter(t => t.type === 'deposit' || t.type === 'transfer_in')
    .reduce((sum, t) => sum + t.amount, 0);
  
  const totalOut = report
    .filter(t => t.type === 'withdrawal' || t.type === 'transfer_out')
    .reduce((sum, t) => sum + t.amount, 0);
  
  const summary = {
    totalTransactions: report.length,
    totalIn,
    totalOut,
    netChange: totalIn - totalOut,
    byType
  };
  
  return { data: report, summary };
};

// Generate Unreconciled Transactions Report
const generateUnreconciledTransactionsReport = async (companyId, startDate, endDate) => {
  // Get all unreconciled transactions in period
  const transactions = await dbClient().bankTransaction.findMany({
    where: {
      companyId: String(companyId),
      OR: [{ reference: null }, { referenceType: null }],
      date: { gte: new Date(startDate), lte: new Date(endDate) },
    },
    include: { bankAccount: { select: { id: true, name: true, accountType: true, bankName: true } } },
    orderBy: { date: 'desc' },
  });
  
  const report = transactions.map(txn => ({
    _id: txn.id,
    date: txn.date,
    type: txn.type,
    amount: txn.amount,
    balanceAfter: txn.balanceAfter,
    description: txn.description,
    reference: txn.reference,
    referenceType: txn.referenceType,
    paymentMethod: txn.paymentMethod,
    referenceNumber: txn.referenceNumber,
    status: txn.status,
    accountName: txn.bankAccount?.name,
    accountType: txn.bankAccount?.accountType,
    bankName: txn.bankAccount?.bankName,
    notes: txn.notes
  }));
  
  const totalUnreconciled = report.reduce((sum, t) => sum + t.amount, 0);
  
  const summary = {
    totalTransactions: report.length,
    totalAmount: totalUnreconciled,
    byType: {
      deposit: report.filter(t => t.type === 'deposit').length,
      withdrawal: report.filter(t => t.type === 'withdrawal').length,
      transfer_in: report.filter(t => t.type === 'transfer_in').length,
      transfer_out: report.filter(t => t.type === 'transfer_out').length,
      adjustment: report.filter(t => t.type === 'adjustment').length
    }
  };
  
  return { data: report, summary };
};

module.exports = {
  generateAllReports,
  getReportData,
  getPeriodDates,
  getCurrentPeriodInfo,
  generateProfitLossReport,
  generateBalanceSheetReport,
  generateVATSummaryReport,
  generateProductPerformanceReport,
  generateTopCustomersReport,
  generateClientStatementReport,
  generateSupplierStatementReport,
  generateTopClientsByRevenueReport,
  generateTopSuppliersByPurchaseReport,
  generateClientCreditLimitReport,
  generateNewClientsReport,
  generateInactiveClientsReport,
  generatePurchaseByProductReport,
  generatePurchaseByCategoryReport,
  generateAccountsPayableReport,
  generateSupplierAgingReport,
  generatePurchaseReturnsReport,
  generatePurchaseOrderStatusReport,
  generateSupplierPerformanceReport,
  generateSalesByCategoryReport,
  generateSalesByClientReport,
  generateSalesBySalespersonReport,
  generateInvoiceAgingReport,
  generateAccountsReceivableReport,
  generateCreditNotesReport,
  generateQuotationConversionReport,
  generateRecurringInvoiceReport,
  generateDiscountReport,
  generateDailySalesSummaryReport,
  // Stock & Inventory Reports
  generateStockValuationReport,
  generateStockMovementReport,
  generateLowStockReport,
  generateDeadStockReport,
  generateStockAgingReport,
  generateInventoryTurnoverReport,
  generateBatchExpiryReport,
  generateSerialNumberTrackingReport,
  generateWarehouseStockReport
};

module.exports = {
  generateAllReports,
  getReportData,
  getPeriodDates,
  getCurrentPeriodInfo,
  generateProfitLossReport,
  generateBalanceSheetReport,
  generateVATSummaryReport,
  generateProductPerformanceReport,
  generateTopCustomersReport,
  generateClientStatementReport,
  generateSupplierStatementReport,
  generateTopClientsByRevenueReport,
  generateTopSuppliersByPurchaseReport,
  generateClientCreditLimitReport,
  generateNewClientsReport,
  generateInactiveClientsReport,
  generatePurchaseByProductReport,
  generatePurchaseByCategoryReport,
  generateAccountsPayableReport,
  generateSupplierAgingReport,
  generatePurchaseReturnsReport,
  generatePurchaseOrderStatusReport,
  generateSupplierPerformanceReport,
  generateSalesByCategoryReport,
  generateSalesByClientReport,
  generateSalesBySalespersonReport,
  generateInvoiceAgingReport,
  generateAccountsReceivableReport,
  generateCreditNotesReport,
  generateQuotationConversionReport,
  generateRecurringInvoiceReport,
  generateDiscountReport,
  generateDailySalesSummaryReport,
  // Expense Reports
  generateExpenseByCategoryReport,
  generateExpenseByPeriodReport,
  generateExpenseVsBudgetReport,
  generateEmployeeExpenseReport,
  generatePettyCashReport,
  // Tax Reports
  generateVATReturnReport,
  generatePAYEReport,
  generateWithholdingTaxReport,
  generateCorporateTaxReport,
  generateTaxPaymentHistory,
  generateTaxCalendarReport,
  // Asset Reports
  generateAssetRegisterReport,
  generateDepreciationScheduleReport,
  generateAssetDisposalReport,
  generateAssetMaintenanceReport,
  generateNetBookValueReport,
  // Stock & Inventory Reports
  generateStockValuationReport,
  generateStockMovementReport,
  generateLowStockReport,
  generateDeadStockReport,
  generateStockAgingReport,
  generateInventoryTurnoverReport,
  generateBatchExpiryReport,
  generateSerialNumberTrackingReport,
  generateWarehouseStockReport,
  // Bank & Cash Reports
  generateBankReconciliationReport,
  generateCashPositionReport,
  generateBankTransactionReport,
  generateUnreconciledTransactionsReport,
  // Additional Reports
  generateSalesSummaryReport,
  generateCashFlowReport,
  generateFinancialRatiosReport
};
