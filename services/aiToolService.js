/**
 * AI Tool Service — Data fetchers for the AI assistant (Stacy)
 */

const Company = require('../models/Company');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Invoice = require('../models/Invoice');
const Purchase = require('../models/Purchase');
const PurchaseOrder = require('../models/PurchaseOrder');
const Client = require('../models/Client');
const Expense = require('../models/Expense');
const Supplier = require('../models/Supplier');
const StockMovement = require('../models/StockMovement');
const StockTransfer = require('../models/StockTransfer');
const StockAudit = require('../models/StockAudit');
const Warehouse = require('../models/Warehouse');
const ChartOfAccount = require('../models/ChartOfAccount');
const JournalEntry = require('../models/JournalEntry');
const BankAccount = require('../models/BankAccount');
const FixedAsset = require('../models/FixedAsset');
const Loan = require('../models/Loan');
const Liability = require('../models/Liability');
const CreditNote = require('../models/CreditNote');
const Quotation = require('../models/Quotation');
const GoodsReceivedNote = require('../models/GoodsReceivedNote');
const DeliveryNote = require('../models/DeliveryNote');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { stringify } = require('csv-stringify/sync');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const ARReceipt = require('../models/ARReceipt');
const APPayment = require('../models/APPayment');
const Budget = require('../models/Budget');
const Department = require('../models/Department');
const AuditLog = require('../models/AuditLog');
const AccountingPeriod = require('../models/AccountingPeriod');
const Notification = require('../models/Notification');
const SalesOrder = require('../models/SalesOrder');
const { dbClient } = require('../lib/prisma');
const journalAgg = require('./journalAggregationService');

const AI_MAX_LIST_ROWS = Math.min(500, Math.max(20, Number(process.env.AI_MAX_LIST_ROWS || 100)));
const AI_MAX_SUMMARY_ROWS = Math.max(AI_MAX_LIST_ROWS, Number(process.env.AI_MAX_SUMMARY_ROWS || 5000));

function safeAiLimit(value, fallback = 20) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return Math.min(fallback, AI_MAX_LIST_ROWS);
  return Math.min(parsed, AI_MAX_LIST_ROWS);
}

const MODULE_CATALOG = [
  { group: 'Command', modules: ['Dashboards', 'Inventory dashboard', 'Sales dashboard', 'Purchase dashboard', 'Finance dashboard'], tools: ['get_dashboard_metrics'] },
  { group: 'Inventory Core', modules: ['Products', 'Categories', 'Warehouses', 'Stock levels', 'Stock movements', 'Stock transfers', 'Stock audits', 'Batches', 'Serial numbers'], tools: ['get_products', 'get_categories', 'get_warehouses', 'get_stock_summary', 'get_stock_movements', 'get_stock_transfers'] },
  { group: 'Supply Chain', modules: ['Suppliers', 'Purchase orders', 'Goods received notes', 'Imported items', 'Purchases', 'Purchase returns'], tools: ['get_suppliers', 'get_purchase_orders', 'get_goods_received_notes', 'get_purchases'] },
  { group: 'Revenue Flow', modules: ['POS', 'Clients', 'Quotations', 'Sales orders', 'Pick packs', 'Invoices', 'Delivery notes', 'Credit notes', 'Recurring invoices', 'Accounts receivable', 'Accounts payable'], tools: ['get_clients', 'get_quotations', 'get_sales_orders', 'get_invoices', 'get_delivery_notes', 'get_credit_notes', 'get_ar_receipts', 'get_ap_payments', 'get_receivables_aging', 'get_sales_summary'] },
  { group: 'Finance Control', modules: ['Bank accounts', 'Chart of accounts', 'Journal entries', 'Petty cash', 'Fixed assets', 'Liabilities', 'Expenses', 'Budgets', 'Projects', 'Budget settings', 'Employees', 'Payroll', 'Payroll runs', 'Accounting periods'], tools: ['get_bank_accounts', 'get_chart_of_accounts', 'get_journal_entries', 'get_fixed_assets', 'get_loans', 'get_expenses', 'get_budgets', 'get_profit_loss_summary', 'get_balance_sheet', 'get_cash_flow_summary'] },
  { group: 'Intelligence', modules: ['Reports hub', 'Profit and loss', 'Balance sheet', 'Cash flow', 'Financial ratios', 'Debt maturity schedule'], tools: ['get_profit_loss_summary', 'get_balance_sheet', 'get_cash_flow_summary', 'calculate_financial_ratios', 'forecast_business', 'generate_chart_data'] },
  { group: 'Control Room', modules: ['User management', 'Roles', 'Security', 'Departments', 'Company settings', 'Notifications', 'Notification settings', 'Backup and restore', 'Bulk data', 'Audit trail', 'Testimonials'], tools: ['get_company_users', 'get_departments', 'get_notifications', 'get_audit_logs', 'get_company_info'] },
];

const MODULE_RECORD_TOOLS = {
  products: getProducts,
  categories: getCategories,
  warehouses: getWarehouses,
  stock_movements: getStockMovements,
  stock_transfers: getStockTransfers,
  suppliers: getSuppliers,
  purchase_orders: getPurchaseOrders,
  purchases: getPurchases,
  goods_received_notes: getGoodsReceivedNotes,
  clients: getClients,
  invoices: getInvoices,
  quotations: getQuotations,
  sales_orders: getSalesOrders,
  delivery_notes: getDeliveryNotes,
  credit_notes: getCreditNotes,
  ar_receipts: getARReceipts,
  ap_payments: getAPPayments,
  expenses: getExpenses,
  bank_accounts: getBankAccounts,
  chart_of_accounts: getChartOfAccounts,
  journal_entries: getJournalEntries,
  fixed_assets: getFixedAssets,
  liabilities: getLoans,
  budgets: getBudgets,
  departments: getDepartments,
  users: getCompanyUsers,
  notifications: getNotifications,
  audit_logs: getAuditLogs,
};

function isValidDate(d) {
  return d instanceof Date && !isNaN(d.getTime());
}

