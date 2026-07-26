/**
 * RecurringInvoice — PostgreSQL (Prisma) backed.
 */

const { buildDocumentModel, buildLineInclude } = require('../utils/salesApCommon');
const {
  recurringInvoiceToApi,
  recurringInvoiceTranslateCreate,
  recurringInvoiceTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  client: { target: 'clientId', isId: true },
  status: { target: 'status' },
  startDate: { target: 'startDate' },
  endDate: { target: 'endDate' },
  nextRunDate: { target: 'nextRunDate' },
};

module.exports = buildDocumentModel({
  name: 'RecurringInvoice',
  collection: 'recurringinvoices',
  delegateName: 'recurringInvoice',
  fieldMap: FIELD_MAP,
  toApi: recurringInvoiceToApi,
  translateCreate: recurringInvoiceTranslateCreate,
  translateUpdate: recurringInvoiceTranslateUpdate,
  include: buildLineInclude(),
});
