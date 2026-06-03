const sharedContactFields = [
  { key: 'name', label: 'Name', required: true, section: 'Basic information', example: 'Kigali Fresh Foods Ltd', instructions: 'Registered business or contact name.' },
  { key: 'tin', label: 'TIN', required: false, section: 'Tax', example: '100000003', instructions: '9-digit RRA TIN, no spaces or dashes.' },
  { key: 'email', label: 'Email', required: false, section: 'Contact details', example: 'info@kigalifresh.rw', instructions: 'Valid email address.' },
  { key: 'phone', label: 'Phone', required: false, section: 'Contact details', example: '0788000000', instructions: 'Rwandan phone number, for example 0788000000 or +250788000000.' },
  { key: 'address', label: 'Address', required: false, section: 'Contact details', example: 'KN 4 Ave, Kigali', instructions: 'Street, sector, district, or full postal address.' },
  { key: 'paymentTermsDays', label: 'Payment Terms Days', required: false, section: 'Commercial terms', example: '30', instructions: 'Number of credit days. Use 0 for cash.' },
  { key: 'creditLimit', label: 'Credit Limit', required: false, section: 'Commercial terms', example: '500000', instructions: 'Numbers only, no currency symbol.' },
  { key: 'openingBalance', label: 'Opening Balance', required: false, section: 'Opening balances', example: '120000', instructions: 'Numbers only. Positive amount outstanding at migration date.' }
];