function parseDateInput(input) {
  if (!input || typeof input !== 'string') return null;
  const normalized = input.trim().toLowerCase();

  // Already ISO or standard format
  const direct = new Date(input);
  if (isValidDate(direct)) return direct;

  // Relative terms the AI might use
  const now = new Date();
  if (normalized === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (normalized === 'yesterday') { const d = new Date(now); d.setDate(d.getDate() - 1); return d; }
  if (normalized === 'this week') { const d = new Date(now); d.setDate(d.getDate() - d.getDay()); return d; }
  if (normalized === 'this month') return new Date(now.getFullYear(), now.getMonth(), 1);
  if (normalized === 'this year') return new Date(now.getFullYear(), 0, 1);
  if (normalized === 'last week') { const d = new Date(now); d.setDate(d.getDate() - d.getDay() - 7); return d; }
  if (normalized === 'last month') { const d = new Date(now); d.setMonth(d.getMonth() - 1); d.setDate(1); return d; }
  if (normalized === 'last year') return new Date(now.getFullYear() - 1, 0, 1);

  return null;
}

function dateFilter(start, end) {
  const q = {};
  const s = parseDateInput(start);
  const e = parseDateInput(end);
  if (s) q.$gte = s;
  if (e) q.$lte = e;
  return Object.keys(q).length ? q : undefined;
}

function addDatePredicates(clauses, params, column, start, end) {
  const range = dateFilter(start, end);
  if (range?.$gte) {
    params.push(range.$gte);
    clauses.push(`${column} >= $${params.length}`);
  }
  if (range?.$lte) {
    params.push(range.$lte);
    clauses.push(`${column} <= $${params.length}`);
  }
}

async function getCompanyInfo(companyId) {
  const company = await Company.findById(companyId).lean();
  if (!company) return { error: 'Company not found' };
  return {
    name: company.name, tin: company.tin, email: company.email,
    currency: company.settings?.currency || 'FRW',
    plan: company.subscription?.plan || 'free',
    equity: {
      shareCapital: company.equity?.shareCapital || 0,
      retainedEarnings: company.equity?.retainedEarnings || 0,
      accumulatedProfit: company.equity?.accumulatedProfit || 0,
    },
  };
}

async function getProducts(companyId, opts = {}) {
  const { limit = 50, search = '', lowStock = false, outOfStock = false } = opts;
  const q = { company: companyId };
  if (search) q.name = { $regex: search, $options: 'i' };
  if (lowStock) q.$expr = { $lte: ['$currentStock', '$lowStockThreshold'] };
  if (outOfStock) q.currentStock = 0;
  const boundedLimit = safeAiLimit(limit, 50);
  const products = await Product.find(q).lean().limit(boundedLimit);
  const totalValue = products.reduce((s, p) => s + ((p.currentStock || 0) * (p.averageCost || 0)), 0);
  return {
    count: products.length, totalValue,
    products: products.map(p => ({
      id: p._id.toString(), name: p.name, sku: p.sku,
      category: p.category?.name || p.category || 'Uncategorized',
      currentStock: p.currentStock || 0, unit: p.unit || 'units',
      averageCost: p.averageCost || 0, sellingPrice: p.sellingPrice || 0,
      taxCode: p.taxCode || 'A', isLowStock: (p.currentStock || 0) <= (p.lowStockThreshold || 0),
    })),
  };
}

async function getInvoices(companyId, opts = {}) {
  const { status = '', limit = 20, startDate, endDate } = opts;
  const q = { company: companyId };
  if (status) q.status = status;
  const df = dateFilter(startDate, endDate);
  if (df) q.invoiceDate = df;
  const boundedLimit = safeAiLimit(limit);
  const invoices = await Invoice.find(q).sort({ invoiceDate: -1 }).limit(boundedLimit).populate('client', 'name').lean();
  const stats = await dbClient().invoice.groupBy({
    by: ['status'],
    where: { companyId: String(companyId), ...(df ? { invoiceDate: df } : {}) },
    _count: { _all: true },
    _sum: { totalAmount: true },
  });
  return {
    count: invoices.length,
    stats: stats.reduce((acc, entry) => {
      acc[entry.status] = {
        count: Number(entry._count?._all || 0),
        total: Number(entry._sum?.totalAmount || 0),
      };
      return acc;
    }, {}),
    invoices: invoices.map(i => ({
      id: i._id.toString(), invoiceNumber: i.invoiceNumber,
      customerName: i.client?.name || i.customerName || 'Unknown',
      total: i.total || 0, status: i.status,
      invoiceDate: i.invoiceDate ? new Date(i.invoiceDate).toISOString().slice(0, 10) : null,
      outstanding: (i.total || 0) - (i.amountPaid || 0),
    })),
  };
}

async function getPurchases(companyId, opts = {}) {
  const { status = '', limit = 20, startDate, endDate } = opts;
  const q = { company: companyId };
  if (status) q.status = status;
  const df = dateFilter(startDate, endDate);
  if (df) q.createdAt = df;
  const purchases = await Purchase.find(q).sort({ createdAt: -1 }).limit(safeAiLimit(limit)).lean();
  return {
    count: purchases.length,
    purchases: purchases.map(p => ({
      id: p._id.toString(), purchaseNumber: p.purchaseNumber,
      supplier: p.supplier?.name || 'Unknown', total: p.total || 0,
      status: p.status, date: p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : null,
    })),
  };
}

async function getClients(companyId, opts = {}) {
  const { limit = 50, search = '' } = opts;
  const q = { company: companyId };
  if (search) q.name = { $regex: search, $options: 'i' };
  const boundedLimit = safeAiLimit(limit, 50);
  const clients = await Client.find(q).limit(boundedLimit).lean();
  const outstanding = await dbClient().invoice.aggregate({
    where: { companyId: String(companyId), status: { in: ['confirmed', 'partial'] } },
    _sum: { amountOutstanding: true },
  });
  return {
    count: clients.length, totalOutstanding: Number(outstanding._sum?.amountOutstanding || 0),
    clients: clients.map(c => ({
      id: c._id.toString(), name: c.name, type: c.type || 'Individual',
      phone: c.phone, email: c.email, isActive: c.isActive !== false,
    })),
  };
}

async function getExpenses(companyId, opts = {}) {
  const { type = '', limit = 20, startDate, endDate } = opts;
  const q = { company: companyId };
  if (type) q.type = type;
  const df = dateFilter(startDate, endDate);
  if (df) q.expenseDate = df;
  const boundedLimit = safeAiLimit(limit);
  const expenses = await Expense.find(q).sort({ expenseDate: -1 }).limit(boundedLimit).lean();
  const byType = await dbClient().expense.groupBy({
    by: ['type'],
    where: { companyId: String(companyId), ...(df ? { expenseDate: df } : {}) },
    _sum: { amount: true },
    orderBy: { _sum: { amount: 'desc' } },
  });
  return {
    count: expenses.length,
    byType: byType.map((entry) => ({ type: entry.type || 'Other', total: Number(entry._sum?.amount || 0) })),
    expenses: expenses.map(e => ({
      id: e._id.toString(), type: e.type, amount: e.amount || 0,
      status: e.status, date: e.expenseDate ? new Date(e.expenseDate).toISOString().slice(0, 10) : null,
    })),
  };
}

async function getStockSummary(companyId) {
  const [row] = await dbClient().$queryRaw`
    SELECT
      COUNT(*)::int AS "totalProducts",
      COALESCE(SUM(current_stock * average_cost), 0)::double precision AS "totalStockValue",
      COUNT(*) FILTER (WHERE current_stock = 0)::int AS "outOfStockCount",
      COUNT(*) FILTER (WHERE current_stock > 0 AND current_stock <= low_stock_threshold)::int AS "lowStockCount"
    FROM products
    WHERE company_id = ${String(companyId)} AND is_archived = false
  `;
  return {
    totalProducts: Number(row?.totalProducts || 0),
    totalStockValue: Number(row?.totalStockValue || 0),
    outOfStockCount: Number(row?.outOfStockCount || 0),
    lowStockCount: Number(row?.lowStockCount || 0),
  };
}

async function getDeadStockCandidates(companyId, opts = {}) {
  const parsedDays = Number(opts.days);
  const days = Number.isInteger(parsedDays) ? Math.min(365, Math.max(1, parsedDays)) : 60;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const activeOutboundIds = new Set(await journalAgg.getActiveOutboundProductIds(String(companyId), cutoff));
  const products = await Product.find({
    company: String(companyId),
    isActive: true,
    isArchived: false,
    isStockable: true,
    currentStock: { $gt: 0 },
  }).select('_id').lean();
  const deadProductIds = products
    .map((product) => String(product._id || product.id))
    .filter((productId) => productId && !activeOutboundIds.has(productId));

  return {
    count: deadProductIds.length,
    daysThreshold: days,
    sourceIds: deadProductIds.slice(0, 50),
    truncatedSourceIds: Math.max(0, deadProductIds.length - 50),
  };
}

async function getSalesSummary(companyId, opts = {}) {
  const { period = 'month', startDate, endDate } = opts;
  const periodBucket = ['day', 'week', 'month', 'quarter', 'year'].includes(period) ? period : 'month';
  const bucketFormat = periodBucket === 'quarter' ? 'YYYY-"Q"Q' : periodBucket === 'year' ? 'YYYY' : periodBucket === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
  const bucketExpression = periodBucket === 'week'
    ? "date_trunc('week', i.invoice_date)"
    : `date_trunc('${periodBucket}', i.invoice_date)`;
  const clauses = ['i.company_id = $1', "i.status IN ('confirmed', 'partial', 'paid')"];
  const params = [String(companyId)];
  addDatePredicates(clauses, params, 'i.invoice_date', startDate, endDate);
  const whereSql = clauses.join(' AND ');
  const [totals, timelineRows, productRows] = await Promise.all([
    dbClient().invoice.aggregate({
      where: {
        companyId: String(companyId),
        status: { in: ['confirmed', 'partial', 'paid'] },
        ...(dateFilter(startDate, endDate) ? { invoiceDate: dateFilter(startDate, endDate) } : {}),
      },
      _count: { _all: true },
      _sum: { totalAmount: true, amountPaid: true, amountOutstanding: true },
    }),
    dbClient().$queryRawUnsafe(`
      SELECT to_char(${bucketExpression}, $${params.length + 1}) AS period,
             COALESCE(SUM(i.total_amount), 0)::double precision AS revenue,
             COUNT(*)::int AS count
      FROM invoices i
      WHERE ${whereSql}
      GROUP BY ${bucketExpression}
      ORDER BY ${bucketExpression} ASC
      LIMIT 100`, ...params, bucketFormat),
    dbClient().$queryRawUnsafe(`
      SELECT COALESCE(il.product_name, 'Unknown') AS name,
             COALESCE(SUM(il.line_total), 0)::double precision AS revenue
      FROM invoice_lines il
      JOIN invoices i ON i.id = il.invoice_id
      WHERE ${whereSql}
      GROUP BY COALESCE(il.product_name, 'Unknown')
      ORDER BY revenue DESC, name ASC
      LIMIT 10`, ...params),
  ]);
  const totalRevenue = Number(totals._sum?.totalAmount || 0);
  const totalPaid = Number(totals._sum?.amountPaid || 0);
  return {
    totalInvoices: Number(totals._count?._all || 0),
    totalRevenue,
    totalPaid,
    totalOutstanding: Number(totals._sum?.amountOutstanding ?? (totalRevenue - totalPaid)),
    collectionRate: totalRevenue ? (totalPaid / totalRevenue) * 100 : 0,
    timeline: timelineRows.map((row) => ({ period: row.period, revenue: Number(row.revenue || 0), count: Number(row.count || 0) })),
    topProducts: productRows.map((row) => ({ name: row.name, revenue: Number(row.revenue || 0) })),
  };
}

function normalizeHistoryRange(opts = {}) {
  const end = opts.endDate ? new Date(opts.endDate) : new Date();
  const start = opts.startDate ? new Date(opts.startDate) : new Date(end);
  if (!opts.startDate) start.setUTCMonth(start.getUTCMonth() - 24);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
    throw new Error('A valid forecast history date range is required.');
  }
  return { start, end };
}

async function getCashFlowHistory(companyId, opts = {}) {
  const { start, end } = normalizeHistoryRange(opts);
  const monthly = await dbClient().$queryRaw`
    SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS period,
           COALESCE(SUM(CASE WHEN type IN ('deposit', 'transfer_in') THEN amount ELSE 0 END), 0)::double precision AS cash_in,
           COALESCE(SUM(CASE WHEN type IN ('withdrawal', 'transfer_out') THEN amount ELSE 0 END), 0)::double precision AS cash_out,
           COUNT(*)::int AS transaction_count
    FROM bank_transactions
    WHERE company_id = ${String(companyId)}
      AND date >= ${start} AND date <= ${end}
      AND status NOT IN ('reversed', 'voided', 'cancelled')
      AND is_reversed = false
    GROUP BY date_trunc('month', date)
    ORDER BY date_trunc('month', date) ASC
    LIMIT 120
  `;
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    monthly: monthly.map((row) => ({
      period: row.period,
      cashIn: Number(row.cash_in || 0),
      cashOut: Number(row.cash_out || 0),
      netChange: Number(row.cash_in || 0) - Number(row.cash_out || 0),
      transactionCount: Number(row.transaction_count || 0),
    })),
  };
}

