/**
 * Invoice — PostgreSQL (Prisma) backed.
 * Hottest read path: lines + product loaded via buildLineInclude.
 */

const { buildDocumentModel, buildLineInclude } = require('../utils/salesApCommon');
const {
  invoiceToApi,
  invoiceTranslateCreate,
  invoiceTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  client: { target: 'clientId', isId: true },
  status: { target: 'status' },
  invoiceDate: { target: 'invoiceDate' },
  dueDate: { target: 'dueDate' },
  quotation: { target: 'quotationId', isId: true },
  salesOrder: { target: 'salesOrderId', isId: true },
  totalAmount: { target: 'totalAmount' },
  amountPaid: { target: 'amountPaid' },
  amountOutstanding: { target: 'amountOutstanding' },
  balance: { target: 'amountOutstanding' },
};

module.exports = buildDocumentModel({
  name: 'Invoice',
  collection: 'invoices',
  delegateName: 'invoice',
  fieldMap: FIELD_MAP,
  toApi: invoiceToApi,
  translateCreate: invoiceTranslateCreate,
  translateUpdate: invoiceTranslateUpdate,
  include: buildLineInclude('lines', true),
});
