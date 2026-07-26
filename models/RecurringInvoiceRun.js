/**
 * RecurringInvoiceRun — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  recurringInvoiceRunToApi,
  recurringInvoiceRunTranslateCreate,
  recurringInvoiceRunTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  template: { target: 'recurringInvoiceId', isId: true },
  recurringInvoice: { target: 'recurringInvoiceId', isId: true },
  runDate: { target: 'runDate' },
  invoice: { target: 'invoiceId', isId: true },
  status: { target: 'status' },
};

module.exports = buildTenantModel({
  name: 'RecurringInvoiceRun',
  collection: 'recurringinvoiceruns',
  delegateName: 'recurringInvoiceRun',
  fieldMap: FIELD_MAP,
  toApi: recurringInvoiceRunToApi,
  translateCreate: recurringInvoiceRunTranslateCreate,
  translateUpdate: recurringInvoiceRunTranslateUpdate,
  mutable: true,
});