async function getInventoryDemandHistory(companyId, opts = {}) {
  const { start, end } = normalizeHistoryRange(opts);
  const rows = await dbClient().$queryRaw`
    WITH monthly_demand AS (
      SELECT sm.product_id,
             p.name AS product_name,
             p.sku,
             p.current_stock,
             p.reserved_quantity,
             p.low_stock_threshold,
             to_char(date_trunc('month', sm.movement_date), 'YYYY-MM') AS period,
             SUM(sm.quantity)::double precision AS units
      FROM stock_movements sm
      JOIN products p ON p.id = sm.product_id AND p.company_id = sm.company_id
      WHERE sm.company_id = ${String(companyId)}
        AND sm.product_id IS NOT NULL
        AND sm.type = 'out'
        AND sm.reason = 'sale'
        AND sm.movement_date >= ${start} AND sm.movement_date <= ${end}
        AND p.is_archived = false
      GROUP BY sm.product_id, p.name, p.sku, p.current_stock, p.reserved_quantity, p.low_stock_threshold, date_trunc('month', sm.movement_date)
    ),
    product_rank AS (
      SELECT product_id,
             MAX(product_name) AS product_name,
             MAX(sku) AS sku,
             MAX(current_stock)::double precision AS current_stock,
             MAX(reserved_quantity)::double precision AS reserved_quantity,
             MAX(low_stock_threshold)::double precision AS low_stock_threshold,
             SUM(units)::double precision AS total_units
      FROM monthly_demand
      GROUP BY product_id
    ),
    selected_products AS (
      SELECT product_id
      FROM product_rank
      WHERE current_stock <= low_stock_threshold
         OR product_id IN (SELECT product_id FROM product_rank ORDER BY total_units DESC, product_id LIMIT 100)
    ),
    bounded AS (
      SELECT md.*, COUNT(*) OVER()::int AS total_rows
      FROM monthly_demand md
      JOIN selected_products sp ON sp.product_id = md.product_id
      ORDER BY md.period DESC, md.product_id
      LIMIT 3000
    )
    SELECT b.product_id,
           b.product_name,
           b.sku,
           b.current_stock,
           b.reserved_quantity,
           b.period,
           b.units,
           b.total_rows
    FROM bounded b
    ORDER BY b.product_name, b.period
  `;
  const productsById = new Map();
  for (const row of rows) {
    const id = String(row.product_id);
    if (!productsById.has(id)) {
      productsById.set(id, {
        productId: id,
        productName: row.product_name,
        sku: row.sku,
        currentStock: Number(row.current_stock || 0),
        reservedQuantity: Number(row.reserved_quantity || 0),
        monthly: [],
      });
    }
    productsById.get(id).monthly.push({ period: row.period, units: Number(row.units || 0) });
  }
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    products: Array.from(productsById.values()),
    truncated: Number(rows[0]?.total_rows || 0) > rows.length,
    returnedMonthlyRows: rows.length,
  };
}

async function getReceivablesCollectionHistory(companyId, opts = {}) {
  const { start, end } = normalizeHistoryRange(opts);
  const monthly = await dbClient().$queryRaw`
    SELECT to_char(date_trunc('month', receipt_date), 'YYYY-MM') AS period,
           COALESCE(SUM(amount_received * exchange_rate), 0)::double precision AS collected,
           COUNT(*)::int AS receipt_count
    FROM ar_receipts
    WHERE company_id = ${String(companyId)}
      AND receipt_date >= ${start} AND receipt_date <= ${end}
      AND status = 'posted'
      AND reverse_journal_entry_id IS NULL
    GROUP BY date_trunc('month', receipt_date)
    ORDER BY date_trunc('month', receipt_date) ASC
    LIMIT 120
  `;
  return {
    from: start.toISOString(), to: end.toISOString(),
    monthly: monthly.map((row) => ({ period: row.period, collected: Number(row.collected || 0), receiptCount: Number(row.receipt_count || 0) })),
  };
}

async function getPayablesPaymentHistory(companyId, opts = {}) {
  const { start, end } = normalizeHistoryRange(opts);
  const monthly = await dbClient().$queryRaw`
    SELECT to_char(date_trunc('month', payment_date), 'YYYY-MM') AS period,
           COALESCE(SUM(amount_paid * exchange_rate), 0)::double precision AS paid,
           COUNT(*)::int AS payment_count
    FROM ap_payments
    WHERE company_id = ${String(companyId)}
      AND payment_date >= ${start} AND payment_date <= ${end}
      AND status = 'posted'
      AND reverse_journal_entry_id IS NULL
    GROUP BY date_trunc('month', payment_date)
    ORDER BY date_trunc('month', payment_date) ASC
    LIMIT 120
  `;
  return {
    from: start.toISOString(), to: end.toISOString(),
    monthly: monthly.map((row) => ({ period: row.period, paid: Number(row.paid || 0), paymentCount: Number(row.payment_count || 0) })),
  };
}

async function getReceivablesAging(companyId) {
  const baseWhere = "i.company_id = $1 AND i.status IN ('confirmed', 'partial') AND i.amount_outstanding > 0";
  const bucketRows = await dbClient().$queryRawUnsafe(`
    SELECT
      CASE
        WHEN COALESCE(i.due_date, i.invoice_date)::date >= CURRENT_DATE THEN 'current'
        WHEN CURRENT_DATE - COALESCE(i.due_date, i.invoice_date)::date <= 30 THEN 'days1_30'
        WHEN CURRENT_DATE - COALESCE(i.due_date, i.invoice_date)::date <= 60 THEN 'days31_60'
        WHEN CURRENT_DATE - COALESCE(i.due_date, i.invoice_date)::date <= 90 THEN 'days61_90'
        ELSE 'over90'
      END AS bucket,
      COALESCE(SUM(i.amount_outstanding), 0)::double precision AS total
    FROM invoices i
    WHERE ${baseWhere}
    GROUP BY bucket
  `, String(companyId));
  const debtorRows = await dbClient().$queryRawUnsafe(`
    SELECT COALESCE(c.name, i.customer_name, 'Unknown') AS name,
           COALESCE(SUM(i.amount_outstanding), 0)::double precision AS total,
           MAX(GREATEST(0, CURRENT_DATE - COALESCE(i.due_date, i.invoice_date)::date))::int AS oldest
    FROM invoices i
    LEFT JOIN clients c ON c.id = i.client_id AND c.company_id = i.company_id
    WHERE ${baseWhere}
    GROUP BY COALESCE(c.name, i.customer_name, 'Unknown')
    ORDER BY total DESC, name ASC
    LIMIT 10
  `, String(companyId));
  const buckets = { current: 0, days1_30: 0, days31_60: 0, days61_90: 0, over90: 0 };
  for (const row of bucketRows) if (Object.prototype.hasOwnProperty.call(buckets, row.bucket)) buckets[row.bucket] = Number(row.total || 0);
  return {
    totalOutstanding: Object.values(buckets).reduce((sum, value) => sum + value, 0),
    buckets,
    topDebtors: debtorRows.map((row) => ({ name: row.name, total: Number(row.total || 0), oldest: Number(row.oldest || 0) })),
  };
}

async function getBankAccounts(companyId) {
  const [accounts, totals] = await Promise.all([
    BankAccount.find({ company: companyId }).limit(AI_MAX_LIST_ROWS).lean(),
    dbClient().bankAccount.aggregate({
      where: { companyId: String(companyId) },
      _count: { _all: true },
      _sum: { cachedBalance: true },
    }),
  ]);
  return {
    count: Number(totals._count?._all || 0),
    totalBalance: Number(totals._sum?.cachedBalance || 0),
    truncated: Number(totals._count?._all || 0) > accounts.length,
    accounts: accounts.map(a => ({
      id: a._id.toString(), name: a.name, type: a.accountType,
      balance: a.currentBalance || a.cachedBalance || 0,
    })),
  };
}