const ENTITY_DEFINITIONS = {
  products: {
    label: 'Products',
    uniqueField: 'sku',
    fields: [
      { key: 'name', label: 'Product Name', required: true, section: 'Basic information', example: 'Inyange Milk 1L', instructions: 'Product or item name.' },
      { key: 'sku', label: 'Code / SKU', required: true, section: 'Basic information', example: 'PRD-001', instructions: 'Unique product code.' },
      { key: 'category', label: 'Category', required: false, section: 'Basic information', example: 'Dairy', instructions: 'Matched by category name. Created as General if omitted.' },
      { key: 'sellingPrice', label: 'Unit Price', required: true, section: 'Pricing', example: '1200', instructions: 'Numbers only, no currency symbol or commas.' },
      { key: 'costPrice', label: 'Cost Price', required: false, section: 'Pricing', example: '950', instructions: 'Numbers only.' },
      { key: 'taxTypeCode', label: 'Tax Type Code', required: true, section: 'Tax and EBM', example: 'B', instructions: 'Enter A (Exempt), B (18% VAT), C (Export), or D (Non-Taxable).' },
      { key: 'itemClassCode', label: 'Item Classification Code', required: true, section: 'Tax and EBM', example: '50202306', instructions: 'RRA EBM item classification code.' },
      { key: 'packagingUnitCode', label: 'Packaging Unit Code', required: true, section: 'Tax and EBM', example: 'NT', instructions: 'RRA EBM packaging unit code.' },
      { key: 'quantityUnitCode', label: 'Quantity Unit Code', required: true, section: 'Tax and EBM', example: 'L', instructions: 'RRA EBM quantity unit code.' },
      { key: 'reorderLevel', label: 'Reorder Level', required: false, section: 'Inventory', example: '20', instructions: 'Minimum stock before reorder.' },
      { key: 'description', label: 'Description', required: false, section: 'Basic information', example: 'Long life milk', instructions: 'Optional product notes.' },
      { key: 'warehouse', label: 'Warehouse', required: false, section: 'Inventory', example: 'Main Warehouse', instructions: 'Matched by warehouse name. Defaults to main warehouse.' },
      { key: 'openingStockQuantity', label: 'Opening Stock Quantity', required: false, section: 'Inventory', example: '100', instructions: 'Opening stock quantity.' },
      { key: 'imageUrl', label: 'Image URL', required: false, section: 'Basic information', example: 'https://example.com/product.jpg', instructions: 'Optional product image URL.' }
    ]
  },
  customers: {
    label: 'Customers',
    uniqueField: 'tin',
    fields: sharedContactFields.map((field) => ({ ...field, label: field.key === 'name' ? 'Customer Name' : field.label }))
  },
  clients: {
    label: 'Customers',
    uniqueField: 'tin',
    aliasOf: 'customers',
    fields: sharedContactFields.map((field) => ({ ...field, label: field.key === 'name' ? 'Customer Name' : field.label }))
  },
  suppliers: {
    label: 'Suppliers',
    uniqueField: 'tin',
    fields: sharedContactFields.map((field) => ({ ...field, label: field.key === 'name' ? 'Supplier Name' : field.label }))
  },
  employees: {
    label: 'Employees',
    uniqueField: 'employeeId',
    fields: [
      { key: 'employeeId', label: 'Employee ID', required: true, section: 'Basic information', example: 'EMP-001', instructions: 'Unique employee code.' },
      { key: 'firstName', label: 'First Name', required: true, section: 'Personal details', example: 'Aline', instructions: 'Employee first name.' },
      { key: 'lastName', label: 'Last Name', required: true, section: 'Personal details', example: 'Uwase', instructions: 'Employee last name.' },
      { key: 'nationalId', label: 'National ID', required: true, section: 'Personal details', example: '1199880012345678', instructions: 'National ID number.' },
      { key: 'email', label: 'Email', required: false, section: 'Contact details', example: 'aline.uwase@example.rw', instructions: 'Valid email address.' },
      { key: 'phone', label: 'Phone', required: false, section: 'Contact details', example: '0788000000', instructions: 'Rwandan phone number.' },
      { key: 'department', label: 'Department', required: false, section: 'Employment', example: 'Finance', instructions: 'Department name.' },
      { key: 'position', label: 'Role / Position', required: false, section: 'Employment', example: 'Accountant', instructions: 'Job title.' },
      { key: 'hireDate', label: 'Hire Date', required: true, section: 'Employment', example: '2026-01-15', instructions: 'Date as YYYY-MM-DD, DD/MM/YYYY, or MM/DD/YYYY.' },
      { key: 'basicSalary', label: 'Basic Salary', required: true, section: 'Payroll', example: '450000', instructions: 'Monthly base salary, numbers only.' },
      { key: 'bankAccount', label: 'Bank Account Number', required: false, section: 'Payroll', example: '000123456789', instructions: 'Optional bank account number.' },
      { key: 'rssbNumber', label: 'RSSB Number', required: false, section: 'Payroll', example: 'RSSB12345', instructions: 'Optional RSSB number.' }
    ]
  },
  chart_of_accounts: {
    label: 'Chart of Accounts',
    uniqueField: 'accountCode',
    fields: [
      { key: 'accountCode', label: 'Account Code', required: true, section: 'Account', example: '1000', instructions: 'Unique account code.' },
      { key: 'accountName', label: 'Account Name', required: true, section: 'Account', example: 'Cash on Hand', instructions: 'Ledger account name.' },
      { key: 'accountType', label: 'Account Type', required: true, section: 'Account', example: 'Asset', instructions: 'Asset, Liability, Equity, Revenue, or Expense.' },
      { key: 'parentAccountCode', label: 'Parent Account Code', required: false, section: 'Hierarchy', example: '100', instructions: 'Existing parent account code.' },
      { key: 'description', label: 'Description', required: false, section: 'Account', example: 'Cash account', instructions: 'Optional account notes.' }
    ]
  },
  opening_gl_balances: {
    label: 'Opening GL Balances',
    uniqueField: null,
    balancedDebitsCredits: true,
    fields: [
      { key: 'accountCode', label: 'Account Code', required: true, section: 'Balance', example: '1000', instructions: 'Must match an existing account.' },
      { key: 'debitBalance', label: 'Debit Balance', required: false, section: 'Balance', example: '500000', instructions: 'Debit amount, numbers only.' },
      { key: 'creditBalance', label: 'Credit Balance', required: false, section: 'Balance', example: '0', instructions: 'Credit amount, numbers only.' },
      { key: 'asOfDate', label: 'As-of Date', required: true, section: 'Balance', example: '2026-01-01', instructions: 'Opening balance date.' }
    ]
  },
  fixed_assets: {
    label: 'Fixed Assets',
    uniqueField: 'assetName',
    fields: [
      { key: 'assetName', label: 'Asset Name', required: true, section: 'Asset', example: 'Toyota Hilux', instructions: 'Asset name.' },
      { key: 'category', label: 'Category', required: true, section: 'Asset', example: 'Vehicles', instructions: 'Asset category.' },
      { key: 'purchaseDate', label: 'Purchase Date', required: true, section: 'Purchase', example: '2025-08-01', instructions: 'Purchase date.' },
      { key: 'cost', label: 'Cost', required: true, section: 'Purchase', example: '18000000', instructions: 'Original asset cost.' },
      { key: 'accumulatedDepreciation', label: 'Accumulated Depreciation', required: true, section: 'Depreciation', example: '1500000', instructions: 'Accumulated depreciation to date.' },
      { key: 'usefulLifeYears', label: 'Useful Life Years', required: true, section: 'Depreciation', example: '5', instructions: 'Useful life in years.' },
      { key: 'depreciationMethod', label: 'Depreciation Method', required: true, section: 'Depreciation', example: 'straight line', instructions: 'Straight line or reducing balance.' },
      { key: 'location', label: 'Location / Warehouse', required: false, section: 'Asset', example: 'Kigali HQ', instructions: 'Optional asset location.' }
    ]
  },
  budget: {
    label: 'Budget',
    uniqueField: null,
    fields: [
      { key: 'accountCode', label: 'Account Code', required: true, section: 'Budget', example: '6100', instructions: 'Existing account code.' },
      { key: 'period', label: 'Period', required: true, section: 'Budget', example: '2026-05', instructions: 'Budget month and year.' },
      { key: 'budgetedAmount', label: 'Budgeted Amount', required: true, section: 'Budget', example: '2500000', instructions: 'Numbers only.' }
    ]
  },
  opening_stock: {
    label: 'Opening Stock',
    uniqueField: null,
    fields: [
      { key: 'productCode', label: 'Product Code', required: true, section: 'Stock', example: 'PRD-001', instructions: 'Must match an existing product SKU.' },
      { key: 'warehouse', label: 'Warehouse', required: true, section: 'Stock', example: 'Main Warehouse', instructions: 'Must match an existing warehouse.' },
      { key: 'quantity', label: 'Quantity', required: true, section: 'Stock', example: '120', instructions: 'Numbers only.' },
      { key: 'costPerUnit', label: 'Cost Per Unit', required: false, section: 'Stock', example: '950', instructions: 'Numbers only.' },
      { key: 'asOfDate', label: 'As-of Date', required: false, section: 'Stock', example: '31/12/2025', instructions: 'Enter the date your business started or your migration date. Format: DD/MM/YYYY. Leave blank to use today.' }
    ]
  },
  opening_ar_balances: {
    label: 'Opening AR Balances',
    uniqueField: null,
    fields: [
      { key: 'customerIdentifier', label: 'Customer Name or TIN', required: true, section: 'Receivable', example: '100000003', instructions: 'Must match an existing customer.' },
      { key: 'invoiceReference', label: 'Invoice Reference', required: false, section: 'Receivable', example: 'INV-OPEN-001', instructions: 'Optional invoice reference.' },
      { key: 'amountOutstanding', label: 'Amount Outstanding', required: true, section: 'Receivable', example: '300000', instructions: 'Numbers only.' },
      { key: 'dueDate', label: 'Due Date', required: false, section: 'Receivable', example: '2026-02-15', instructions: 'Optional due date.' }
    ]
  },
  opening_ap_balances: {
    label: 'Opening AP Balances',
    uniqueField: null,
    fields: [
      { key: 'supplierIdentifier', label: 'Supplier Name or TIN', required: true, section: 'Payable', example: '100000004', instructions: 'Must match an existing supplier.' },
      { key: 'invoiceReference', label: 'Invoice Reference', required: false, section: 'Payable', example: 'BILL-OPEN-001', instructions: 'Optional bill reference.' },
      { key: 'amountOutstanding', label: 'Amount Outstanding', required: true, section: 'Payable', example: '300000', instructions: 'Numbers only.' },
      { key: 'dueDate', label: 'Due Date', required: false, section: 'Payable', example: '2026-02-15', instructions: 'Optional due date.' }
    ]
  }
};

function getEntityDefinition(entityType) {
  const key = String(entityType || '').trim();
  return ENTITY_DEFINITIONS[key] || null;
}

function listEntityDefinitions() {
  return Object.entries(ENTITY_DEFINITIONS).map(([key, value]) => ({
    key,
    label: value.label,
    fields: value.fields
  }));
}

module.exports = {
  ENTITY_DEFINITIONS,
  getEntityDefinition,
  listEntityDefinitions
};
