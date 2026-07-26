/**
 * DeliveryNote — PostgreSQL (Prisma) backed.
 */

const { buildDocumentModel, buildLineInclude } = require('../utils/salesApCommon');
const {
  deliveryNoteToApi,
  deliveryNoteTranslateCreate,
  deliveryNoteTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  client: { target: 'clientId', isId: true },
  salesOrder: { target: 'salesOrderId', isId: true },
  invoice: { target: 'invoiceId', isId: true },
  warehouse: { target: 'warehouseId', isId: true },
  quotation: { target: 'quotationId', isId: true },
  status: { target: 'status' },
  deliveryDate: { target: 'deliveryDate' },
};

module.exports = buildDocumentModel({
  name: 'DeliveryNote',
  collection: 'deliverynotes',
  delegateName: 'deliveryNote',
  fieldMap: FIELD_MAP,
  toApi: deliveryNoteToApi,
  translateCreate: deliveryNoteTranslateCreate,
  translateUpdate: deliveryNoteTranslateUpdate,
  include: buildLineInclude(),
});
