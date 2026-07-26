/**
 * CreditNote — PostgreSQL (Prisma) backed.
 */

const { buildDocumentModel, buildLineInclude } = require('../utils/salesApCommon');
const {
  creditNoteToApi,
  creditNoteTranslateCreate,
  creditNoteTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  invoice: { target: 'invoiceId', isId: true },
  client: { target: 'clientId', isId: true },
  status: { target: 'status' },
  creditDate: { target: 'creditDate' },
};

module.exports = buildDocumentModel({
  name: 'CreditNote',
  collection: 'creditnotes',
  delegateName: 'creditNote',
  fieldMap: FIELD_MAP,
  toApi: creditNoteToApi,
  translateCreate: creditNoteTranslateCreate,
  translateUpdate: creditNoteTranslateUpdate,
  include: buildLineInclude(),
});
