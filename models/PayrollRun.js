/**
 * PayrollRun — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  payrollRunToApi,
  payrollRunTranslateCreate,
  payrollRunTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  reference_no: { target: 'referenceNo' },
  pay_period_start: { target: 'payPeriodStart' },
  pay_period_end: { target: 'payPeriodEnd' },
  payment_date: { target: 'paymentDate' },
  status: { target: 'status' },
  bank_account_id: { target: 'bankAccountId', isId: true },
  journal_entry_id: { target: 'journalEntryId', isId: true },
};

module.exports = buildTenantModel({
  name: 'PayrollRun',
  collection: 'payrollruns',
  delegateName: 'payrollRun',
  fieldMap: FIELD_MAP,
  toApi: payrollRunToApi,
  translateCreate: payrollRunTranslateCreate,
  translateUpdate: payrollRunTranslateUpdate,
  mutable: true,
});
