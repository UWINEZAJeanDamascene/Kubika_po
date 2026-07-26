/**
 * SalesOrder — PostgreSQL (Prisma) backed.
 */

const { buildDocumentModel, buildLineInclude } = require('../utils/salesApCommon');
const {
  salesOrderToApi,
  salesOrderTranslateCreate,
  salesOrderTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  client: { target: 'clientId', isId: true },
  quotation: { target: 'quotationId', isId: true },
  status: { target: 'status' },
  orderDate: { target: 'orderDate' },
  expectedDate: { target: 'expectedDate' },
};

const VALID_TRANSITIONS = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['picking', 'cancelled'],
  picking: ['packed', 'cancelled'],
  packed: ['delivered', 'cancelled'],
  delivered: ['invoiced', 'closed'],
  invoiced: ['closed'],
  closed: [],
  cancelled: [],
};

module.exports = buildDocumentModel({
  name: 'SalesOrder',
  collection: 'salesorders',
  delegateName: 'salesOrder',
  fieldMap: FIELD_MAP,
  toApi: salesOrderToApi,
  translateCreate: salesOrderTranslateCreate,
  translateUpdate: salesOrderTranslateUpdate,
  include: buildLineInclude(),
  instanceMethods: {
    canTransitionTo(newStatus) {
      return VALID_TRANSITIONS[this.status]?.includes(newStatus) || false;
    },
    getRemainingQty() {
      return (this.lines || [])
        .map((line) => ({
          lineId: line.lineId,
          product: line.product,
          remainingQty: (line.qty || 0) - (line.qtyDelivered || 0),
        }))
        .filter((item) => item.remainingQty > 0);
    },
    getRemainingQtyToInvoice() {
      return (this.lines || [])
        .map((line) => ({
          lineId: line.lineId,
          product: line.product,
          remainingQty: (line.qtyDelivered || 0) - (line.qtyInvoiced || 0),
        }))
        .filter((item) => item.remainingQty > 0);
    },
  },
});