async function getFixedAssets(companyId, opts = {}) {
  const limit = safeAiLimit(opts.limit, AI_MAX_LIST_ROWS);
  const [assets, totals] = await Promise.all([
    FixedAsset.find({ company: companyId }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean(),
    dbClient().fixedAsset.aggregate({
      where: { companyId: String(companyId) },
      _count: { _all: true },
      _sum: { purchaseCost: true, accumulatedDepreciation: true, netBookValue: true },
    }),
  ]);
  return {
    count: Number(totals._count?._all || 0),
    totalCost: Number(totals._sum?.purchaseCost || 0),
    totalDepreciation: Number(totals._sum?.accumulatedDepreciation || 0),
    netBookValue: Number(totals._sum?.netBookValue || 0),
    truncated: Number(totals._count?._all || 0) > assets.length,
    assets: assets.map(a => ({
      id: a._id.toString(), name: a.name, cost: a.cost || a.purchaseCost || 0,
      netBookValue: a.netBookValue ?? ((a.cost || a.purchaseCost || 0) - (a.accumulatedDepreciation || 0)),
      status: a.status,
    })),
  };
}

async function getLoans(companyId, opts = {}) {
  const limit = safeAiLimit(opts.limit, AI_MAX_LIST_ROWS);
  const [loans, totals] = await Promise.all([
    Loan.find({ company: companyId }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean(),
    dbClient().loan.aggregate({
      where: { companyId: String(companyId) },
      _count: { _all: true },
      _sum: { outstandingBalance: true },
    }),
  ]);
  return {
    count: Number(totals._count?._all || 0),
    totalOutstanding: Number(totals._sum?.outstandingBalance || 0),
    truncated: Number(totals._count?._all || 0) > loans.length,
    loans: loans.map(l => ({ id: l._id.toString(), name: l.name, outstandingBalance: l.outstandingBalance || 0, status: l.status })),
  };
}

async function getDashboardMetrics(companyId) {
  const [company, stockSummary, invoices, purchases, expenses, clients, lowStock] = await Promise.all([
    Company.findById(companyId).lean(),
    getStockSummary(companyId),
    Invoice.find({ company: companyId }).sort({ createdAt: -1 }).limit(5).lean(),
    Purchase.find({ company: companyId }).sort({ createdAt: -1 }).limit(5).lean(),
    Expense.find({ company: companyId }).sort({ createdAt: -1 }).limit(5).lean().catch(() => []),
    Client.countDocuments({ company: companyId }).catch(() => 0),
    Product.find({ company: companyId, $expr: { $lte: ['$currentStock', '$lowStockThreshold'] } }).lean().limit(20),
  ]);

  const pendingInvoices = await Invoice.countDocuments({ company: companyId, status: { $in: ['confirmed', 'partial'] } }).catch(() => 0);

  const yearStart = new Date(); yearStart.setMonth(0, 1); yearStart.setHours(0, 0, 0, 0);
  const monthlyRevenue = await getSalesSummary(companyId, { period: 'month', startDate: yearStart.toISOString() });

  return {
    company: { name: company?.name, currency: company?.settings?.currency || 'FRW' },
    products: { total: stockSummary.totalProducts, totalValue: stockSummary.totalStockValue, outOfStock: stockSummary.outOfStockCount, lowStock: stockSummary.lowStockCount || lowStock.length },
    sales: { pendingInvoices, monthlyRevenue: monthlyRevenue.timeline.map((point) => ({ month: point.period, revenue: point.revenue, count: point.count })) },
    clients: { total: clients },
  };
}

async function generateChartData(companyId, opts = {}) {
  const { chartType = 'line', dataType = 'revenue', period = 'month', startDate, endDate, limit = 12 } = opts;
  const boundedLimit = safeAiLimit(limit, 12);
  let labels = [], datasets = [];

  if (dataType === 'revenue') {
    const summary = await getSalesSummary(companyId, { period, startDate, endDate });
    const points = summary.timeline.slice(-boundedLimit);
    labels = points.map((point) => point.period);
    datasets = [{ label: 'Revenue', data: points.map((point) => point.revenue), color: '#6366f1' }];
  }

  if (dataType === 'expenses') {
    const clauses = ['company_id = $1'];
    const params = [String(companyId)];
    addDatePredicates(clauses, params, 'expense_date', startDate, endDate);
    const rows = await dbClient().$queryRawUnsafe(`
      SELECT COALESCE(type, 'Other') AS name,
             COALESCE(SUM(amount), 0)::double precision AS value
      FROM expenses
      WHERE ${clauses.join(' AND ')}
      GROUP BY COALESCE(type, 'Other')
      ORDER BY value DESC, name ASC
      LIMIT ${boundedLimit}`, ...params);
    labels = rows.map((row) => row.name);
    datasets = [{ label: 'Expenses', data: rows.map((row) => Number(row.value || 0)), color: '#ef4444' }];
  }

  if (dataType === 'stock') {
    const products = await Product.find({ company: companyId }).sort({ currentStock: -1, _id: -1 }).limit(boundedLimit).lean();
    labels = products.map((p) => p.name);
    datasets = [{ label: 'Stock Qty', data: products.map((p) => Number(p.currentStock || 0)), color: '#10b981' }];
  }

  if (dataType === 'product_revenue') {
    const rows = await dbClient().$queryRawUnsafe(`
      SELECT COALESCE(il.product_name, 'Unknown') AS name,
             COALESCE(SUM(il.line_total), 0)::double precision AS revenue
      FROM invoice_lines il
      JOIN invoices i ON i.id = il.invoice_id
      WHERE i.company_id = $1 AND i.status IN ('confirmed', 'partial', 'paid')
      GROUP BY COALESCE(il.product_name, 'Unknown')
      ORDER BY revenue DESC, name ASC
      LIMIT ${boundedLimit}`, String(companyId));
    labels = rows.map((row) => row.name);
    datasets = [{ label: 'Revenue', data: rows.map((row) => Number(row.revenue || 0)), color: '#f59e0b' }];
  }

  return { chartType, dataType, labels, datasets, title: `${dataType.replace('_', ' ')} ${chartType}`, currency: 'FRW' };
}

async function getProfitLossSummary(companyId, opts = {}) {
  const { startDate, endDate } = opts;
  const invoiceWhere = {
    companyId: String(companyId),
    status: { in: ['confirmed', 'partial', 'paid'] },
    ...(dateFilter(startDate, endDate) ? { invoiceDate: dateFilter(startDate, endDate) } : {}),
  };
  const expenseWhere = {
    companyId: String(companyId),
    ...(dateFilter(startDate, endDate) ? { expenseDate: dateFilter(startDate, endDate) } : {}),
  };
  const [invoiceTotals, expenseTotals, lineTotals] = await Promise.all([
    dbClient().invoice.aggregate({ where: invoiceWhere, _sum: { totalAmount: true }, _count: { _all: true } }),
    dbClient().expense.aggregate({ where: expenseWhere, _sum: { amount: true } }),
    dbClient().invoiceLine.aggregate({
      where: { companyId: String(companyId), invoice: invoiceWhere },
      _sum: { cogsAmount: true },
    }),
  ]);
  const revenue = Number(invoiceTotals._sum?.totalAmount || 0);
  const totalExpenses = Number(expenseTotals._sum?.amount || 0);
  const recordedCogs = Number(lineTotals._sum?.cogsAmount || 0);
  const cogsEstimated = recordedCogs <= 0 && revenue > 0;
  const cogs = cogsEstimated ? Math.max(0, revenue * 0.6) : recordedCogs;
  const grossProfit = revenue - cogs;
  const operatingProfit = grossProfit - totalExpenses;
  const tax = Math.max(0, operatingProfit * 0.3);
  const netProfit = operatingProfit - tax;

  return {
    revenue, cogs, cogsEstimated, grossProfit, operatingExpenses: totalExpenses, operatingProfit,
    tax, netProfit, isProfit: netProfit >= 0, currency: 'FRW',
    totalInvoices: Number(invoiceTotals._count?._all || 0),
  };
}

async function getCategories(companyId, opts = {}) {
  opts = opts || {};
  const { search = '', limit = 50 } = opts;
  const q = { company: companyId };
  if (search) q.name = { $regex: search, $options: 'i' };
  const categories = await Category.find(q).limit(safeAiLimit(limit, 50)).lean();
  return { count: categories.length, categories: categories.map(c => ({ id: c._id, name: c.name, description: c.description })) };
}

async function getWarehouses(companyId, opts = {}) {
  opts = opts || {};
  const limit = safeAiLimit(opts.limit, 50);
  const [warehouses, total] = await Promise.all([
    Warehouse.find({ company: companyId }).sort({ name: 1, _id: 1 }).limit(limit).lean(),
    Warehouse.countDocuments({ company: companyId }),
  ]);
  return { count: total, truncated: total > warehouses.length, warehouses: warehouses.map(w => ({ id: w._id, name: w.name, location: w.location, capacity: w.capacity })) };
}

async function getStockMovements(companyId, opts = {}) {
  opts = opts || {};
  const { limit = 20, startDate, endDate } = opts;
  const q = { company: companyId };
  const df = dateFilter(startDate, endDate);
  if (df) q.date = df;
  const movements = await StockMovement.find(q)
    .sort({ date: -1 })
    .limit(safeAiLimit(limit))
    .populate('product', 'name sku')
    .populate('warehouse', 'name')
    .lean();
  return {
    count: movements.length,
    movements: movements.map((m) => ({
      id: m._id,
      type: m.type,
      product: m.product?.name || 'Unknown',
      sku: m.product?.sku || '',
      warehouse: m.warehouse?.name || 'Unknown',
      quantity: m.quantity,
      date: m.date,
      reason: m.reason || '',
    })),
  };
}

async function getStockTransfers(companyId, opts = {}) {
  opts = opts || {};
  const { limit = 20, status = '' } = opts;
  const q = { company: companyId };
  if (status) q.status = status;
  const transfers = await StockTransfer.find(q)
    .sort({ createdAt: -1 })
    .limit(safeAiLimit(limit))
    .populate('fromWarehouse', 'name')
    .populate('toWarehouse', 'name')
    .lean();
  return {
    count: transfers.length,
    transfers: transfers.map((t) => ({
      id: t._id,
      transferNumber: t.transferNumber,
      status: t.status,
      date: t.createdAt,
      fromWarehouse: t.fromWarehouse?.name || 'Unknown',
      toWarehouse: t.toWarehouse?.name || 'Unknown',
      totalItems: t.totalItems,
      totalQuantity: t.totalQuantity,
    })),
  };
}

async function getSuppliers(companyId, opts = {}) {
  opts = opts || {};
  const { search = '', limit = 50 } = opts;
  const q = { company: companyId };
  if (search) q.name = { $regex: search, $options: 'i' };
  const suppliers = await Supplier.find(q).limit(safeAiLimit(limit, 50)).lean();
  return { count: suppliers.length, suppliers: suppliers.map(s => ({ id: s._id, name: s.name, email: s.email, phone: s.phone, balance: s.balance })) };
}

async function getPurchaseOrders(companyId, opts = {}) {
  opts = opts || {};
  const { status = '', limit = 20, startDate, endDate } = opts;
  const q = { company: companyId };
  if (status) q.status = status;
  const df = dateFilter(startDate, endDate);
  if (df) q.orderDate = df;
  const orders = await PurchaseOrder.find(q)
    .sort({ orderDate: -1 })
    .limit(safeAiLimit(limit))
    .populate('supplier', 'name')
    .lean();
  return {
    count: orders.length,
    orders: orders.map((o) => ({
      id: o._id,
      purchaseNumber: o.purchaseNumber,
      status: o.status,
      date: o.orderDate,
      supplier: o.supplier?.name || 'Unknown',
      total: o.total,
      items: (o.items || []).map((i) => ({
        name: i.name,
        quantity: i.qty || i.quantity,
        unitPrice: i.unitPrice,
        total: i.total,
      })),
    })),
  };
}

async function getGoodsReceivedNotes(companyId, opts = {}) {
  opts = opts || {};
  const { limit = 20, startDate, endDate } = opts;
  const q = { company: companyId };
  const df = dateFilter(startDate, endDate);
  if (df) q.date = df;
  const grns = await GoodsReceivedNote.find(q)
    .sort({ date: -1 })
    .limit(safeAiLimit(limit))
    .populate('purchaseOrder', 'purchaseNumber')
    .populate('warehouse', 'name')
    .populate('supplier', 'name')
    .populate('lines.product', 'name sku')
    .lean();
  return {
    count: grns.length,
    grns: grns.map((g) => ({
      referenceNo: g.referenceNo,
      status: g.status,
      date: g.date,
      supplier: g.supplier?.name || 'Unknown',
      warehouse: g.warehouse?.name || 'Unknown',
      purchaseOrder: g.purchaseOrder?.purchaseNumber || 'N/A',
      totalAmount: g.totalAmount,
      amountPaid: g.amountPaid,
      balance: g.balance,
      lines: (g.lines || []).map((l) => ({
        name: l.product?.name || 'Unknown',
        sku: l.product?.sku || '',
        quantity: l.qtyReceived,
        unitCost: l.unitCost,
        taxRate: l.taxRate,
      })),
    })),
  };
}

async function getCreditNotes(companyId, opts = {}) {
  opts = opts || {};
  const { limit = 20, startDate, endDate } = opts;
  const q = { company: companyId };
  const df = dateFilter(startDate, endDate);
  if (df) q.date = df;
  const notes = await CreditNote.find(q)
    .sort({ date: -1 })
    .limit(safeAiLimit(limit))
    .populate('invoice', 'invoiceNumber')
    .lean();
  return {
    count: notes.length,
    notes: notes.map((n) => ({
      id: n._id,
      creditNoteNumber: n.creditNoteNumber,
      date: n.date,
      invoice: n.invoice?.invoiceNumber || 'N/A',
      total: n.total,
      status: n.status,
    })),
  };
}

async function getDeliveryNotes(companyId, opts = {}) {
  opts = opts || {};
  const { limit = 20, startDate, endDate } = opts;
  const q = { company: companyId };
  const df = dateFilter(startDate, endDate);
  if (df) q.date = df;
  const notes = await DeliveryNote.find(q)
    .sort({ date: -1 })
    .limit(safeAiLimit(limit))
    .populate('salesOrder', 'orderNumber')
    .lean();
  return {
    count: notes.length,
    notes: notes.map((n) => ({
      id: n._id,
      deliveryNoteNumber: n.deliveryNoteNumber,
      date: n.date,
      salesOrder: n.salesOrder?.orderNumber || 'N/A',
      status: n.status,
      totalItems: n.totalItems,
    })),
  };
}

async function getQuotations(companyId, opts = {}) {
  opts = opts || {};
  const { status = '', limit = 20, startDate, endDate } = opts;
  const q = { company: companyId };
  if (status) q.status = status;
  const df = dateFilter(startDate, endDate);
  if (df) q.quotationDate = df;
  const quotations = await Quotation.find(q)
    .sort({ quotationDate: -1 })
    .limit(safeAiLimit(limit))
    .populate('client', 'name')
    .populate('salesperson', 'name email')
    .lean();
  return {
    count: quotations.length,
    quotations: quotations.map((q) => ({
      id: q._id,
      quotationNumber: q.quotationNumber,
      date: q.quotationDate,
      client: q.client?.name || 'Unknown',
      salesperson: q.salesperson?.name || q.salesperson?.email || 'Unknown',
      total: q.total,
      status: q.status,
      expiryDate: q.expiryDate,
    })),
  };
}

async function getSalesOrders(companyId, opts = {}) {
  opts = opts || {};
  const { status = '', limit = 20, startDate, endDate } = opts;
  const q = { company: companyId };
  if (status) q.status = status;
  const df = dateFilter(startDate, endDate);
  if (df) q.orderDate = df;
  const orders = await SalesOrder.find(q)
    .sort({ orderDate: -1 })
    .limit(safeAiLimit(limit))
    .populate('client', 'name')
    .lean();
  return {
    count: orders.length,
    orders: orders.map((o) => ({
      id: o._id,
      orderNumber: o.orderNumber,
      client: o.client?.name || 'Unknown',
      status: o.status,
      total: o.total,
      date: o.orderDate,
    })),
  };
}

async function getARReceipts(companyId, opts = {}) {
  opts = opts || {};
  const { limit = 20, startDate, endDate } = opts;
  const q = { company: companyId };
  const df = dateFilter(startDate, endDate);
  if (df) q.receiptDate = df;
  const receipts = await ARReceipt.find(q)
    .sort({ receiptDate: -1 })
    .limit(safeAiLimit(limit))
    .populate('client', 'name')
    .populate('bankAccount', 'accountName bankName')
    .lean();
  return {
    count: receipts.length,
    receipts: receipts.map((r) => ({
      receiptNumber: r.receiptNumber,
      receiptDate: r.receiptDate,
      client: r.client?.name || 'Unknown',
      bankAccount: r.bankAccount?.accountName || r.bankAccount?.bankName || 'Unknown',
      amountPaid: r.amountPaid,
      status: r.status,
      paymentMethod: r.paymentMethod,
    })),
  };
}

async function getAPPayments(companyId, opts = {}) {
  opts = opts || {};
  const { limit = 20, startDate, endDate } = opts;
  const q = { company: companyId };
  const df = dateFilter(startDate, endDate);
  if (df) q.paymentDate = df;
  const payments = await APPayment.find(q)
    .sort({ paymentDate: -1 })
    .limit(safeAiLimit(limit))
    .populate('supplier', 'name')
    .populate('bankAccount', 'accountName bankName')
    .lean();
  return {
    count: payments.length,
    payments: payments.map((p) => ({
      paymentNumber: p.paymentNumber,
      paymentDate: p.paymentDate,
      supplier: p.supplier?.name || 'Unknown',
      bankAccount: p.bankAccount?.accountName || p.bankAccount?.bankName || 'Unknown',
      amountPaid: p.amountPaid,
      status: p.status,
      paymentMethod: p.paymentMethod,
    })),
  };
}

async function getChartOfAccounts(companyId, opts = {}) {
  opts = opts || {};
  const { type = '', search = '', limit = 50 } = opts;
  const q = { company: companyId };
  if (type) q.accountType = type;
  if (search) q.name = { $regex: search, $options: 'i' };
  const accounts = await ChartOfAccount.find(q).limit(safeAiLimit(limit, 50)).lean();
  return { count: accounts.length, accounts: accounts.map(a => ({ id: a._id, code: a.code, name: a.name, type: a.accountType, balance: a.balance })) };
}

async function getJournalEntries(companyId, opts = {}) {
  opts = opts || {};
  const { limit = 20, startDate, endDate } = opts;
  const q = { company: companyId };
  const df = dateFilter(startDate, endDate);
  if (df) q.date = df;
  const entries = await JournalEntry.find(q).sort({ date: -1, _id: -1 }).limit(safeAiLimit(limit)).lean();
  return { count: entries.length, entries };
}

async function getBudgets(companyId, opts = {}) {
  opts = opts || {};
  const { limit = 20, fiscalYear = '' } = opts;
  const q = { company: companyId };
  if (fiscalYear) q.fiscalYear = fiscalYear;
  const budgets = await Budget.find(q).sort({ createdAt: -1, _id: -1 }).limit(safeAiLimit(limit)).lean();
  return { count: budgets.length, budgets };
}

async function getDepartments(companyId, opts = {}) {
  opts = opts || {};
  const { search = '', limit = 50 } = opts;
  const q = { company: companyId };
  if (search) q.name = { $regex: search, $options: 'i' };
  const departments = await Department.find(q).limit(safeAiLimit(limit, 50)).lean();
  return { count: departments.length, departments: departments.map(d => ({ id: d._id, name: d.name, manager: d.manager, budget: d.budget })) };
}

async function getCompanyUsers(companyId, opts = {}) {
  opts = opts || {};
  const { role = '', limit = 50 } = opts;
  const { prisma } = require('../lib/prisma');
  const users = await prisma.user.findMany({
    where: { companyId: String(companyId), ...(role ? { role } : {}) },
    take: safeAiLimit(limit, 50),
    select: { id: true, name: true, email: true, role: true, isActive: true },
  });
  return {
    count: users.length,
    users: users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.isActive ? 'active' : 'inactive' })),
  };
}

