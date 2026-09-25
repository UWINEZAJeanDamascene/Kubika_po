'use strict';

const { extractUserPermissions, hasPermission } = require('./permissionUtils');

// Data-reading chat tools are gated using the same permissions as context facts.
// Tools with caller-supplied data only do not expose additional ERP records.
const TOOL_PERMISSIONS = Object.freeze({
  get_company_info: ['company.read', 'settings.read'],
  get_dashboard_metrics: ['reports.read'],
  get_products: ['products.read', 'inventory.read', 'stock.read'],
  get_categories: ['products.read', 'inventory.read'],
  get_warehouses: ['inventory.read', 'warehouses.read', 'stock.read'],
  get_stock_movements: ['inventory.read', 'stock.read'],
  get_stock_transfers: ['inventory.read', 'stock.read'],
  get_stock_summary: ['inventory.read', 'stock.read', 'reports.read'],
  get_inventory_demand_history: ['inventory.read', 'stock.read'],
  get_purchases: ['purchases.read'],
  get_purchase_orders: ['purchases.read'],
  get_suppliers: ['suppliers.read', 'purchases.read'],
  get_goods_received_notes: ['purchases.read'],
  get_invoices: ['invoices.read', 'sales.read'],
  get_quotations: ['invoices.read', 'sales.read'],
  get_sales_orders: ['sales.read', 'invoices.read'],
  get_delivery_notes: ['sales.read', 'invoices.read'],
  get_credit_notes: ['sales.read', 'invoices.read'],
  get_clients: ['clients.read', 'customers.read', 'invoices.read'],
  get_ar_receipts: ['receivables.read', 'invoices.read', 'finance.read'],
  get_receivables_aging: ['receivables.read', 'invoices.read', 'finance.read', 'reports.read'],
  get_receivables_collection_history: ['receivables.read', 'customers.read', 'invoices.read'],
  get_sales_summary: ['sales.read', 'invoices.read', 'reports.read'],
  get_expenses: ['expenses.read', 'finance.read'],
  get_bank_accounts: ['bank_accounts.read', 'finance.read'],
  get_chart_of_accounts: ['accounting.read', 'finance.read'],
  get_journal_entries: ['accounting.read', 'finance.read'],
  get_fixed_assets: ['assets.read', 'finance.read'],
  get_loans: ['finance.read', 'loans.read'],
  get_ap_payments: ['payables.read', 'finance.read', 'purchases.read'],
  get_payables_payment_history: ['payables.read', 'finance.read', 'purchases.read'],
  get_budgets: ['budgets.read', 'finance.read'],
  get_profit_loss_summary: ['reports.read', 'finance.read'],
  get_balance_sheet: ['reports.read', 'finance.read'],
  get_cash_flow_summary: ['reports.read', 'finance.read'],
  get_cash_flow_history: ['reports.read', 'finance.read', 'bank_accounts.read'],
  calculate_financial_ratios: ['reports.read', 'finance.read'],
  forecast_business: ['reports.read', 'finance.read'],
  get_departments: ['employees.read', 'payroll.read'],
  get_company_users: ['users.read'],
  get_audit_logs: ['audit.read'],
  get_notifications: ['notifications.read'],
});

const SAFE_NON_READING_TOOLS = new Set([
  'get_module_catalog',
  'generate_chart_data',
  'generate_excel',
  'export_data',
]);

function toolName(tool) {
  return tool && tool.function && tool.function.name;
}

function allowedToolNames(user) {
  const permissions = extractUserPermissions(user);
  const allowed = new Set(SAFE_NON_READING_TOOLS);
  for (const [name, requiredPermissions] of Object.entries(TOOL_PERMISSIONS)) {
    if (hasPermission(permissions, requiredPermissions)) allowed.add(name);
  }
  // This tool accepts a dynamic module key, so it cannot be safely authorized
  // from its name alone. Specific records remain available through fixed tools.
  if (permissions.includes('*')) allowed.add('get_module_records');
  return allowed;
}

function filterToolsForUser(tools, user) {
  const allowed = allowedToolNames(user);
  return (Array.isArray(tools) ? tools : []).filter((tool) => allowed.has(toolName(tool)));
}

module.exports = {
  TOOL_PERMISSIONS,
  SAFE_NON_READING_TOOLS,
  allowedToolNames,
  filterToolsForUser,
};
