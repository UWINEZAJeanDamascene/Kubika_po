/**
 * Quotation — PostgreSQL (Prisma) backed.
 */

const { buildDocumentModel, buildLineInclude } = require('../utils/salesApCommon');
const {
  quotationToApi,
  quotationTranslateCreate,
  quotationTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  client: { target: 'clientId', isId: true },
  status: { target: 'status' },
  quotationDate: { target: 'quotationDate' },
  expiryDate: { target: 'expiryDate' },
};

module.exports = buildDocumentModel({
  name: 'Quotation',
  collection: 'quotations',
  delegateName: 'quotation',
  fieldMap: FIELD_MAP,
  toApi: quotationToApi,
  translateCreate: quotationTranslateCreate,
  translateUpdate: quotationTranslateUpdate,
  include: buildLineInclude(),
});
