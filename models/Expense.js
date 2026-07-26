/**
 * Expense model — PostgreSQL (Prisma) backed.
 *
 * Derived fields the legacy Mongoose pre-save hook computed (reference number,
 * period, withholding tax, RWF conversions) are handled by the mappers in
 * utils/phase10Mappers.js (expenseTranslateCreate / expenseDocToUpdate).
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  expenseToApi,
  expenseTranslateCreate,
  expenseTranslateUpdate,
  expenseDocToUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  reference_no: { target: 'referenceNo' },
  expenseNumber: { target: 'expenseNumber' },
  expense_date: { target: 'expenseDate' },
  expenseDate: { target: 'expenseDate' },
  description: { target: 'description' },
  expense_account_id: { target: 'expenseAccountId', isId: true },
  expenseAccountId: { target: 'expenseAccountId', isId: true },
  amount: { target: 'amount' },
  tax_amount: { target: 'taxAmount' },
  total_amount: { target: 'totalAmount' },
  currencyCode: { target: 'currencyCode' },
  exchangeRate: { target: 'exchangeRate' },
  tax_account_id: { target: 'taxAccountId', isId: true },
  payment_method: { target: 'paymentMethod' },
  paymentMethod: { target: 'paymentMethod' },
  bank_account_id: { target: 'bankAccountId', isId: true },
  bankAccountId: { target: 'bankAccountId', isId: true },
  petty_cash_fund_id: { target: 'pettyCashFundId', isId: true },
  rraTaxCategory: { target: 'rraTaxCategory' },
  department_id: { target: 'departmentId', isId: true },
  budget_id: { target: 'budgetId', isId: true },
  budget_line_id: { target: 'budgetLineId', isId: true },
  encumbrance_id: { target: 'encumbranceId', isId: true },
  supplier_id: { target: 'supplierId', isId: true },
  status: { target: 'status' },
  type: { target: 'type' },
  category: { target: 'category' },
  period: { target: 'period' },
  paid: { target: 'paid' },
  paidDate: { target: 'paidDate' },
  withholdingTax: { target: 'withholdingTax' },
  journal_entry_id: { target: 'journalEntryId', isId: true },
  reversal_journal_entry_id: { target: 'reversalJournalEntryId', isId: true },
  posted_by: { target: 'postedById', isId: true },
  approvedBy: { target: 'approvedById', isId: true },
  rejectedBy: { target: 'rejectedById', isId: true },
  isRecurring: { target: 'isRecurring' },
};

module.exports = buildTenantModel({
  name: 'Expense',
  collection: 'expenses',
  delegateName: 'expense',
  fieldMap: FIELD_MAP,
  toApi: expenseToApi,
  translateCreate: expenseTranslateCreate,
  translateUpdate: expenseTranslateUpdate,
  docToUpdate: expenseDocToUpdate,
  mutable: true,
});