async function getNotifications(companyId, opts = {}) {
  opts = opts || {};
  const { limit = 20, unreadOnly = false } = opts;
  const q = { company: companyId };
  if (unreadOnly) q.read = false;
  const notifications = await Notification.find(q).sort({ createdAt: -1, _id: -1 }).limit(safeAiLimit(limit)).lean();
  return { count: notifications.length, notifications: notifications.map(n => ({ id: n._id, title: n.title, message: n.message, read: n.read, type: n.type, createdAt: n.createdAt })) };
}

async function getAuditLogs(companyId, opts = {}) {
  opts = opts || {};
  const { limit = 20, action = '', startDate, endDate } = opts;
  const q = { company: companyId };
  if (action) q.action = action;
  const df = dateFilter(startDate, endDate);
  if (df) q.timestamp = df;
  const logs = await AuditLog.find(q).sort({ timestamp: -1, _id: -1 }).limit(safeAiLimit(limit)).lean();
  return { count: logs.length, logs: logs.map(l => ({ id: l._id, user: l.userName || l.userEmail, action: l.action, entity: l.entityType, details: l.details, timestamp: l.timestamp })) };
}

async function getBalanceSheet(companyId, opts = {}) {
  opts = opts || {};
  const { asOfDate } = opts;
  const params = [String(companyId)];
  const dateClause = asOfDate ? 'AND je.date <= $2' : '';
  if (asOfDate) params.push(new Date(asOfDate));
  const [row] = await dbClient().$queryRawUnsafe(`
    SELECT
      COALESCE(SUM(CASE WHEN LOWER(coa.type::text) LIKE '%asset%' THEN jel.debit - jel.credit ELSE 0 END), 0)::double precision AS assets,
      COALESCE(SUM(CASE WHEN LOWER(coa.type::text) LIKE '%liabilit%' THEN jel.credit - jel.debit ELSE 0 END), 0)::double precision AS liabilities,
      COALESCE(SUM(CASE WHEN LOWER(coa.type::text) LIKE '%equity%' OR LOWER(coa.type::text) LIKE '%capital%' THEN jel.credit - jel.debit ELSE 0 END), 0)::double precision AS equity
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    LEFT JOIN chart_of_accounts coa ON coa.company_id = jel.company_id AND coa.code = jel.account_code
    WHERE jel.company_id = $1 AND je.status = 'posted' ${dateClause}
  `, ...params);
  const assets = Number(row?.assets || 0);
  const liabilities = Number(row?.liabilities || 0);
  const equity = Number(row?.equity || 0);
  return { asOfDate: asOfDate || new Date().toISOString().slice(0, 10), totalAssets: assets, totalLiabilities: liabilities, totalEquity: equity, balanced: Math.abs(assets - liabilities - equity) < 0.01, currency: 'FRW' };
}

