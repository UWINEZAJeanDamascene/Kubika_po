/**
 * PrepaidExpense model — PostgreSQL (Prisma) backed.
 *
 * Mutable so prepaidExpenseService can keep using `prepaid.save()` while it
 * walks the amortization schedule.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  prepaidExpenseToApi,
  prepaidExpenseTranslateCreate,
  prepaidExpenseTranslateUpdate,
} = require('../utils/deferralMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  vendor: { target: 'vendor' },
  description: { target: 'description' },
  status: { target: 'status' },
  frequency: { target: 'frequency' },
  paymentMethod: { target: 'paymentMethod' },
  expenseAccountCode: { target: 'expenseAccountCode' },
  bankAccountId: { target: 'bankAccountId', isId: true },
  journalEntryId: { target: 'journalEntryId', isId: true },
  startDate: { target: 'startDate' },
  endDate: { target: 'endDate' },
  totalAmount: { target: 'totalAmount' },
  remainingBalance: { target: 'remainingBalance' },
  totalAmortized: { target: 'totalAmortized' },
};

module.exports = buildTenantModel({
  name: 'PrepaidExpense',
  collection: 'prepaidexpenses',
  delegateName: 'prepaidExpense',
  fieldMap: FIELD_MAP,
  toApi: prepaidExpenseToApi,
  translateCreate: prepaidExpenseTranslateCreate,
  translateUpdate: prepaidExpenseTranslateUpdate,
  mutable: true,
});
