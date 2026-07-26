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
  const products = await Product.find(q).lean().limit(Number(limit));
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
  const invoices = await Invoice.find(q).sort({ invoiceDate: -1 }).limit(Number(limit)).populate('client', 'name').lean();
  const stats = await Invoice.aggregate([
    { $match: { company: companyId._id || companyId } },
    { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$total' } } },
  ]);
  return {
    count: invoices.length,
    stats: stats.reduce((a, s) => { a[s._id] = { count: s.count, total: s.total }; return a; }, {}),
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
  const purchases = await Purchase.find(q).sort({ createdAt: -1 }).limit(Number(limit)).lean();
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
  const clients = await Client.find(q).limit(Number(limit)).lean();
  const outstanding = await Invoice.aggregate([
    { $match: { company: companyId._id || companyId, status: { $in: ['confirmed', 'partial'] } } },
    { $group: { _id: null, total: { $sum: { $subtract: ['$total', '$amountPaid'] } } } },
  ]);
  return {
    count: clients.length, totalOutstanding: outstanding[0]?.total || 0,
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
  const expenses = await Expense.find(q).sort({ expenseDate: -1 }).limit(Number(limit)).lean();
  const byType = await Expense.aggregate([
    { $match: { company: companyId._id || companyId } },
    { $group: { _id: '$type', total: { $sum: '$amount' } } },
    { $sort: { total: -1 } },
  ]);
  return {
    count: expenses.length,
    byType: byType.map(e => ({ type: e._id || 'Other', total: e.total })),
    expenses: expenses.map(e => ({
      id: e._id.toString(), type: e.type, amount: e.amount || 0,
      status: e.status, date: e.expenseDate ? new Date(e.expenseDate).toISOString().slice(0, 10) : null,
    })),
  };
}

async function getStockSummary(companyId) {
  const products = await Product.find({ company: companyId }).lean();
  const totalValue = products.reduce((s, p) => s + ((p.currentStock || 0) * (p.averageCost || 0)), 0);
  return {
    totalProducts: products.length, totalStockValue: totalValue,
    outOfStockCount: products.filter(p => (p.currentStock || 0) === 0).length,
    lowStockCount: products.filter(p => (p.currentStock || 0) > 0 && (p.currentStock || 0) <= (p.lowStockThreshold || 0)).length,
  };
}

async function getSalesSummary(companyId, opts = {}) {
  const { period = 'month', startDate, endDate } = opts;
  const q = { company: companyId, status: { $in: ['confirmed', 'partial', 'paid'] } };
  const df = dateFilter(startDate, endDate);
  if (df) q.invoiceDate = df;
  const invoices = await Invoice.find(q).lean();
  const totalRevenue = invoices.reduce((s, i) => s + (i.total || 0), 0);
  const totalPaid = invoices.reduce((s, i) => s + (i.amountPaid || 0), 0);

  const grouped = {};
  invoices.forEach(i => {
    const d = i.invoiceDate ? new Date(i.invoiceDate) : new Date();
    let key;
    if (period === 'day') key = d.toISOString().slice(0, 10);
    else if (period === 'week') { const w = new Date(d); w.setDate(w.getDate() - w.getDay()); key = w.toISOString().slice(0, 10); }
    else if (period === 'year') key = `${d.getFullYear()}`;
    else key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!grouped[key]) grouped[key] = { revenue: 0, count: 0 };
    grouped[key].revenue += (i.total || 0); grouped[key].count += 1;
  });

  const timeline = Object.entries(grouped).map(([k, v]) => ({ period: k, ...v })).sort((a, b) => a.period.localeCompare(b.period));

  const productRevenue = {};
  invoices.forEach(i => {
    (i.items || []).forEach(item => {
      const name = item.productName || item.name || 'Unknown';
      productRevenue[name] = (productRevenue[name] || 0) + (item.lineTotal || item.lineSubtotal || 0);
    });
  });
  const topProducts = Object.entries(productRevenue).map(([name, revenue]) => ({ name, revenue })).sort((a, b) => b.revenue - a.revenue).slice(0, 10);

  return { totalInvoices: invoices.length, totalRevenue, totalPaid, totalOutstanding: totalRevenue - totalPaid, collectionRate: totalRevenue ? (totalPaid / totalRevenue) * 100 : 0, timeline, topProducts };
}

async function getReceivablesAging(companyId) {
  const invoices = await Invoice.find({ company: companyId, status: { $in: ['confirmed', 'partial'] } }).populate('client', 'name').lean();
  const now = new Date();
  const buckets = { current: 0, days1_30: 0, days31_60: 0, days61_90: 0, over90: 0 };
  const clientAging = {};

  invoices.forEach(i => {
    const due = i.dueDate ? new Date(i.dueDate) : new Date(i.invoiceDate);
    const diff = Math.floor((now - due) / (1000 * 60 * 60 * 24));
    const outstanding = (i.total || 0) - (i.amountPaid || 0);
    if (diff <= 0) buckets.current += outstanding;
    else if (diff <= 30) buckets.days1_30 += outstanding;
    else if (diff <= 60) buckets.days31_60 += outstanding;
    else if (diff <= 90) buckets.days61_90 += outstanding;
    else buckets.over90 += outstanding;

    const cname = i.client?.name || i.customerName || 'Unknown';
    if (!clientAging[cname]) clientAging[cname] = { total: 0, oldest: 0 };
    clientAging[cname].total += outstanding;
    clientAging[cname].oldest = Math.max(clientAging[cname].oldest, diff);
  });

  const topDebtors = Object.entries(clientAging).map(([name, data]) => ({ name, ...data })).sort((a, b) => b.total - a.total).slice(0, 10);
  return { totalOutstanding: Object.values(buckets).reduce((a, b) => a + b, 0), buckets, topDebtors };
}

async function getBankAccounts(companyId) {
  const accounts = await BankAccount.find({ company: companyId }).lean();
  const totalBalance = accounts.reduce((s, a) => s + (a.currentBalance || a.cachedBalance || 0), 0);
  return {
    count: accounts.length, totalBalance,
    accounts: accounts.map(a => ({
      id: a._id.toString(), name: a.name, type: a.accountType,
      balance: a.currentBalance || a.cachedBalance || 0,
    })),
  };
}

async function getFixedAssets(companyId) {
  const assets = await FixedAsset.find({ company: companyId }).lean();
  const totalCost = assets.reduce((s, a) => s + (a.cost || 0), 0);
  const totalDep = assets.reduce((s, a) => s + (a.accumulatedDepreciation || 0), 0);
  return {
    count: assets.length, totalCost, totalDepreciation: totalDep, netBookValue: totalCost - totalDep,
    assets: assets.map(a => ({
      id: a._id.toString(), name: a.name, cost: a.cost || 0,
      netBookValue: (a.cost || 0) - (a.accumulatedDepreciation || 0),
      status: a.status,
    })),
  };
}

async function getLoans(companyId) {
  const loans = await Loan.find({ company: companyId }).lean();
  const totalOutstanding = loans.reduce((s, l) => s + (l.outstandingBalance || 0), 0);
  return { count: loans.length, totalOutstanding, loans: loans.map(l => ({ id: l._id.toString(), name: l.name, outstandingBalance: l.outstandingBalance || 0, status: l.status })) };
}

async function getDashboardMetrics(companyId) {
  const [company, products, invoices, purchases, expenses, clients, lowStock] = await Promise.all([
    Company.findById(companyId).lean(),
    Product.find({ company: companyId }).lean(),
    Invoice.find({ company: companyId }).sort({ createdAt: -1 }).limit(5).lean(),
    Purchase.find({ company: companyId }).sort({ createdAt: -1 }).limit(5).lean(),
    Expense.find({ company: companyId }).sort({ createdAt: -1 }).limit(5).lean().catch(() => []),
    Client.countDocuments({ company: companyId }).catch(() => 0),
    Product.find({ company: companyId, $expr: { $lte: ['$currentStock', '$lowStockThreshold'] } }).lean().limit(20),
  ]);

  const totalStockValue = products.reduce((s, p) => s + ((p.currentStock || 0) * (p.averageCost || 0)), 0);
  const pendingInvoices = await Invoice.countDocuments({ company: companyId, status: { $in: ['confirmed', 'partial'] } }).catch(() => 0);

  const yearStart = new Date(); yearStart.setMonth(0, 1); yearStart.setHours(0, 0, 0, 0);
  const monthlyRevenue = await Invoice.aggregate([
    { $match: { company: companyId._id || companyId, status: { $in: ['confirmed', 'partial', 'paid'] }, invoiceDate: { $gte: yearStart } } },
    { $group: { _id: { $month: '$invoiceDate' }, revenue: { $sum: '$total' }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  return {
    company: { name: company?.name, currency: company?.settings?.currency || 'FRW' },
    products: { total: products.length, totalValue: totalStockValue, outOfStock: products.filter(p => (p.currentStock || 0) === 0).length, lowStock: lowStock.length },
    sales: { pendingInvoices, monthlyRevenue: monthlyRevenue.map(m => ({ month: m._id, revenue: m.revenue, count: m.count })) },
    clients: { total: clients },
  };
}

async function generateChartData(companyId, opts = {}) {
  const { chartType = 'line', dataType = 'revenue', period = 'month', startDate, endDate, limit = 12 } = opts;
  let labels = [], datasets = [];

  if (dataType === 'revenue') {
    const q = { company: companyId, status: { $in: ['confirmed', 'partial', 'paid'] } };
    const df = dateFilter(startDate, endDate);
    if (df) q.invoiceDate = df;
    const invoices = await Invoice.find(q).lean();
    const grouped = {};
    invoices.forEach(i => {
      const d = i.invoiceDate ? new Date(i.invoiceDate) : new Date();
      let key = period === 'day' ? d.toISOString().slice(0, 10)
        : period === 'year' ? `${d.getFullYear()}`
        : `${d.toLocaleString('en', { month: 'short' })} ${d.getFullYear()}`;
      if (!grouped[key]) grouped[key] = 0;
      grouped[key] += (i.total || 0);
    });
    const sorted = Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0])).slice(-Number(limit));
    labels = sorted.map(([k]) => k);
    datasets = [{ label: 'Revenue', data: sorted.map(([, v]) => v), color: '#6366f1' }];
  }

  if (dataType === 'expenses') {
    const q = { company: companyId };
    const df = dateFilter(startDate, endDate);
    if (df) q.expenseDate = df;
    const expenses = await Expense.find(q).lean();
    const grouped = {};
    expenses.forEach(e => { const t = e.type || 'Other'; grouped[t] = (grouped[t] || 0) + (e.amount || 0); });
    labels = Object.keys(grouped);
    datasets = [{ label: 'Expenses', data: Object.values(grouped), color: '#ef4444' }];
  }

  if (dataType === 'stock') {
    const products = await Product.find({ company: companyId }).sort({ currentStock: -1 }).limit(Number(limit)).lean();
    labels = products.map(p => p.name);
    datasets = [{ label: 'Stock Qty', data: products.map(p => p.currentStock || 0), color: '#10b981' }];
  }

  if (dataType === 'product_revenue') {
    const invoices = await Invoice.find({ company: companyId, status: { $in: ['confirmed', 'partial', 'paid'] } }).lean();
    const prodRev = {};
    invoices.forEach(i => { (i.items || []).forEach(item => { const n = item.productName || item.name || 'Unknown'; prodRev[n] = (prodRev[n] || 0) + (item.total || item.lineTotal || 0); }); });
    const sorted = Object.entries(prodRev).sort((a, b) => b[1] - a[1]).slice(0, Number(limit));
    labels = sorted.map(([k]) => k);
    datasets = [{ label: 'Revenue', data: sorted.map(([, v]) => v), color: '#f59e0b' }];
  }

  return { chartType, dataType, labels, datasets, title: `${dataType.replace('_', ' ')} ${chartType}`, currency: 'FRW' };
}

async function getProfitLossSummary(companyId, opts = {}) {
  const { startDate, endDate } = opts;
  const df = dateFilter(startDate, endDate);
  const iq = { company: companyId, status: { $in: ['confirmed', 'partial', 'paid'] } };
  const eq = { company: companyId };
  if (df) { iq.invoiceDate = df; eq.expenseDate = df; }

  const [invoices, expenses] = await Promise.all([
    Invoice.find(iq).lean(),
    Expense.find(eq).lean(),
  ]);

  const revenue = invoices.reduce((s, i) => s + (i.total || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);

  let cogs = 0;
  invoices.forEach(i => { (i.items || []).forEach(item => { cogs += Number(item.qty || item.quantity || 0) * Number(item.unitCost || item.cogsAmount || 0); }); });
  if (!cogs) cogs = Math.max(0, revenue * 0.6);

  const grossProfit = revenue - cogs;
  const operatingProfit = grossProfit - totalExpenses;
  const tax = Math.max(0, operatingProfit * 0.3);
  const netProfit = operatingProfit - tax;

  return {
    revenue, cogs, grossProfit, operatingExpenses: totalExpenses, operatingProfit,
    tax, netProfit, isProfit: netProfit >= 0, currency: 'FRW',
  };
}

async function getCategories(companyId, opts = {}) {
  opts = opts || {};
  const { search = '', limit = 50 } = opts;
  const q = { company: companyId };
  if (search) q.name = { $regex: search, $options: 'i' };
  const categories = await Category.find(q).limit(Number(limit)).lean();
  return { count: categories.length, categories: categories.map(c => ({ id: c._id, name: c.name, description: c.description })) };
}

async function getWarehouses(companyId, opts = {}) {
  opts = opts || {};
  const warehouses = await Warehouse.find({ company: companyId }).lean();
  return { count: warehouses.length, warehouses: warehouses.map(w => ({ id: w._id, name: w.name, location: w.location, capacity: w.capacity })) };
}

async function getStockMovements(companyId, opts = {}) {
  opts = opts || {};
  const { limit = 20, startDate, endDate } = opts;
  const q = { company: companyId };
  const df = dateFilter(startDate, endDate);
  if (df) q.date = df;
  const movements = await StockMovement.find(q)
    .sort({ date: -1 })
    .limit(Number(limit))
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
    .limit(Number(limit))
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
  const suppliers = await Supplier.find(q).limit(Number(limit)).lean();
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
    .limit(Number(limit))
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
    .limit(Number(limit))
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
    .limit(Number(limit))
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
    .limit(Number(limit))
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
    .limit(Number(limit))
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
    .limit(Number(limit))
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
    .limit(Number(limit))
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
    .limit(Number(limit))
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
  const accounts = await ChartOfAccount.find(q).limit(Number(limit)).lean();
  return { count: accounts.length, accounts: accounts.map(a => ({ id: a._id, code: a.code, name: a.name, type: a.accountType, balance: a.balance })) };
}

async function getJournalEntries(companyId, opts = {}) {
  opts = opts || {};
  const { limit = 20, startDate, endDate } = opts;
  const q = { company: companyId };
  const df = dateFilter(startDate, endDate);
  if (df) q.date = df;
  const entries = await JournalEntry.find(q).sort({ date: -1 }).limit(Number(limit)).lean();
  return { count: entries.length, entries };
}

async function getBudgets(companyId, opts = {}) {
  opts = opts || {};
  const { limit = 20, fiscalYear = '' } = opts;
  const q = { company: companyId };
  if (fiscalYear) q.fiscalYear = fiscalYear;
  const budgets = await Budget.find(q).sort({ createdAt: -1 }).limit(Number(limit)).lean();
  return { count: budgets.length, budgets };
}

async function getDepartments(companyId, opts = {}) {
  opts = opts || {};
  const { search = '', limit = 50 } = opts;
  const q = { company: companyId };
  if (search) q.name = { $regex: search, $options: 'i' };
  const departments = await Department.find(q).limit(Number(limit)).lean();
  return { count: departments.length, departments: departments.map(d => ({ id: d._id, name: d.name, manager: d.manager, budget: d.budget })) };
}

async function getCompanyUsers(companyId, opts = {}) {
  opts = opts || {};
  const { role = '', limit = 50 } = opts;
  const { prisma } = require('../lib/prisma');
  const users = await prisma.user.findMany({
    where: { companyId: String(companyId), ...(role ? { role } : {}) },
    take: Number(limit),
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
  const notifications = await Notification.find(q).sort({ createdAt: -1 }).limit(Number(limit)).lean();
  return { count: notifications.length, notifications: notifications.map(n => ({ id: n._id, title: n.title, message: n.message, read: n.read, type: n.type, createdAt: n.createdAt })) };
}

async function getAuditLogs(companyId, opts = {}) {
  opts = opts || {};
  const { limit = 20, action = '', startDate, endDate } = opts;
  const q = { company: companyId };
  if (action) q.action = action;
  const df = dateFilter(startDate, endDate);
  if (df) q.timestamp = df;
  const logs = await AuditLog.find(q).sort({ timestamp: -1 }).limit(Number(limit)).lean();
  return { count: logs.length, logs: logs.map(l => ({ id: l._id, user: l.userName || l.userEmail, action: l.action, entity: l.entityType, details: l.details, timestamp: l.timestamp })) };
}

async function getBalanceSheet(companyId, opts = {}) {
  opts = opts || {};
  const { asOfDate } = opts;
  const q = { company: companyId };
  const accounts = await ChartOfAccount.find(q).lean();
  const assets = accounts.filter(a => (a.accountType || '').toLowerCase().includes('asset')).reduce((s, a) => s + (a.balance || 0), 0);
  const liabilities = accounts.filter(a => (a.accountType || '').toLowerCase().includes('liabilit')).reduce((s, a) => s + (a.balance || 0), 0);
  const equity = accounts.filter(a => (a.accountType || '').toLowerCase().includes('equity') || (a.accountType || '').toLowerCase().includes('capital')).reduce((s, a) => s + (a.balance || 0), 0);
  return { asOfDate: asOfDate || new Date().toISOString().slice(0, 10), totalAssets: assets, totalLiabilities: liabilities, totalEquity: equity, balanced: Math.abs(assets - liabilities - equity) < 0.01, currency: 'FRW' };
}

async function getCashFlowSummary(companyId, opts = {}) {
  opts = opts || {};
  const { startDate, endDate } = opts;
  const df = dateFilter(startDate, endDate);
  const bq = { company: companyId };
  const jq = { company: companyId };
  if (df) { jq.date = df; }
  const [bankAccounts, journalEntries] = await Promise.all([
    BankAccount.find(bq).lean(),
    JournalEntry.find(jq).lean(),
  ]);
  const bankBalance = bankAccounts.reduce((s, b) => s + (b.currentBalance || 0), 0);
  const cashIn = journalEntries.filter(j => (j.narration || '').toLowerCase().includes('receipt') || (j.type || '').toLowerCase().includes('income')).reduce((s, j) => s + (j.amount || 0), 0);
  const cashOut = journalEntries.filter(j => (j.narration || '').toLowerCase().includes('payment') || (j.type || '').toLowerCase().includes('expense')).reduce((s, j) => s + (j.amount || 0), 0);
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
    // Finance
    case 'get_expenses': return getExpenses(companyId, args);
    case 'get_bank_accounts': return getBankAccounts(companyId);
    case 'get_chart_of_accounts': return getChartOfAccounts(companyId, args);
    case 'get_journal_entries': return getJournalEntries(companyId, args);
    case 'get_fixed_assets': return getFixedAssets(companyId);
    case 'get_loans': return getLoans(companyId);
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
  getSuppliers,
  getPurchaseOrders,
  getGoodsReceivedNotes,
  getCreditNotes,
  getDeliveryNotes,
  getQuotations,
  getSalesOrders,
  getARReceipts,
  getAPPayments,
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