async function getCashFlowSummary(companyId, opts = {}) {
  opts = opts || {};
  const { startDate, endDate } = opts;
  const date = {};
  if (dateFilter(startDate, endDate)?.$gte) date.gte = dateFilter(startDate, endDate).$gte;
  if (dateFilter(startDate, endDate)?.$lte) date.lte = dateFilter(startDate, endDate).$lte;
  const [bankTotals, journalTotals] = await Promise.all([
    dbClient().bankAccount.aggregate({
      where: { companyId: String(companyId) },
      _sum: { cachedBalance: true },
    }),
    dbClient().journalEntry.aggregate({
      where: { companyId: String(companyId), status: 'posted', ...(Object.keys(date).length ? { date } : {}) },
      _sum: { totalDebit: true, totalCredit: true },
    }),
  ]);
  const bankBalance = Number(bankTotals._sum?.cachedBalance || 0);
  const cashIn = Number(journalTotals._sum?.totalDebit || 0);
  const cashOut = Number(journalTotals._sum?.totalCredit || 0);
  return { bankBalance, cashIn, cashOut, netCashFlow: cashIn - cashOut, period: { startDate, endDate }, currency: 'FRW' };
}

function getModuleCatalog() {
  return {
    count: MODULE_CATALOG.reduce((sum, section) => sum + section.modules.length, 0),
    sections: MODULE_CATALOG,
    adaptivePolicy: 'Use get_module_records for supported record lists. For newly added modules, first inspect the catalog and available tools, then explain what Stacy can verify live and what needs a newly exposed API/tool.',
  };
}

async function getModuleRecords(companyId, opts = {}) {
  const moduleKey = String(opts.moduleKey || opts.module || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!moduleKey) return { error: 'moduleKey is required.' };
  const getter = MODULE_RECORD_TOOLS[moduleKey];
  if (!getter) {
    return {
      error: `Unsupported moduleKey: ${moduleKey}`,
      supportedModuleKeys: Object.keys(MODULE_RECORD_TOOLS),
    };
  }
  return getter(companyId, opts);
}

function linearForecast(points, periods = 3) {
  const clean = points
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value));
  if (clean.length === 0) return [];
  if (clean.length === 1) return Array.from({ length: periods }, () => Math.max(0, clean[0]));

  const n = clean.length;
  const xs = clean.map((_, i) => i + 1);
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = clean.reduce((a, b) => a + b, 0) / n;
  const numerator = xs.reduce((sum, x, i) => sum + ((x - xMean) * (clean[i] - yMean)), 0);
  const denominator = xs.reduce((sum, x) => sum + ((x - xMean) ** 2), 0) || 1;
  const slope = numerator / denominator;
  const intercept = yMean - (slope * xMean);
  return Array.from({ length: periods }, (_, i) => Math.max(0, Math.round(intercept + (slope * (n + i + 1)))));
}

function nextMonthLabel(fromDate, offset) {
  const d = new Date(fromDate.getFullYear(), fromDate.getMonth() + offset, 1);
  return d.toLocaleString('en', { month: 'short', year: 'numeric' });
}

async function forecastBusiness(companyId, opts = {}) {
  const { metric = 'revenue', periods = 3, startDate, endDate } = opts;
  const dataType = metric === 'inventory' || metric === 'stock' ? 'stock' : metric === 'expenses' ? 'expenses' : 'revenue';
  const chart = await generateChartData(companyId, {
    dataType,
    chartType: 'line',
    period: 'month',
    startDate,
    endDate,
    limit: 12,
  });

  const historical = chart.datasets?.[0]?.data || [];
  const predicted = linearForecast(historical, Math.min(Math.max(Number(periods) || 3, 1), 12));
  const latest = historical.length ? Number(historical[historical.length - 1] || 0) : 0;
  const volatility = historical.length > 1
    ? historical.reduce((sum, value) => sum + Math.abs(Number(value || 0) - latest), 0) / historical.length
    : latest * 0.15;
  const confidence = historical.length >= 6 ? 'medium' : historical.length >= 3 ? 'low' : 'low';
  const now = new Date();

  return {
    metric,
    confidence,
    method: 'linear trend over available monthly history',
    actual: (chart.labels || []).map((label, index) => ({ period: label, actual: historical[index] })),
    forecast: predicted.map((value, index) => ({
      period: nextMonthLabel(now, index + 1),
      predicted: value,
      lowerBound: Math.max(0, Math.round(value - volatility)),
      upperBound: Math.round(value + volatility),
    })),
    caveats: [
      historical.length < 6 ? 'Limited history reduces forecast confidence.' : 'Forecast assumes recent trend continues.',
      'Forecast is decision support, not a guarantee.',
    ],
    currency: dataType === 'stock' ? undefined : 'FRW',
  };
}

async function calculateFinancialRatios(companyId) {
  const [pl, balance, cash, receivables] = await Promise.all([
    getProfitLossSummary(companyId),
    getBalanceSheet(companyId),
    getCashFlowSummary(companyId),
    getReceivablesAging(companyId),
  ]);
  const safeDiv = (a, b) => (Number(b) ? Number(a || 0) / Number(b) : null);
  return {
    profitability: {
      grossMargin: safeDiv(pl.grossProfit, pl.revenue),
      netMargin: safeDiv(pl.netProfit, pl.revenue),
    },
    liquidity: {
      debtToAssets: safeDiv(balance.totalLiabilities, balance.totalAssets),
      cashToLiabilities: safeDiv(cash.bankBalance, balance.totalLiabilities),
    },
    collections: {
      receivablesOver90Share: safeDiv(receivables.buckets.over90, receivables.totalOutstanding),
      totalOutstanding: receivables.totalOutstanding,
    },
    source: 'Computed from Stacy live tools.',
    currency: 'FRW',
  };
}

function ensureDownloadsDir() {
  const downloadsDir = path.join(__dirname, '..', 'downloads');
  if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
  return downloadsDir;
}

function buildPublicDownloadUrl(fileNameFull) {
  let baseUrl = process.env.SERVER_BASE_URL;
  try {
    const env = require('../src/config/environment');
    const cfg = env.getConfig ? env.getConfig() : env;
    if (!baseUrl) baseUrl = `http://localhost:${(cfg && cfg.server && cfg.server.port) || process.env.PORT || 3000}`;
  } catch (e) {
    if (!baseUrl) baseUrl = `http://localhost:${process.env.PORT || 3000}`;
  }
  baseUrl = String(baseUrl).replace(/\/$/, '');
  const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-for-downloads';
  const token = jwt.sign(
    { file: fileNameFull, exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) },
    JWT_SECRET
  );
  return `${baseUrl}/public-download/${token}`;
}

function cleanupOldDownloads() {
  try {
    const downloadsDir = ensureDownloadsDir();
    const ONE_DAY = 24 * 60 * 60 * 1000;
    fs.readdirSync(downloadsDir).forEach((f) => {
      const fp = path.join(downloadsDir, f);
      if (fs.statSync(fp).mtimeMs < Date.now() - ONE_DAY) fs.unlinkSync(fp);
    });
  } catch (_cleanupErr) {
    /* ignore cleanup errors */
  }
}

