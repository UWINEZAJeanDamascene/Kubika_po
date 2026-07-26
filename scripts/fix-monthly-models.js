const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../services/monthlyReportsService.js');
let content = fs.readFileSync(filePath, 'utf8');

const imports = `const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Purchase = require('../models/Purchase');
const Expense = require('../models/Expense');
const JournalEntry = require('../models/JournalEntry');
const ChartOfAccount = require('../models/ChartOfAccount');
const StockMovement = require('../models/StockMovement');
const Product = require('../models/Product');
const AccountBalance = require('../models/AccountBalance');
const PurchaseOrder = require('../models/PurchaseOrder');
const Supplier = require('../models/Supplier');
const Payroll = require('../models/Payroll');
const PayrollRun = require('../models/PayrollRun');
const Budget = require('../models/Budget');
const Client = require('../models/Client');
const Employee = require('../models/Employee');
const { BankAccount, BankTransaction, BankStatementLine } = require('../models/BankAccount');
const { PettyCashFloat } = require('../models/PettyCash');
const Payslip = Payroll;
`;

content = content.replace(/^const mongoose = require\('mongoose'\);\r?\n/m, imports);

const models = [
  'Invoice', 'Purchase', 'Expense', 'JournalEntry', 'ChartOfAccount', 'StockMovement',
  'BankAccount', 'Product', 'AccountBalance', 'PurchaseOrder', 'Supplier', 'Payroll',
  'BankTransaction', 'BankStatementLine', 'Budget', 'PettyCashFloat', 'PayrollRun',
  'Payslip', 'Employee', 'Client',
];

for (const model of models) {
  const pattern = new RegExp(`mongoose\\.model\\('${model}'\\)`, 'g');
  content = content.replace(pattern, model);
}

content = content.replace(/\n\s*const \[[^\]]+\] = await Promise\.all\(\[\s*(?:\w+,?\s*)+\]\);\s*\n/g, '\n');
content = content.replace(/\n\s*const (\w+) = \1;\s*\n/g, '\n');

fs.writeFileSync(filePath, content);
const remaining = (content.match(/mongoose\.model/g) || []).length;
console.log('Updated monthlyReportsService.js');
console.log('Remaining mongoose.model calls:', remaining);
