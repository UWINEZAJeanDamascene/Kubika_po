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
  pickPack: { target: 'pickPackId', isId: true },
  status: { target: 'status' },
  deliveryDate: { target: 'deliveryDate' },
  confirmedBy: { target: 'confirmedById', isId: true },
  confirmedAt: { target: 'confirmedAt' },
  dispatchedBy: { target: 'dispatchedById', isId: true },
  dispatchedAt: { target: 'dispatchedAt' },
  deliveredBy: { target: 'deliveredBy' },
  deliveredAt: { target: 'deliveredAt' },
  receivedBy: { target: 'receivedBy' },
  actualDeliveryDate: { target: 'actualDeliveryDate' },
  carrier: { target: 'carrier' },
  vehicle: { target: 'vehicle' },
  trackingNumber: { target: 'trackingNumber' },
  deliveryAddress: { target: 'deliveryAddress' },
  cancelledBy: { target: 'cancelledById', isId: true },
  cancelledAt: { target: 'cancelledAt' },
  cancellationReason: { target: 'cancellationReason' },
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