// Tool definitions for the LLM
const TOOL_DEFINITIONS = [
  // Company & System
  { type: 'function', function: { name: 'get_company_info', description: 'Get company profile, settings, fiscal year, tax settings, and currency configuration', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_module_catalog', description: 'List every major app module Stacy understands, grouped like the sidebar. Use before answering broad questions about system capabilities or newly added modules.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_module_records', description: 'Generic adaptive record fetcher by moduleKey. Use when the user names a module and Stacy needs live records. Supported keys include products, invoices, clients, suppliers, purchase_orders, sales_orders, expenses, budgets, users, audit_logs, and more.', parameters: { type: 'object', properties: { moduleKey: { type: 'string' }, limit: { type: 'integer', default: 20 }, search: { type: 'string' }, status: { type: 'string' }, startDate: { type: 'string' }, endDate: { type: 'string' } }, required: ['moduleKey'] } } },
  // Dashboard
  { type: 'function', function: { name: 'get_dashboard_metrics', description: 'High-level business dashboard: KPIs, recent activity, top products, alerts, and quick stats', parameters: { type: 'object', properties: {} } } },
  // Inventory
  { type: 'function', function: { name: 'get_products', description: 'List products with stock levels, pricing, reorder points, categories, and warehouse locations', parameters: { type: 'object', properties: { limit: { type: 'integer', default: 50 }, search: { type: 'string' }, lowStock: { type: 'boolean', default: false }, outOfStock: { type: 'boolean', default: false } } } } },
  { type: 'function', function: { name: 'get_categories', description: 'List product categories', parameters: { type: 'object', properties: { limit: { type: 'integer', default: 50 }, search: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_warehouses', description: 'List warehouses with locations and capacities', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_stock_movements', description: 'List stock movements (in/out/adjustments) by date range', parameters: { type: 'object', properties: { limit: { type: 'integer', default: 20 }, startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_stock_transfers', description: 'List stock transfers between warehouses', parameters: { type: 'object', properties: { limit: { type: 'integer', default: 20 }, status: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_stock_summary', description: 'Stock overview: totals, low stock, out of stock, and valuation', parameters: { type: 'object', properties: {} } } },
  // Purchasing
  { type: 'function', function: { name: 'get_purchases', description: 'List purchase records/bills with filters', parameters: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer', default: 20 }, startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_purchase_orders', description: 'List purchase orders with status and date filters', parameters: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer', default: 20 }, startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_suppliers', description: 'List suppliers/vendors with contact info and balance', parameters: { type: 'object', properties: { limit: { type: 'integer', default: 50 }, search: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_goods_received_notes', description: 'List goods received notes (GRNs) for incoming stock', parameters: { type: 'object', properties: { limit: { type: 'integer', default: 20 }, startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  // Sales
  { type: 'function', function: { name: 'get_invoices', description: 'List sales invoices with status, amount, and date filters', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['draft', 'confirmed', 'partial', 'paid', 'cancelled'] }, limit: { type: 'integer', default: 20 }, startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_quotations', description: 'List sales quotations/estimates', parameters: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer', default: 20 }, startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_sales_orders', description: 'List sales orders with status and date filters', parameters: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer', default: 20 }, startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_delivery_notes', description: 'List delivery notes / dispatch records', parameters: { type: 'object', properties: { limit: { type: 'integer', default: 20 }, startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_credit_notes', description: 'List credit notes and refunds', parameters: { type: 'object', properties: { limit: { type: 'integer', default: 20 }, startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_clients', description: 'List customers/clients with contact info and balance', parameters: { type: 'object', properties: { limit: { type: 'integer', default: 50 }, search: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_ar_receipts', description: 'List accounts receivable receipts (customer payments)', parameters: { type: 'object', properties: { limit: { type: 'integer', default: 20 }, startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_receivables_aging', description: 'Aging analysis of accounts receivable: current, 30, 60, 90, 120+ days overdue', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_sales_summary', description: 'Sales analytics: timeline, top products, customer trends', parameters: { type: 'object', properties: { period: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'], default: 'month' }, startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  // Finance
  { type: 'function', function: { name: 'get_expenses', description: 'List expenses by type, category, and period', parameters: { type: 'object', properties: { type: { type: 'string' }, limit: { type: 'integer', default: 20 }, startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_bank_accounts', description: 'List bank and cash accounts with current balances', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_chart_of_accounts', description: 'List chart of accounts (general ledger accounts) with balances', parameters: { type: 'object', properties: { type: { type: 'string' }, search: { type: 'string' }, limit: { type: 'integer', default: 50 } } } } },
  { type: 'function', function: { name: 'get_journal_entries', description: 'List journal entries / general ledger transactions', parameters: { type: 'object', properties: { limit: { type: 'integer', default: 20 }, startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_fixed_assets', description: 'List fixed assets, purchase cost, depreciation, and net book value', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_loans', description: 'List loans, liabilities, outstanding balances, and payment schedules', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_ap_payments', description: 'List accounts payable payments (vendor payments)', parameters: { type: 'object', properties: { limit: { type: 'integer', default: 20 }, startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_budgets', description: 'List budgets with actual vs budgeted amounts', parameters: { type: 'object', properties: { limit: { type: 'integer', default: 20 }, fiscalYear: { type: 'string' } } } } },
  // Reports
  { type: 'function', function: { name: 'get_profit_loss_summary', description: 'Compute Profit & Loss statement: revenue, COGS, gross profit, operating expenses, tax, net profit', parameters: { type: 'object', properties: { startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_balance_sheet', description: 'Compute Balance Sheet: total assets, liabilities, and equity', parameters: { type: 'object', properties: { asOfDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_cash_flow_summary', description: 'Cash flow summary: bank balance, cash in, cash out, net cash flow', parameters: { type: 'object', properties: { startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'calculate_financial_ratios', description: 'Calculate profitability, liquidity, debt, and collection ratios from live company data. Use for ratio analysis and financial interpretation.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'forecast_business', description: 'Create a deterministic forecast from historical live data. Use for revenue, sales, expense, cash-flow, or inventory predictions before giving recommendations.', parameters: { type: 'object', properties: { metric: { type: 'string', enum: ['revenue', 'sales', 'expenses', 'cash-flow', 'inventory', 'stock'], default: 'revenue' }, periods: { type: 'integer', default: 3 }, startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'generate_chart_data', description: 'Prepare chart data for rendering. Use when user asks for charts, trends, or visualizations. Supports line, bar, pie, doughnut charts.', parameters: { type: 'object', properties: { chartType: { type: 'string', enum: ['line', 'bar', 'pie', 'doughnut'], default: 'line' }, dataType: { type: 'string', enum: ['revenue', 'expenses', 'stock', 'product_revenue'], default: 'revenue' }, period: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'], default: 'month' }, startDate: { type: 'string' }, endDate: { type: 'string' }, limit: { type: 'integer', default: 12 } }, required: ['dataType'] } } },
  // Export
  { type: 'function', function: { name: 'generate_excel', description: 'Generate an Excel file from tabular data and return a download link. Use when the user asks to export, download, or save data as Excel/CSV. The data parameter must be an array of objects (rows) with keys as column headers. The sheetName should describe the data (e.g. "Sales Report", "Stock Levels").', parameters: { type: 'object', properties: { title: { type: 'string', description: 'Workbook title / header row text' }, sheetName: { type: 'string', description: 'Sheet tab name (max 31 chars)' }, data: { type: 'array', items: { type: 'object' }, description: 'Array of objects, each object is a row with keys as column headers' }, fileName: { type: 'string', description: 'Optional custom filename without extension' } }, required: ['title', 'sheetName', 'data'] } } },
  { type: 'function', function: { name: 'export_data', description: 'Generate Excel, CSV, or PDF files from analyzed tabular data and return a signed download link. Prefer this for user-requested file exports. Always provide analysis before the link.', parameters: { type: 'object', properties: { format: { type: 'string', enum: ['excel', 'csv', 'pdf'], default: 'excel' }, title: { type: 'string' }, sheetName: { type: 'string' }, data: { type: 'array', items: { type: 'object' } }, analysis: { type: 'string' }, fileName: { type: 'string' } }, required: ['format', 'title', 'data'] } } },
  // System & Admin
  { type: 'function', function: { name: 'get_departments', description: 'List company departments and managers', parameters: { type: 'object', properties: { limit: { type: 'integer', default: 50 }, search: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_company_users', description: 'List system users, roles, and status', parameters: { type: 'object', properties: { role: { type: 'string' }, limit: { type: 'integer', default: 50 } } } } },
  { type: 'function', function: { name: 'get_audit_logs', description: 'List recent system audit logs and user activity', parameters: { type: 'object', properties: { limit: { type: 'integer', default: 20 }, action: { type: 'string' }, startDate: { type: 'string' }, endDate: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_notifications', description: 'List system notifications and alerts', parameters: { type: 'object', properties: { limit: { type: 'integer', default: 20 }, unreadOnly: { type: 'boolean', default: false } } } } },
];

// Generate Excel file from tabular data and return a download link
async function generateExcel(args) {
  const { title, sheetName = 'Sheet1', data, fileName } = args || {};
  if (!Array.isArray(data) || data.length === 0) {
    return { error: 'No data provided. Pass an array of objects as the "data" parameter.' };
  }

  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(sheetName.slice(0, 31));

    // Add header row with title
    if (title) {
      sheet.addRow([title]);
      sheet.mergeCells(1, 1, 1, Object.keys(data[0]).length);
      sheet.getCell(1, 1).font = { bold: true, size: 14 };
      sheet.getCell(1, 1).alignment = { horizontal: 'center' };
      sheet.addRow([]);
    }

    // Column headers
    const headers = Object.keys(data[0]);
    sheet.addRow(headers);
    if (title) {
      sheet.getRow(3).font = { bold: true };
      sheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3D3D3' } };
    } else {
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3D3D3' } };
    }

    // Data rows
    data.forEach((row) => {
      const values = headers.map((h) => row[h] ?? '');
      sheet.addRow(values);
    });

    // Auto-fit columns
    sheet.columns.forEach((col) => {
      let maxLength = 10;
      col.eachCell({ includeEmpty: false }, (cell) => {
        const cellValue = cell.value ? String(cell.value) : '';
        maxLength = Math.max(maxLength, cellValue.length + 2);
      });
      col.width = Math.min(maxLength, 60);
    });

    const downloadsDir = ensureDownloadsDir();

    const timestamp = Date.now();
    const safeFileName = fileName ? fileName.replace(/[^a-zA-Z0-9_-]/g, '_') : `stacy-export-${timestamp}`;
    const fileNameFull = `${safeFileName}.xlsx`;
    const filePath = path.join(downloadsDir, fileNameFull);
    await workbook.xlsx.writeFile(filePath);

    // Verify file was created and log details
    const stats = fs.statSync(filePath);
    console.log(`[generateExcel] File created: ${filePath}, Size: ${stats.size} bytes`);

    cleanupOldDownloads();
    const publicDownloadUrl = buildPublicDownloadUrl(fileNameFull);

    return {
      downloadUrl: publicDownloadUrl,
      fileName: fileNameFull,
      rows: data.length,
      columns: headers.length,
      fileSize: stats.size,
    };
  } catch (err) {
    return { error: `Failed to generate Excel: ${err.message || 'Unknown error'}` };
  }
}

async function generateCsv(args) {
  const { data, fileName } = args || {};
  if (!Array.isArray(data) || data.length === 0) {
    return { error: 'No data provided. Pass an array of objects as the "data" parameter.' };
  }
  try {
    const downloadsDir = ensureDownloadsDir();
    const safeFileName = fileName ? fileName.replace(/[^a-zA-Z0-9_-]/g, '_') : `stacy-export-${Date.now()}`;
    const fileNameFull = `${safeFileName}.csv`;
    const filePath = path.join(downloadsDir, fileNameFull);
    const csv = stringify(data, { header: true });
    fs.writeFileSync(filePath, `\uFEFF${csv}`, 'utf8');
    const stats = fs.statSync(filePath);
    cleanupOldDownloads();
    return {
      downloadUrl: buildPublicDownloadUrl(fileNameFull),
      fileName: fileNameFull,
      rows: data.length,
      columns: Object.keys(data[0]).length,
      fileSize: stats.size,
    };
  } catch (err) {
    return { error: `Failed to generate CSV: ${err.message || 'Unknown error'}` };
  }
}

async function generatePdf(args) {
  const { title = 'Stacy Report', data, fileName, analysis = '' } = args || {};
  if (!Array.isArray(data) || data.length === 0) {
    return { error: 'No data provided. Pass an array of objects as the "data" parameter.' };
  }

  try {
    const downloadsDir = ensureDownloadsDir();
    const safeFileName = fileName ? fileName.replace(/[^a-zA-Z0-9_-]/g, '_') : `stacy-report-${Date.now()}`;
    const fileNameFull = `${safeFileName}.pdf`;
    const filePath = path.join(downloadsDir, fileNameFull);
    const doc = new PDFDocument({ margin: 36, size: 'A4' });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(16).font('Helvetica-Bold').text(title, { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(8).font('Helvetica').text(`Generated by Stacy on ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown();

    if (analysis) {
      doc.fontSize(10).font('Helvetica-Bold').text('Analysis');
      doc.fontSize(9).font('Helvetica').text(String(analysis).slice(0, 1800), { lineGap: 2 });
      doc.moveDown();
    }

    const headers = Object.keys(data[0]).slice(0, 6);
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colWidth = pageWidth / Math.max(headers.length, 1);
    const drawRow = (values, isHeader = false) => {
      const startY = doc.y;
      if (startY > doc.page.height - 70) doc.addPage();
      values.forEach((value, index) => {
        doc
          .fontSize(isHeader ? 8 : 7)
          .font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
          .text(String(value ?? '').slice(0, 80), doc.page.margins.left + (index * colWidth), doc.y, {
            width: colWidth - 4,
            lineBreak: false,
          });
      });
      doc.y = startY + (isHeader ? 18 : 16);
    };

    drawRow(headers, true);
    data.slice(0, 200).forEach((row) => drawRow(headers.map((h) => row[h])));
    if (data.length > 200) {
      doc.moveDown();
      doc.fontSize(8).font('Helvetica-Oblique').text(`Showing first 200 of ${data.length} rows.`);
    }

    doc.end();
    await new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
    const stats = fs.statSync(filePath);
    cleanupOldDownloads();
    return {
      downloadUrl: buildPublicDownloadUrl(fileNameFull),
      fileName: fileNameFull,
      rows: data.length,
      columns: headers.length,
      fileSize: stats.size,
    };
  } catch (err) {
    return { error: `Failed to generate PDF: ${err.message || 'Unknown error'}` };
  }
}

async function exportData(args) {
  const format = String(args?.format || args?.fileFormat || 'excel').toLowerCase();
  if (format === 'csv') return generateCsv(args);
  if (format === 'pdf') return generatePdf(args);
  return generateExcel(args);
}

// Execute a tool by name
async function executeTool(companyId, toolName, args = {}) {
  switch (toolName) {
    // Company & System
    case 'get_company_info': return getCompanyInfo(companyId);
    case 'get_module_catalog': return getModuleCatalog();
    case 'get_module_records': return getModuleRecords(companyId, args);
    case 'get_dashboard_metrics': return getDashboardMetrics(companyId);
    // Inventory
    case 'get_products': return getProducts(companyId, args);
    case 'get_categories': return getCategories(companyId, args);
    case 'get_warehouses': return getWarehouses(companyId, args);
    case 'get_stock_movements': return getStockMovements(companyId, args);
    case 'get_stock_transfers': return getStockTransfers(companyId, args);
    case 'get_stock_summary': return getStockSummary(companyId);
    case 'get_dead_stock_candidates': return getDeadStockCandidates(companyId, args);
    // Purchasing
    case 'get_purchases': return getPurchases(companyId, args);
    case 'get_purchase_orders': return getPurchaseOrders(companyId, args);
    case 'get_suppliers': return getSuppliers(companyId, args);
    case 'get_goods_received_notes': return getGoodsReceivedNotes(companyId, args);
    // Sales
    case 'get_invoices': return getInvoices(companyId, args);
    case 'get_quotations': return getQuotations(companyId, args);
    case 'get_sales_orders': return getSalesOrders(companyId, args);
    case 'get_delivery_notes': return getDeliveryNotes(companyId, args);
    case 'get_credit_notes': return getCreditNotes(companyId, args);
    case 'get_clients': return getClients(companyId, args);
    case 'get_ar_receipts': return getARReceipts(companyId, args);
    case 'get_receivables_aging': return getReceivablesAging(companyId);
    case 'get_sales_summary': return getSalesSummary(companyId, args);
    case 'get_cash_flow_history': return getCashFlowHistory(companyId, args);
    case 'get_inventory_demand_history': return getInventoryDemandHistory(companyId, args);
    case 'get_receivables_collection_history': return getReceivablesCollectionHistory(companyId, args);
    case 'get_payables_payment_history': return getPayablesPaymentHistory(companyId, args);
    // Finance
    case 'get_expenses': return getExpenses(companyId, args);
    case 'get_bank_accounts': return getBankAccounts(companyId);
    case 'get_chart_of_accounts': return getChartOfAccounts(companyId, args);
    case 'get_journal_entries': return getJournalEntries(companyId, args);
    case 'get_fixed_assets': return getFixedAssets(companyId, args);
    case 'get_loans': return getLoans(companyId, args);
    case 'get_ap_payments': return getAPPayments(companyId, args);
    case 'get_budgets': return getBudgets(companyId, args);
    // Reports
    case 'get_profit_loss_summary': return getProfitLossSummary(companyId, args);
    case 'get_balance_sheet': return getBalanceSheet(companyId, args);
    case 'get_cash_flow_summary': return getCashFlowSummary(companyId, args);
    case 'calculate_financial_ratios': return calculateFinancialRatios(companyId, args);
    case 'forecast_business': return forecastBusiness(companyId, args);
    case 'generate_chart_data': return generateChartData(companyId, args);
    case 'generate_excel': return generateExcel(args);
    case 'export_data': return exportData(args);
    // System & Admin
    case 'get_departments': return getDepartments(companyId, args);
    case 'get_company_users': return getCompanyUsers(companyId, args);
    case 'get_audit_logs': return getAuditLogs(companyId, args);
    case 'get_notifications': return getNotifications(companyId, args);
    default: return { error: `Unknown tool: ${toolName}` };
  }
}

module.exports = {
  TOOL_DEFINITIONS,
  executeTool,
  getDashboardMetrics,
  generateChartData,
  getProfitLossSummary,
  getModuleCatalog,
  getModuleRecords,
  forecastBusiness,
  calculateFinancialRatios,
  getCategories,
  getWarehouses,
  getStockMovements,
  getStockTransfers,
  getDeadStockCandidates,
  getSuppliers,
  getPurchaseOrders,
  getGoodsReceivedNotes,
  getCreditNotes,
  getDeliveryNotes,
  getQuotations,
  getSalesOrders,
  getARReceipts,
  getAPPayments,
  getCashFlowHistory,
  getInventoryDemandHistory,
  getReceivablesCollectionHistory,
  getPayablesPaymentHistory,
  getChartOfAccounts,
  getJournalEntries,
  getBudgets,
  getDepartments,
  getCompanyUsers,
  getAuditLogs,
  getNotifications,
  getBalanceSheet,
  getCashFlowSummary,
  generateExcel,
  generateCsv,
  generatePdf,
  exportData,
};
